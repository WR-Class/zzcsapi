#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/reasoning-only-fallback-e2e.test.js — 「思考吃光预算」必须换下一家（v1.18.28，真起进程，零依赖）
 *
 * 现场证据（诊断开关 dump 出来的真实请求体 + 上游原始 SSE）：
 *   mjiutang 背后的 accounts/fireworks/models/deepseek-v4p1-flash 在 max_tokens=24 下连发 24 帧
 *   delta.reasoning_content，然后 finish_reason=length、**可见正文 0 字节**。客户端看到的是
 *   「空回复 / 回答被截断 / 当前请求的额度已用尽」，而账本（把思考也算进 out）记的是「成功 out=30」——
 *   于是"后台显示成功、客户端却失败"。
 * 本用例守的是：这种发次**判失败并换下一家**（我们有一池子渠道，sub2api 那种分组↔渠道 1:1 换不了）。
 *
 * 覆盖：
 *   ① ★ 思考吃光（reasoning 帧 + finish=length + 可见正文 0）→ 切到 good 拿到正文；bad 记 ok:false + lastError；
 *   ② 对照组 A：思考 + 正文 + finish=stop → **不切**（正常收尾，ok:true，只一条记录）；
 *   ③ 对照组 B：只有工具调用帧 + finish=tool_calls → **不切**（工具调用可以不带正文，绝不能误判）；
 *   ④ 对照组 C：同样形态但客户端只要 max_tokens=8（探测类）→ **不切**（窄判据，不误伤小预算请求）。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/reasoning-only-fallback-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-reasononly-e2e-'));
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

const chunk = (delta, finish) => 'data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta, finish_reason: finish || null }] }) + '\n\n';
const done = 'data: [DONE]\n\n';

/* 假上游：mode 由渠道自定义头 x-mock-mode 控制（bad / good 两家共用） */
const upstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
    const auth = String(req.headers.authorization || '');
    const isBad = auth.includes('sk-bad');
    const mode = req.headers['x-mock-mode'] || (isBad ? 'reason-only' : 'ok');
    if (/models/.test(req.url) && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (mode === 'reason-only') {
      // ★ 现场形态：先一串思考，然后 finish=length，可见正文 0
      let out = chunk({ role: 'assistant' });
      for (let i = 0; i < 24; i++) out += chunk({ reasoning_content: i === 0 ? 'We' : ' think' });
      out += chunk({}, 'length') + done;
      return res.end(out);
    }
    if (mode === 'reason-then-text') {
      let out = chunk({ role: 'assistant' }) + chunk({ reasoning_content: 'let me think' }) + chunk({ content: '甲' });
      out += chunk({}, 'stop') + done;
      return res.end(out);
    }
    if (mode === 'tools-only') {
      let out = chunk({ role: 'assistant' });
      out += chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SH"}' } }] });
      out += chunk({}, 'tool_calls') + done;
      return res.end(out);
    }
    // good / 正常
    res.end(chunk({ role: 'assistant' }) + chunk({ content: '乙' }) + chunk({}, 'stop') + done);
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
const parseStream = async (r) => {
  const raw = await r.text();
  let visible = '', reason = 0, finish = '-';
  for (const ln of raw.split('\n')) {
    if (!ln.startsWith('data:')) continue;
    const p = ln.slice(5).trim(); if (p === '[DONE]') continue;
    try { const j = JSON.parse(p); const c = j.choices && j.choices[0]; if (!c) continue;
      if (c.finish_reason) finish = c.finish_reason;
      const d = c.delta || {};
      if (typeof d.content === 'string') visible += d.content;
      if (typeof d.reasoning_content === 'string') reason++;
    } catch { }
  }
  return { visible, reason, finish };
};

(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const mkCfg = (file, badMode, badMaxTokens) => {
    const p = path.join(TMP, file);
    fs.writeFileSync(p, JSON.stringify({
      port: undefined, health: { intervalSec: 3600, timeoutMs: 3000 },
      channels: [
        { id: 'bad', name: 'bad', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-bad', enabled: true, priority: 10, models: { mock: 'mock' }, headers: { 'x-mock-mode': badMode } },
        { id: 'good', name: 'good', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-good', enabled: true, priority: 5, models: { mock: 'mock' } },
      ],
    }));
    return p;
  };

  /* ══ ① 思考吃光 → 换下一家 ══ */
  {
    const port = await freePort();
    const cfg = mkCfg('a.json', 'reason-only');
    const raw = JSON.parse(fs.readFileSync(cfg, 'utf8')); raw.port = port; fs.writeFileSync(cfg, JSON.stringify(raw));
    const gw = startGateway(cfg, port);
    try {
      check('① 网关启动', await waitUp(port));
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
        body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 1024 }),
      });
      const s = await parseStream(r);
      check('★ 思考吃光 → 换到 good 并拿到可见正文', r.status === 200 && s.visible.includes('乙'), { servedBy: r.headers.get('x-zzcsapi-channel'), ...s });
      check('★ 落在 good 渠道（没有把空回复交给客户端）', r.headers.get('x-zzcsapi-channel') === 'good', { servedBy: r.headers.get('x-zzcsapi-channel') });
      check('客户端拿到的 finish 是 stop（正常收尾）', s.finish === 'stop', { finish: s.finish });
      await sleep(300);
      const u = await (await fetch(`http://127.0.0.1:${port}/admin/api/usage`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).json();
      const badRow = (u.recent || []).find((x) => x.channelId === 'bad');
      check('★ bad 渠道记 ok:false（账本不再把思考当成功）', badRow && badRow.ok === false, { badRow });
      check('★ 失败备注写清是"思考吃光/可见正文 0"', badRow && /reasoning-only/.test(String(badRow.note || '')), { note: badRow && badRow.note });
      check('★ 失败行带上思考量（reason 字段）与模型名', badRow && badRow.reason > 0 && badRow.model === 'mock', { reason: badRow && badRow.reason, model: badRow && badRow.model });
      const st = await (await fetch(`http://127.0.0.1:${port}/admin/api/status`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).json();
      const badCh = (st.channels || []).find((c) => c.id === 'bad');
      check('bad 渠道 lastError 带 reasoning-only', badCh && /reasoning-only/.test(String(badCh.lastError || '')), { lastError: badCh && badCh.lastError });
    } finally { gw.kill('SIGKILL'); }
  }

  /* ══ ② 对照：思考 + 正文 + stop → 不切（正常收尾）══ */
  {
    const port = await freePort();
    const cfg = mkCfg('b.json', 'reason-then-text');
    const raw = JSON.parse(fs.readFileSync(cfg, 'utf8')); raw.port = port; fs.writeFileSync(cfg, JSON.stringify(raw));
    const gw = startGateway(cfg, port);
    try {
      check('② 网关启动', await waitUp(port));
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
        body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 1024 }),
      });
      const s = await parseStream(r);
      check('★ 有思考也有正文 → 不切换（留在 bad，正文=甲）', r.headers.get('x-zzcsapi-channel') === 'bad' && s.visible.includes('甲') && s.reason > 0, { servedBy: r.headers.get('x-zzcsapi-channel'), ...s });
      await sleep(300);
      const u = await (await fetch(`http://127.0.0.1:${port}/admin/api/usage`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).json();
      const rows = (u.recent || []).filter((x) => x.channelId === 'bad');
      check('成功行记 ok:true，且 reason 字段标出思考量（账本诚实）', rows.length === 1 && rows[0].ok === true && rows[0].reason > 0, { rows });
    } finally { gw.kill('SIGKILL'); }
  }

  /* ══ ③ 对照：只有工具调用帧 + finish=tool_calls → 不切（不能误判）══ */
  {
    const port = await freePort();
    const cfg = mkCfg('c.json', 'tools-only');
    const raw = JSON.parse(fs.readFileSync(cfg, 'utf8')); raw.port = port; fs.writeFileSync(cfg, JSON.stringify(raw));
    const gw = startGateway(cfg, port);
    try {
      check('③ 网关启动', await waitUp(port));
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
        body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 1024 }),
      });
      const rawText = await r.text();
      check('★ 工具调用帧不带正文也不算"空回复"（不切换）', r.headers.get('x-zzcsapi-channel') === 'bad' && /tool_calls/.test(rawText), { servedBy: r.headers.get('x-zzcsapi-channel'), hasTools: /tool_calls/.test(rawText) });
    } finally { gw.kill('SIGKILL'); }
  }

  /* ══ ④ 对照：小预算（探测类 max_tokens=8）→ 不切（判据要窄）══ */
  {
    const port = await freePort();
    const cfg = mkCfg('d.json', 'reason-only');
    const raw = JSON.parse(fs.readFileSync(cfg, 'utf8')); raw.port = port; fs.writeFileSync(cfg, JSON.stringify(raw));
    const gw = startGateway(cfg, port);
    try {
      check('④ 网关启动', await waitUp(port));
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
        body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 8 }),
      });
      await r.text();
      check('★ max_tokens=8 的探测类请求不触发切换（留在 bad）', r.headers.get('x-zzcsapi-channel') === 'bad', { servedBy: r.headers.get('x-zzcsapi-channel') });
    } finally { gw.kill('SIGKILL'); }
  }

  upstream.close();
  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exit(fail ? 1 : 0);
})();
