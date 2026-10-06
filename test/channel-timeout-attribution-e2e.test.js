#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/channel-timeout-attribution-e2e.test.js — 挂死渠道要快速换家 + 失败行能归因（v1.18.30，真起进程，零依赖）
 *
 * 现场（用户报「glm-5.3 用不了，等两分钟才失败」）：
 *   某家渠道**完全不出首字节**（挂死），而网关的首字超时给了 90 秒（有其它候选时）、每渠道总超时 120 秒
 *   —— 客户端（DSH 120s）先超时，用户看到的是"等两分钟然后失败"，而不是"自动换了一家成功"。
 * 另一处现场教训：`recordFailure` 记账时不带 `statsCtx`，**失败行永远没有 client 字段**，
 *   导致"测试脚本打出来的失败"和"用户 DSH 的失败"混在一起无法区分（我据此误判过一次）。
 *
 * 覆盖：
 *   ① 渠道挂死 + 渠道级 `firstChunkTimeoutMs: 1000` → 网关 1~3 秒内换到健康家，客户端拿到正文；
 *   ② 挂死那家记 `stream idle` 且 ok:false（账本如实）；
 *   ③ ★ 失败行带 `client` 标签（能归因到客户端）——v1.18.30 前这里是空的；
 *   ④ 结构性守卫：默认首字超时 = 30s（有候选）/60s（末位），默认每渠道总超时 = 90s（防回潮到 90s/300s/120s）。
 *   ⑤（v1.18.46）§E：这两个字段必须**三处一起加**——配了它、保存**任意一个**渠道之后，必须还在
 *     config.json 里；GET 要下发（控制台才能回填）；三态语义（给值/缺省/空串）；非法值 400 且不落库。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/channel-timeout-attribution-e2e.test.js     （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-timeout-e2e-'));
const GW_KEY = 'e2e-gw', AD_KEY = 'e2e-admin';

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

/* 假上游：sk-hang 收到请求后**一个字节都不回**（挂死）；其余正常回一段 SSE */
const upstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
    const auth = String(req.headers.authorization || '');
    if (/models/.test(req.url) && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    }
    if (auth.includes('sk-hang')) return;   // ★ 挂死：不回响应、不断开（首字节永不到）
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { content: '乙' } }] }) + '\n\n'
      + 'data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n'
      + 'data: [DONE]\n\n');
  });
});

function startGateway(cfgPath, port) {
  return spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
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

(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const port = await freePort();
  const cfg = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port, health: { intervalSec: 3600, timeoutMs: 3000 },
    channels: [
      // hang 家优先，且把首字超时压到 1 秒（正是渠道级旋钮要能生效）
      { id: 'hang', name: 'hang', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-hang', enabled: true, priority: 10, models: { mock: 'mock' }, firstChunkTimeoutMs: 1000 },
      { id: 'good', name: 'good', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-good', enabled: true, priority: 5, models: { mock: 'mock' } },
    ],
  }));
  const gw = startGateway(cfg, port);
  try {
    check('网关启动', await waitUp(port));
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY, 'User-Agent': 'e2e-attrib-client' },
      body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 512 }),
    });
    const text = await r.text();
    const cost = Date.now() - t0;
    check('★ 挂死渠道被快速踢掉并换到好家（拿到正文"乙"）', r.status === 200 && text.includes('乙') && r.headers.get('x-zzcsapi-channel') === 'good', { servedBy: r.headers.get('x-zzcsapi-channel'), ms: cost });
    check('★ 换家耗时 < 8 秒（首字超时 1s + 换家开销；旧默认 90s 会拖到客户端超时）', cost < 8000, { ms: cost });

    await sleep(400);
    const u = await (await fetch(`http://127.0.0.1:${port}/admin/api/usage`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).json();
    const hangRow = (u.recent || []).find((x) => x.channelId === 'hang');
    // 两种挂死形态各有各的判据：**连响应头都不回** → `first byte timeout`（v1.18.30 新增的死线，本用例的场景）；
    // **头回了但正文不吐** → `stream idle`（旧的流内空闲判据，仍在）。断言接受两者，并明确要求写清原因。
    check('挂死那家如实记 ok:false + 写清原因（first byte timeout / stream idle）',
      hangRow && hangRow.ok === false && /first byte timeout|stream idle/.test(String(hangRow.note || '')), { hangRow });
    check('★ 失败行带模型名', hangRow && hangRow.model === 'mock', { model: hangRow && hangRow.model });
    check('★★ 失败行带 client 标签（v1.18.30 前这里是空的，害我误归因过）', hangRow && typeof hangRow.client === 'string' && hangRow.client.length > 0, { client: hangRow && hangRow.client });

    // 结构性守卫：默认值不许回潮
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('默认首字超时 = 30s（有候选）/ 60s（末位）', /firstChunkTimeoutMs \|\| \(opts\.hasMoreCandidates \? 30_000 : 60_000\)/.test(src));
    check('默认每渠道总超时 = 90s', /const timeoutMs = ch\.def\.timeoutMs \|\| 90_000;/.test(src));
    check('不再有 90_000 : 300_000 的旧默认', !/hasMoreCandidates \? 90_000 : 300_000/.test(src));

    /* ── §E（v1.18.46）渠道级超时字段必须"三处一起加" ─────────────────────────────
       现场：给"上游挂死/慢"的家配一个小首字死线，好让它**被快速跳过**而不是白等 30~60 秒；
       结果打开渠道顺手一保存，这个配置就从 config.json 里消失了（下次重启悄悄回默认）。
       根因：`firstChunkTimeoutMs` / `timeoutMs` 运行期一直在读，但 persistConfig 的显式字段清单、
       GET /admin/api/channels、POST 的 def 构造**一处都没登记**——与 PT29 / v1.18.33 dropParams /
       v1.18.44 headers 同一族。下面把"配了 → 保存别的渠道 → 还在不在"钉成回归断言。 */
    const cfgNow = () => JSON.parse(fs.readFileSync(cfg, 'utf8'));
    const chanOf = (id) => ((cfgNow().channels) || []).find((c) => c.id === id) || {};
    const api = async (method, p, body) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method, headers: { Authorization: 'Bearer ' + AD_KEY, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let j = null; try { j = await r.json(); } catch { }
      return { status: r.status, json: j };
    };
    const post = (b) => api('POST', '/admin/api/channels', Object.assign(
      { name: 'x', protocol: 'openai', enabled: true, models: { mock: 'mock' } }, b, { baseUrl: chanOf(b.id).baseUrl }));

    check('起点：hang 的 firstChunkTimeoutMs=1000 在磁盘上', chanOf('hang').firstChunkTimeoutMs === 1000, chanOf('hang'));

    const list = await api('GET', '/admin/api/channels');
    const lh = ((list.json && list.json.channels) || []).find((c) => c.id === 'hang') || {};
    check('★ GET 下发已配的值（控制台回填的前提）', lh.firstChunkTimeoutMs === 1000, lh);
    check('★ 没配就不下发该键（与 dropParams 同款：缺省 = 用默认，不是"配了 0"）',
      !('timeoutMs' in lh), Object.keys(lh));

    /* ★★ 本轮 bug 现场：保存**别的**渠道 */
    check('保存别的渠道 → 200', (await post({ id: 'good', name: 'good' })).status === 200);
    check('★★ 保存别的渠道之后，hang 的 firstChunkTimeoutMs 仍在磁盘上',
      chanOf('hang').firstChunkTimeoutMs === 1000, chanOf('hang'));

    /* 三态语义（与 weight/dropParams/headers 同款） */
    check('① 显式给值 = 以本次为准',
      (await post({ id: 'hang', name: 'hang', firstChunkTimeoutMs: 7000, timeoutMs: 45000 })).status === 200
      && chanOf('hang').firstChunkTimeoutMs === 7000 && chanOf('hang').timeoutMs === 45000, chanOf('hang'));
    check('★ ② 字段缺省 = 沿用旧值（缺省 ≠ 清空）',
      (await post({ id: 'hang', name: 'hang' })).status === 200
      && chanOf('hang').firstChunkTimeoutMs === 7000 && chanOf('hang').timeoutMs === 45000, chanOf('hang'));
    check('★ ③ 显式空串 = 清空回默认（键从 config.json 里消失）',
      (await post({ id: 'hang', name: 'hang', firstChunkTimeoutMs: '', timeoutMs: '' })).status === 200
      && chanOf('hang').firstChunkTimeoutMs === undefined && chanOf('hang').timeoutMs === undefined, chanOf('hang'));

    /* 非法值一律 400：这两个值直接进 setTimeout / AbortSignal，静默收下比不收更糟 */
    for (const b of [{ firstChunkTimeoutMs: 0 }, { firstChunkTimeoutMs: -1 }, { timeoutMs: 'abc' }, { timeoutMs: 999 }, { firstChunkTimeoutMs: 999999 }]) {
      const r = await post(Object.assign({ id: 'good', name: 'good' }, b));
      check(`非法值 400 且文案带值域：${JSON.stringify(b)}`,
        r.status === 400 && /必须是 1000~/.test(String((r.json || {}).error || '')), { status: r.status, err: r.json });
    }
    check('★ 400 不落库（非法请求一个字节都不写进配置）',
      chanOf('good').firstChunkTimeoutMs === undefined && chanOf('good').timeoutMs === undefined, chanOf('good'));

    /* 结构守卫：防止下一次加字段又漏掉某一处。两处的代码文本逐字相同，故用**出现次数 = 2** 来钉
       （写成两条同样的正则就是同一条断言跑两遍，等于没测第二处），再用各自的注释文案区分是哪两处。 */
    check('★ persistConfig 与 GET /admin/api/channels 两处都登记了这两个字段',
      (src.match(/firstChunkTimeoutMs: ch\.def\.firstChunkTimeoutMs \|\| undefined,/g) || []).length === 2
      && (src.match(/timeoutMs: ch\.def\.timeoutMs \|\| undefined,/g) || []).length === 2,
      { fc: (src.match(/firstChunkTimeoutMs: ch\.def\.firstChunkTimeoutMs \|\| undefined,/g) || []).length });
    check('★ 两处各自带说明（"三处一起加"与"控制台要回填"），防止后来者以为只有一处',
      /加渠道字段必须三处一起加/.test(src) && /控制台表单要回填它们/.test(src));
    check('★ POST 用 prevDef 兜底（三态语义，不是"没传就抹掉"）',
      /body\.firstChunkTimeoutMs === undefined \? \(prevDef \? prevDef\.firstChunkTimeoutMs/.test(src)
      && /body\.timeoutMs === undefined \? \(prevDef \? prevDef\.timeoutMs/.test(src));
    check('★ 值域只在 CH_MS_FIELDS 一处声明（校验与入库共用）',
      (src.match(/firstChunkTimeoutMs: \{ label:/g) || []).length === 1
      && /for \(const nm of Object\.keys\(CH_MS_FIELDS\)\)/.test(src));
    check('★ `timeoutMs - 20000` 有兜底（下限 1000ms 之后这个减法会走负数）',
      /Math\.max\(5000, timeoutMs - 20000\)/.test(src));
  } finally { gw.kill('SIGKILL'); }
  upstream.close();
  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不用硬 process.exit：避免 Windows libuv 句柄竞态把退出码搞脏
  await sleep(250);
})();
