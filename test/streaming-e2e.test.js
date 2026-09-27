#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/streaming-e2e.test.js — 流式链路端到端回归（真起进程，零依赖）
 *
 * 为什么需要它（v1.2 实测到的 PT26）：
 *   通用读循环把"首块字节"只塞进缓冲区就进 read 循环，下一次 read 若直接结束，
 *   那批字节**永远走不到按行分发**。上游一旦把整个流一次送到（快线路、小回答），
 *   透传路由（/v1/chat/completions 没有 onStreamChunk）就一个字节都不写 ——
 *   客户端拿到 HTTP 200 + text/event-stream 却**空响应体**；三条客户端协议全中招。
 *   再叠加两个独立缺陷：Anthropic 流式转换器"每行新建实例"（tool_use 分片各转各的、
 *   message_start 重复）、Gemini 流式没给出站带 stream（上游回非流式整包）。
 *
 * 覆盖：
 *   · 快上游（一次写完）与慢上游（分片间隔写）两种节奏，三条客户端协议；
 *   · OpenAI 路由的**字节级透传**（客户端收到的 SSE 与上游发出的完全一致）；
 *   · Anthropic 事件序列完整性（message_start 恰好一次、文本块只开一次、收尾齐备）；
 *   · 上游**不发 [DONE]** 时靠收尾钩子兜底；
 *   · Gemini 流式动作必须让上游看到 stream:true。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）；
 *           上游是本地假服务，不出网、不耗额度。
 *
 * 跑法：node test/streaming-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-stream-e2e-'));
const GW_KEY = 'e2e-gw', AD_KEY = 'e2e-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 260) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/* ── 假上游：mode 控制节奏；返回它实际写出的字节，供字节级比对 ── */
let sawStreamFlag = null;
const chunkOf = (text) => 'data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { content: text } }] }) + '\n\n';
const upstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', async () => {
    const b = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}');
    sawStreamFlag = b.stream;
    if (req.method === 'GET' && /models/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    }
    const mode = req.headers['x-mock-mode'] || 'fast';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const parts = [chunkOf('甲'), chunkOf('乙'), chunkOf('丙')];
    if (mode === 'slow') {
      for (const p of parts) { res.write(p); await sleep(40); }
    } else {
      res.write(parts.join(''));   // ★ 整个流一次送到
    }
    if (mode !== 'nodone') res.write('data: [DONE]\n\n');
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
function parseSSE(txt) {
  const out = [];
  for (const block of txt.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block);
    const dt = /^data: (.+)$/m.exec(block);
    if (!ev && !dt) continue;
    let data = null; try { data = JSON.parse(dt ? dt[1] : '{}'); } catch { }
    out.push({ event: ev ? ev[1].trim() : '(data-only)', data });
  }
  return out;
}
async function stream(port, p, body, headers) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const txt = await r.text();
  return { status: r.status, ct: r.headers.get('content-type'), channel: r.headers.get('X-ZZCSAPI-Channel'), txt };
}

(async () => {
  const UP = await freePort(), GW = await freePort();
  await new Promise((r) => upstream.listen(UP, '127.0.0.1', r));
  const cfg = path.join(TMP, 'main.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 1, maxModelFallbacks: 99 },
    channels: [{ id: 'mock-openai', name: 'mock', protocol: 'openai', baseUrl: `http://127.0.0.1:${UP}/v1`, apiKey: 'sk-mock', priority: 1, enabled: true, models: { mock: 'mock' } }],
  }));
  const gw = startGateway(cfg, GW);
  /* 等子进程真正退出再走人：process.exit() 撞上还没关干净的 libuv 句柄，在 Windows 上会
   以 0xC0000409 崩掉——断言全绿却返回失败退出码，把真回归藏在噪声里。 */
const stopChild = (cp) => new Promise((res) => {
  if (!cp || cp.exitCode !== null || cp.signalCode !== null) return res();
  cp.once('exit', () => res());
  try { cp.kill(); } catch { }
  setTimeout(res, 1500);   // 兜底：杀不掉也别把测试挂死
});
const cleanup = () => {
    try { gw.kill(); } catch { }
    try { upstream.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  };

  try {
    if (!await waitUp(GW)) throw new Error('临时网关未起来（端口 ' + GW + '）');
    const OAI = '/v1/chat/completions', ANT = '/anthropic/v1/messages', GEM = '/gemini/v1beta/models/mock:streamGenerateContent';
    const oaiBody = { model: 'mock', stream: true, messages: [{ role: 'user', content: 'hi' }] };
    const antBody = { model: 'mock', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] };
    const gemBody = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

    console.log('\n1. ★ OpenAI 路由 · 快上游（整个流一次到达）→ 必须原样透传');
    let r = await stream(GW, OAI, oaiBody, { Authorization: `Bearer ${GW_KEY}`, 'x-mock-mode': 'fast' });
    const expect = [chunkOf('甲'), chunkOf('乙'), chunkOf('丙'), 'data: [DONE]\n\n'].join('');
    check('HTTP 200 + SSE 内容类型', r.status === 200 && /event-stream/.test(r.ct || ''), r.status + ' ' + r.ct);
    check('★ 响应体非空（整改前这里是 0 字节）', r.txt.length > 0, r.txt.length);
    check('★ 字节级透传：三段增量 + [DONE] 一字不少', r.txt === expect, r.txt.slice(0, 200));
    check('走的是 openai 渠道', r.channel === 'mock-openai', r.channel);

    console.log('\n2. OpenAI 路由 · 慢上游（分片间隔写）→ 不得回归');
    r = await stream(GW, OAI, oaiBody, { Authorization: `Bearer ${GW_KEY}`, 'x-mock-mode': 'slow' });
    check('三段增量 + [DONE] 仍完整', r.txt === expect && r.txt.includes('丙'), r.txt.slice(0, 200));

    console.log('\n3. ★ Anthropic 路由 · 快上游 → 事件序列完整且 message_start 恰好一次');
    r = await stream(GW, ANT, antBody, { 'x-api-key': GW_KEY, 'x-mock-mode': 'fast' });
    let evs = parseSSE(r.txt);
    check('HTTP 200 + SSE', r.status === 200 && /event-stream/.test(r.ct || ''), r.status);
    check('★ message_start 恰好一次（整改前每个上游 chunk 都重发一次）',
      evs.filter((e) => e.event === 'message_start').length === 1, evs.map((e) => e.event));
    check('事件序列以 message_start 开头、message_stop 结尾',
      evs[0].event === 'message_start' && evs[evs.length - 1].event === 'message_stop', evs.map((e) => e.event));
    check('文本块只开一次（有状态转换器）',
      evs.filter((e) => e.event === 'content_block_start' && e.data.content_block.type === 'text').length === 1, evs.map((e) => e.event));
    check('三段增量按序拼成"甲乙丙"',
      evs.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text).join('') === '甲乙丙',
      evs.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text));
    check('stop_reason 正常（end_turn）', evs.find((e) => e.event === 'message_delta').data.delta.stop_reason === 'end_turn');

    console.log('\n4. Anthropic 路由 · 上游不发 [DONE] → 收尾钩子兜底');
    r = await stream(GW, ANT, antBody, { 'x-api-key': GW_KEY, 'x-mock-mode': 'nodone' });
    evs = parseSSE(r.txt);
    check('★ 仍以 message_stop 收尾（不然客户端会一直等）', evs[evs.length - 1].event === 'message_stop', evs.map((e) => e.event));
    check('文本块已关闭', evs.some((e) => e.event === 'content_block_stop'));
    check('文本没丢', evs.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text).join('') === '甲乙丙');

    console.log('\n5. Anthropic 路由 · 慢上游（跨多次 read）→ 状态不丢');
    r = await stream(GW, ANT, antBody, { 'x-api-key': GW_KEY, 'x-mock-mode': 'slow' });
    evs = parseSSE(r.txt);
    check('message_start 仍恰好一次', evs.filter((e) => e.event === 'message_start').length === 1, evs.map((e) => e.event));
    check('文本块仍只开一次且增量完整',
      evs.filter((e) => e.event === 'content_block_start').length === 1 &&
      evs.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text).join('') === '甲乙丙',
      evs.map((e) => e.event));

    console.log('\n6. ★ Gemini 路由 · 流式动作必须让上游看到 stream:true');
    sawStreamFlag = null;
    r = await stream(GW, GEM, gemBody, { 'x-goog-api-key': GW_KEY, 'x-mock-mode': 'fast' });
    check('★ 出站带上了 stream:true（整改前是 undefined → 上游回非流式整包）', sawStreamFlag === true, sawStreamFlag);
    check('客户端收到 Gemini SSE 分片（甲乙丙）',
      r.status === 200 && ["甲", "乙", "丙"].every((t) => r.txt.includes('"text":"' + t + '"')), r.txt.slice(0, 240));
    check('非流式动作仍请求非流式上游',
      await (async () => { sawStreamFlag = null; await stream(GW, '/gemini/v1beta/models/mock:generateContent', gemBody, { 'x-goog-api-key': GW_KEY }); return sawStreamFlag === false; })(), sawStreamFlag);
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await cleanup();
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不 process.exit()：见 stopChild 注释
})();
