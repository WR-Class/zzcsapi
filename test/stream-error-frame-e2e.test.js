#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/stream-error-frame-e2e.test.js — 流内错误帧回归（v1.18.21，真起进程，零依赖）
 *
 * 为什么需要它（用户现场 req_mur6vapv）：
 *   上游（onyxaxis 等 new-api 系中转）对超长上下文回 HTTP 200 的 SSE，但流里只有
 *   role 帧 + data:{"error":{"message":"The input exceeds the supported context size…"}} + [DONE]，
 *   一个正文字节都没有。旧网关的判定是「200 + 流结束 = 成功」：错误帧原样转给客户端
 *   （DSH 报 The server had an error），账本却记 ok:true（66991/0 token），渠道健康也被清零。
 *
 * 覆盖：
 *   · 预检期错误帧（正文未出、响应未提交）→ 取消读取、切下一候选、不记渠道失败；
 *     · 含真机分帧形态：onyxaxis 实测"先单独发 role 帧、隔一会儿才发 error"——role 帧对客户端没有
 *       信息量，预检期只扣着不提交，故错误帧到来时切换窗口仍开着；
 *   · 已提交后的错误帧（正文已流出一部分）→ 如实收尾、ok:false 记账、渠道记失败；
 *   · 非流式直通错误体（200 + {"error":…}）→ 切下一候选，不再记成功；
 *   · 对照组：正常流与正常非流式行为零改动（字节级透传仍成立）。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 *
 * 跑法：node test/stream-error-frame-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-streamerr-e2e-'));
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

const chunk = (text) => 'data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { content: text } }] }) + '\n\n';
const roleChunk = 'data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) + '\n\n';
const errChunk = (msg) => 'data: ' + JSON.stringify({ error: { message: msg, type: 'server_error', code: 'provider_error' } }) + '\n\n';

/* ── 假上游：mode 由网关渠道自定义头 x-mock-mode 控制 ── */
let hits = [];   // {at, ch} 按到达顺序记录哪个渠道挨了哪一发
const upstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
    const auth = String(req.headers.authorization || '');
    const ch = auth.includes('sk-bad') ? 'bad' : 'good';
    const mode = req.headers['x-mock-mode'] || 'ok';
    hits.push({ ch, mode });
    if (/models/.test(req.url) && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    }
    if (mode === 'err-frame-first') {           // 预检期错误帧：role + error + DONE，零正文（一次 write）
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(roleChunk + errChunk('The input exceeds the supported context size. Compact the conversation and retry.') + 'data: [DONE]\n\n');
      return res.end();
    }
    if (mode === 'err-frame-split') {           // ★ 真机分帧（onyxaxis 实测）：role 帧先单独发出去，隔一会儿才发 error
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(roleChunk);
      setTimeout(() => {
        res.write(errChunk('The input exceeds the supported context size. Compact the conversation and retry.') + 'data: [DONE]\n\n');
        res.end();
      }, 60);
      return;
    }
    if (mode === 'err-frame-late') {            // 已提交后错误帧：先出正文再 error + DONE
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(chunk('甲'));
      res.write(errChunk('mid-stream failure'));
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (mode === 'err-body') {                  // 非流式错误体：200 + {"error":…}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'The input exceeds the supported context size.', type: 'server_error' } }));
    }
    if (mode === 'nonstream') {                 // 非流式正常
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: '好的' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    }
    // 正常流
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(chunk('乙'));
    res.write('data: [DONE]\n\n');
    res.end();
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
async function chat(port, body, headers) {
  return await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY, ...headers }, body: JSON.stringify(body),
  });
}
async function usage(port) {
  const r = await fetch(`http://127.0.0.1:${port}/admin/api/usage`, { headers: { Authorization: 'Bearer ' + AD_KEY } });
  return await r.json();
}

async function main() {
  const upPort = await freePort();
  await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

  /* ══ 场景 A：预检期错误帧 → 切下一候选 ══ */
  {
    const gwPort = await freePort();
    const cfgPath = path.join(TMP, 'a.json');
    // 两个渠道同一个上游：bad 用 x-mock-mode: err-frame-first，good 正常；bad 优先级高
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: gwPort, health: { intervalSec: 3600, timeoutMs: 3000 },
      channels: [
        { id: 'bad', name: 'bad', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-bad', enabled: true, priority: 10, models: { mock: 'mock' }, headers: { 'x-mock-mode': 'err-frame-first' } },
        { id: 'good', name: 'good', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-good', enabled: true, priority: 5, models: { mock: 'mock' } },
      ],
    }));
    const gw = startGateway(cfgPath, gwPort);
    try {
      check('A 网关启动', await waitUp(gwPort));
      const r = await chat(gwPort, { model: 'mock', messages: [{ role: 'user', content: 'hi' }], stream: true });
      const text = await r.text();
      check('A 预检期错误帧 → 切到 good，客户端拿到正文（HTTP ' + r.status + '）', r.status === 200 && text.includes('乙'), { servedBy: r.headers.get('x-zzcsapi-channel'), head: text.slice(0, 160) });
      check('A 落在 good 渠道', r.headers.get('x-zzcsapi-channel') === 'good');
      const u = await usage(gwPort);
      const recent = u.recent || [];
      const badOk = recent.some((x) => x.channelId === 'bad' && x.ok === true);
      const badRow = recent.find((x) => x.channelId === 'bad');
      check('A bad 渠道没有"成功"记账（不再谎报）', !badOk, { recent: recent.slice(0, 4) });
      check('A bad 渠道如实记 ok:false', badRow && badRow.ok === false, { badRow });
    } finally { gw.kill('SIGKILL'); }
  }

  /* ══ 场景 A2：真机分帧（role 帧与 error 帧分两次写）→ 仍必须能切下一候选 ══ */
  {
    const gwPort = await freePort();
    const cfgPath = path.join(TMP, 'a2.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: gwPort, health: { intervalSec: 3600, timeoutMs: 3000 },
      channels: [
        { id: 'bad', name: 'bad', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-bad', enabled: true, priority: 10, models: { mock: 'mock' }, headers: { 'x-mock-mode': 'err-frame-split' } },
        { id: 'good', name: 'good', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-good', enabled: true, priority: 5, models: { mock: 'mock' } },
      ],
    }));
    const gw = startGateway(cfgPath, gwPort);
    try {
      check('A2 网关启动', await waitUp(gwPort));
      const r = await chat(gwPort, { model: 'mock', messages: [{ role: 'user', content: 'hi' }], stream: true });
      const text = await r.text();
      check('A2 分帧错误帧仍切到 good（正文出现前的 role 帧不提交响应）', r.status === 200 && text.includes('乙') && !text.includes('exceeds the supported context size'), { servedBy: r.headers.get('x-zzcsapi-channel'), head: text.slice(0, 160) });
      check('A2 落在 good 渠道', r.headers.get('x-zzcsapi-channel') === 'good');
    } finally { gw.kill('SIGKILL'); }
  }

  /* ══ 场景 B：已提交后错误帧 → ok:false + 渠道记失败 ══ */
  {
    const gwPort = await freePort();
    const cfgPath = path.join(TMP, 'b.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: gwPort, health: { intervalSec: 3600, timeoutMs: 3000 },
      channels: [
        { id: 'bad', name: 'bad', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-bad', enabled: true, priority: 10, models: { mock: 'mock' }, headers: { 'x-mock-mode': 'err-frame-late' } },
      ],
    }));
    const gw = startGateway(cfgPath, gwPort);
    try {
      check('B 网关启动', await waitUp(gwPort));
      const r = await chat(gwPort, { model: 'mock', messages: [{ role: 'user', content: 'hi' }], stream: true });
      const text = await r.text();
      check('B 客户端拿到部分正文 + 错误帧（流如实转发）', r.status === 200 && text.includes('甲') && text.includes('mid-stream failure'));
      await sleep(300);
      const u = await usage(gwPort);
      const badRow = (u.recent || []).find((x) => x.channelId === 'bad');
      check('B bad 渠道记 ok:false（账本不再说谎）', badRow && badRow.ok === false, { badRow });
      const st = await (await fetch(`http://127.0.0.1:${gwPort}/admin/api/status`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).json();
      const badCh = (st.channels || []).find((c) => c.id === 'bad');
      check('B bad 渠道 lastError 带 stream error frame', badCh && /stream error frame/.test(String(badCh.lastError || '')), { lastError: badCh && badCh.lastError });
    } finally { gw.kill('SIGKILL'); }
  }

  /* ══ 场景 C：非流式直通错误体 → 切下一候选 ══ */
  {
    const gwPort = await freePort();
    const cfgPath = path.join(TMP, 'c.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: gwPort, health: { intervalSec: 3600, timeoutMs: 3000 },
      channels: [
        { id: 'bad', name: 'bad', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-bad', enabled: true, priority: 10, models: { mock: 'mock' }, headers: { 'x-mock-mode': 'err-body' } },
        { id: 'good', name: 'good', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-good', enabled: true, priority: 5, models: { mock: 'mock' }, headers: { 'x-mock-mode': 'nonstream' } },
      ],
    }));
    const gw = startGateway(cfgPath, gwPort);
    try {
      check('C 网关启动', await waitUp(gwPort));
      const r = await chat(gwPort, { model: 'mock', messages: [{ role: 'user', content: 'hi' }], stream: false });
      const text = await r.text();
      check('C 非流式错误体 → 切到 good 拿到正文', r.status === 200 && text.includes('好的'), { status: r.status, head: text.slice(0, 160) });
      check('C 落在 good 渠道', r.headers.get('x-zzcsapi-channel') === 'good');
    } finally { gw.kill('SIGKILL'); }
  }

  /* ══ 场景 D：对照组——正常流字节级透传不受影响 ══ */
  {
    const gwPort = await freePort();
    const cfgPath = path.join(TMP, 'd.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: gwPort, health: { intervalSec: 3600, timeoutMs: 3000 },
      channels: [
        { id: 'good', name: 'good', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-good', enabled: true, priority: 5, models: { mock: 'mock' } },
      ],
    }));
    const gw = startGateway(cfgPath, gwPort);
    try {
      check('D 网关启动', await waitUp(gwPort));
      const r = await chat(gwPort, { model: 'mock', messages: [{ role: 'user', content: 'hi' }], stream: true });
      const text = await r.text();
      const expect = chunk('乙') + 'data: [DONE]\n\n';
      check('D 正常流逐字节透传（与上游输出完全一致）', text === expect, { got: text.slice(0, 120), want: expect.slice(0, 120) });
      const u = await usage(gwPort);
      const row = (u.recent || []).find((x) => x.channelId === 'good');
      check('D 正常流记 ok:true', row && row.ok === true, { row });
      check('D 只有一条记录（没有多余的失败行）', (u.recent || []).length === 1, { recent: u.recent });
    } finally { gw.kill('SIGKILL'); }
  }

  upstream.close();
  console.log(`\n${'-'.repeat(56)}\n流内错误帧回归：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) { fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); }
  fs.rmSync(TMP, { recursive: true, force: true });
}
main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
