#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/body-dump-diagnostic-e2e.test.js — 请求体落盘诊断（v1.18.27，真起进程，零依赖）
 *
 * 为什么需要它：
 *   现场出现「上游 200 + finish=length + 输出仅 1 个 token」「上游 200 + 空流」两种失败，
 *   而客户端会话日志只有 token 计数、没有真实请求体；请求形态（系统提示 + 工具目录 + 工具调用历史 +
 *   thinking 回放）恰恰是"凭空复现不出来"的那部分——所以要能把**真实的那一发**原样留证。
 *
 * 覆盖（本诊断的每条纪律各一条断言）：
 *   ① 设了 ZZCSAPI_DUMP_BODIES → 客户端会话请求体真落盘，且内容与发出的报文一致；
 *   ② URL 里的 ?key= 必须打码（Gemini SDK 会把网关密钥放查询串），不得把密钥写进 dump；
 *   ③ /admin/ 管理面**绝不落盘**（那里有密钥）——打一发管理面请求，文件数不许变；
 *   ④ 默认关闭：不设环境变量时零落盘（零副作用）；
 *   ⑤ 轮转：只保留最近 ZZCSAPI_DUMP_MAX 个；
 *   ⑥ 落盘失败（目录不可写）不影响请求本身——诊断绝不能把请求搞坏。
 *
 * 安全约束：动态空闲端口；配置/用量/dump 全在系统临时目录（绝不动仓库 config.json/usage.json/dump）。
 *
 * 跑法：node test/body-dump-diagnostic-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-dump-e2e-'));
const GW_KEY = 'e2e-gw', AD_KEY = 'e2e-admin';
const DUMP_DIR = path.join(TMP, 'dump');
const DUMP_DIR2 = path.join(TMP, 'dump-max2');

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/* ── 假上游：正常回一段 SSE ── */
const upstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
    if (/models/.test(req.url) && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    }
    const body = Buffer.concat(cs).toString('utf8');
    // 把收到的请求体回显在响应里，方便断言"上游也收到了同样的形状"（不是本用例重点，但便宜）
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { content: '回显:' + body.length } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

function startGateway(cfgPath, port, extraEnv) {
  return spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage.json'),
      GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1', ...(extraEnv || {}),
    },
    stdio: 'ignore',
  });
}
async function waitUp(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true; } catch { }
    await sleep(200);
  }
  return false;
}
const dumpFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^req-\d+-.*\.json$/.test(f)).sort() : []);
const readDump = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
// 落盘发生在 readBody 的 end 回调里（先于派发），但全量并发跑时 IO 可能被拖后——用轮询代替固定 sleep，
// 避免"机器忙 → 断言早了一拍"这类假失败（本仓库 rate-limit-e2e 也踩过同类并发抖动）。
const waitFor = async (pred, ms = 6000) => { const t0 = Date.now(); for (;;) { if (pred()) return true; if (Date.now() - t0 > ms) return false; await sleep(100); } };

(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  /* ══ 场景 1：开启诊断 → 落盘、内容一致、密钥打码、管理面不落盘 ══ */
  {
    const port = await freePort();
    const cfg = path.join(TMP, 'cfg1.json');
    fs.writeFileSync(cfg, JSON.stringify({
      port, health: { intervalSec: 3600, timeoutMs: 3000 },
      channels: [{ id: 'mockch', name: 'mockch', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-mock', enabled: true, priority: 10, models: { mock: 'mock' } }],
    }));
    const gw = startGateway(cfg, port, { ZZCSAPI_DUMP_BODIES: DUMP_DIR });
    try {
      check('1 网关启动（诊断开启）', await waitUp(port));
      const payload = { model: 'mock', messages: [{ role: 'user', content: '落盘测试-DUMP-OK' }], stream: true };
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY, 'User-Agent': 'e2e-dump-agent' },
        body: JSON.stringify(payload),
      });
      await r.text();
      await waitFor(() => dumpFiles(DUMP_DIR).length >= 1);
      const files = dumpFiles(DUMP_DIR);
      check('★ 客户端会话请求体真落盘（1 个文件）', files.length === 1, { files });
      const rec = files.length ? readDump(DUMP_DIR, files[0]) : {};
      const got = rec.body ? JSON.parse(rec.body) : {};
      check('★ 落盘内容与发出的报文一致（model + messages 原样）',
        got.model === 'mock' && got.messages && got.messages[0] && got.messages[0].content === '落盘测试-DUMP-OK', { model: got.model, content: got.messages && got.messages[0] && got.messages[0].content });
      check('记录的 URL / UA / 字节数可用', rec.url === '/v1/chat/completions' && rec.ua === 'e2e-dump-agent' && rec.bytes > 0, { url: rec.url, ua: rec.ua, bytes: rec.bytes });

      // ?key= 打码：Gemini SDK 的另一种鉴权模式会把网关密钥放查询串
      const before = dumpFiles(DUMP_DIR).length;
      await fetch(`http://127.0.0.1:${port}/v1/chat/completions?key=${GW_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
        body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'x' }] }),
      }).then((x) => x.text());
      await waitFor(() => dumpFiles(DUMP_DIR).length >= before + 1);
      const after = dumpFiles(DUMP_DIR);
      check('带 ?key= 的请求也落盘了（便于对照）', after.length === before + 1, { before, after: after.length });
      const last = readDump(DUMP_DIR, after[after.length - 1]);
      check('★★ URL 里的 ?key= 被打码（密钥绝不进 dump）',
        /key=\*\*\*/.test(last.url) && !String(last.url).includes(GW_KEY) && !JSON.stringify(last).includes(GW_KEY), { url: last.url });

      // 管理面绝不落盘
      const b2 = dumpFiles(DUMP_DIR).length;
      await fetch(`http://127.0.0.1:${port}/admin/api/status`, { headers: { Authorization: 'Bearer ' + AD_KEY } }).then((x) => x.text());
      await fetch(`http://127.0.0.1:${port}/admin/api/usage`, { headers: { Authorization: 'Bearer ' + AD_KEY } }).then((x) => x.text());
      await sleep(300);
      check('★ 管理面请求不落盘（/admin/ 有密钥，绝不许进 dump）', dumpFiles(DUMP_DIR).length === b2, { before: b2, after: dumpFiles(DUMP_DIR).length });
    } finally { gw.kill('SIGKILL'); }
  }

  /* ══ 场景 2：默认关闭 → 零落盘 ══ */
  {
    const port = await freePort();
    const cfg = path.join(TMP, 'cfg2.json');
    const off = path.join(TMP, 'dump-off');
    fs.writeFileSync(cfg, JSON.stringify({
      port, health: { intervalSec: 3600, timeoutMs: 3000 },
      channels: [{ id: 'mockch', name: 'mockch', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-mock', enabled: true, priority: 10, models: { mock: 'mock' } }],
    }));
    const gw = startGateway(cfg, port, {});   // 不设 ZZCSAPI_DUMP_BODIES
    try {
      check('2 网关启动（诊断关闭）', await waitUp(port));
      await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
        body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'y' }] }),
      }).then((x) => x.text());
      await sleep(300);
      check('★ 默认关闭：一个字节都不落盘（零副作用）', dumpFiles(off).length === 0 && !fs.existsSync(off), { exists: fs.existsSync(off) });
    } finally { gw.kill('SIGKILL'); }
  }

  /* ══ 场景 3：轮转只留最近 N 个（DUMP_MAX=2）+ 落盘失败不影响请求 ══ */
  {
    const port = await freePort();
    const cfg = path.join(TMP, 'cfg3.json');
    fs.writeFileSync(cfg, JSON.stringify({
      port, health: { intervalSec: 3600, timeoutMs: 3000 },
      channels: [{ id: 'mockch', name: 'mockch', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-mock', enabled: true, priority: 10, models: { mock: 'mock' } }],
    }));
    const gw = startGateway(cfg, port, { ZZCSAPI_DUMP_BODIES: DUMP_DIR2, ZZCSAPI_DUMP_MAX: '2' });
    try {
      check('3 网关启动（上限 2）', await waitUp(port));
      for (let i = 0; i < 4; i++) {
        await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
          body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'n' + i }] }),
        }).then((x) => x.text());
        await sleep(150);
      }
      await waitFor(() => dumpFiles(DUMP_DIR2).length >= 2);
      await sleep(200);   // 让轮转（删旧）落定
      const files = dumpFiles(DUMP_DIR2);
      check('★ 轮转：4 发请求后只留最近 2 个文件', files.length === 2, { files });
      const newest = files.length ? readDump(DUMP_DIR2, files[files.length - 1]) : {};
      const nb = newest.body ? JSON.parse(newest.body) : {};
      check('留下的是最新的（内容 = 第 4 发）', nb.messages && nb.messages[0] && nb.messages[0].content === 'n3', { content: nb.messages && nb.messages[0] && nb.messages[0].content });
    } finally { gw.kill('SIGKILL'); }
  }

  /* ══ 场景 4：落盘目标不可写 → 请求照常成功（诊断绝不搞坏请求）══ */
  {
    const port = await freePort();
    const cfg = path.join(TMP, 'cfg4.json');
    const bad = path.join(TMP, 'not-a-dir');
    fs.writeFileSync(bad, 'this is a file, not a directory');   // mkdirSync 会失败
    fs.writeFileSync(cfg, JSON.stringify({
      port, health: { intervalSec: 3600, timeoutMs: 3000 },
      channels: [{ id: 'mockch', name: 'mockch', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-mock', enabled: true, priority: 10, models: { mock: 'mock' } }],
    }));
    const gw = startGateway(cfg, port, { ZZCSAPI_DUMP_BODIES: path.join(bad, 'sub') });
    try {
      check('4 网关启动（落盘目标不可写）', await waitUp(port));
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
        body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'z' }], stream: true }),
      });
      const text = await r.text();
      check('★ 落盘失败不影响请求（HTTP 200 且正文照常返回）', r.status === 200 && text.includes('回显:'), { status: r.status, head: text.slice(0, 80) });
    } finally { gw.kill('SIGKILL'); }
  }

  upstream.close();
  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exit(fail ? 1 : 0);
})();
