#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/channel-test-reasoning-e2e.test.js — 手动测试必须为「推理型模型」兜底（v1.18.29，真起进程，零依赖）
 *
 * 现场（用户报「我在咱们站点点击测试都不过」）：
 *   `/admin/api/test` 原本只给 `max_tokens: 16`。deepseek-v4.1-flash 背后是 Fireworks 托管的推理模型，
 *   16 个 token **全被思考吃光** → 上游回 200 + `finish_reason=length` + 可见正文 0 →
 *   控制台按「2xx 但空 = 空回复」判**不过**，可这个渠道其实完全健康（它自己的 new-api 游乐场正常、
 *   我们直连也正常）。
 *
 * 覆盖：
 *   ① 测试请求的预算必须够（`max_tokens` ≥ 256）——小预算正是这个 bug 的根；
 *   ② 只有思考（无可见正文）的家 → 判**可用**：ok:true + `reasoningOnly:true` + reply 带标记；
 *   ③ 正常家 → ok:true、reply="ok"、不带 reasoningOnly；
 *   ④ 真·空回复（200，无正文无思考）→ reply 为空（控制台仍会如实显示"空回复"）；
 *   ⑤ 上游 500 → ok:false 且带回上游原文。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/channel-test-reasoning-e2e.test.js     （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-chtest-e2e-'));
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

/* 假上游：按渠道 apiKey 决定返回哪种形态；把收到的 body 记下来供断言 */
const seen = [];
const upstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
    const auth = String(req.headers.authorization || '');
    const raw = Buffer.concat(cs).toString('utf8');
    if (/models/.test(req.url) && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    }
    let body = {}; try { body = JSON.parse(raw); } catch { }
    seen.push({ auth: auth.replace('Bearer ', ''), max_tokens: body.max_tokens, body });
    const mk = (payload, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (auth.includes('sk-reason')) {
      // ★ 现场形态：token 全花在思考上，可见正文为空
      return mk({ id: 'c', object: 'chat.completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning_content: '让我想想……用户只说了 ok，我应该回 ok。' }, finish_reason: 'length' }], usage: { prompt_tokens: 9, completion_tokens: 16, total_tokens: 25 } });
    }
    if (auth.includes('sk-ash')) {
      // 真·空回复（既无正文也无思考）
      return mk({ id: 'c', object: 'chat.completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 0, total_tokens: 9 } });
    }
    if (auth.includes('sk-boom')) return mk({ error: { message: 'upstream exploded: 503 service unavailable' } }, 503);
    return mk({ id: 'c', object: 'chat.completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } });
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
  const ch = (id, key) => ({ id, name: id, protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: key, enabled: true, priority: 10, models: { mock: 'mock' } });
  fs.writeFileSync(cfg, JSON.stringify({
    port, health: { intervalSec: 3600, timeoutMs: 3000 },
    channels: [ch('reason', 'sk-reason'), ch('ash', 'sk-ash'), ch('boom', 'sk-boom'), ch('good', 'sk-good')],
  }));
  const gw = startGateway(cfg, port);
  const admin = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AD_KEY };
  const runTest = async (channelId) => {
    const r = await fetch(`http://127.0.0.1:${port}/admin/api/test`, { method: 'POST', headers: admin, body: JSON.stringify({ model: 'mock', channelId }) });
    const j = await r.json();
    return (j.results || [])[0] || {};
  };
  try {
    check('网关启动', await waitUp(port));

    const rReason = await runTest('reason');
    const sent = seen.filter((s) => s.auth === 'sk-reason').pop() || {};
    check('★ 测试请求预算够用（max_tokens ≥ 256，不是原来的 16）', Number(sent.max_tokens) >= 256, { sent: sent.max_tokens });
    check('★ 只有思考的家仍判「可用」（ok:true，不再显示不过）', rReason.ok === true, { r: rReason });
    check('★ 标记出「输出仅含思考」（reasoningOnly + reply 带提示）', rReason.reasoningOnly === true && /仅含思考/.test(String(rReason.reply || '')), { reply: rReason.reply, reasoningOnly: rReason.reasoningOnly });

    const rGood = await runTest('good');
    check('正常家：ok:true 且 reply="ok"', rGood.ok === true && rGood.reply === 'ok', { r: rGood });
    check('正常家不带 reasoningOnly 标记', !rGood.reasoningOnly, { r: rGood });

    const rAsh = await runTest('ash');
    check('真·空回复：reply 为空（控制台仍会如实显示「空回复」）', rAsh.ok === true && !rAsh.reply && !rAsh.reasoningOnly, { r: rAsh });

    const rBoom = await runTest('boom');
    check('上游 500：ok:false 且带回上游原文', rBoom.ok === false && rBoom.status === 503 && /exploded/.test(String(rBoom.error || '')), { r: rBoom });
  } finally { gw.kill('SIGKILL'); }
  upstream.close();
  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  // 收尾纪律：不用硬 process.exit——kill 子进程与 close 假上游会和 Windows 上的 libuv 句柄关闭竞态，
  // 撞 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" 而让退出码变成 0xC0000409，
  // 全套件就会把一个全过的用例报成失败。改为先让句柄落定，再按 exitCode 自然退出。
  process.exitCode = fail ? 1 : 0;
  await sleep(250);
})();
