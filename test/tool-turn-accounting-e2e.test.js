#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/tool-turn-accounting-e2e.test.js — 工具轮不许被记成"零产出的成功"（v1.18.35，真起进程，零依赖）
 *
 * 现场（查「196 行 ok:true / out=0」到底是空回复还是记账口径时，用留证开关抓到 DSH 真实报文）：
 *   把留证里的真实报文**逐字节回放**给本地网关 → 每发都是 `finish_reason=tool_calls`、
 *   52 个 SSE 帧里 49 个是 `tool_calls`、可见正文 0 字符 —— **客户端拿到的是完整的工具调用**，
 *   而账本记成 `ok:true out=0`，看起来像"成功但什么都没产出"（我据此误判成"35% 的调用返回空回复"）。
 *   两个成因都在**常规链路**（openai 渠道 → openai 客户端）的记账侧：
 *     ① 上游自报的 usage 帧被整帧丢掉（`passthroughUsage` 只在直通路径扫，`nativeStreamUsageScan`
 *        只认 anthropic/gemini）→ `in` 永远是我们自己的估算、`out` 只数可见正文；
 *        回放那一发上游明明自报 `prompt_tokens: 176351 / completion_tokens: 114`，账本记 `in=56324 out=0`。
 *     ② 纯工具轮没有可见正文 → `out = estimateTokens(streamOutText) = 0`。
 *
 * 覆盖：
 *   ① 纯函数真值表：`sseToolCallText`（工具帧的 name+arguments 也算输出）与 `openaiUsageFromFrame`
 *      （usage 帧归一、全 0 空帧不覆盖累计、思考 token 带上）；
 *   ② 真链路 ★：纯工具轮 + 上游自报 usage → 账本 `in/out` 取**上游真实值**（不是估算、更不是 0）；
 *   ③ 真链路 ★：纯工具轮 + **没有** usage 帧 → `out > 0`（旧写法是 0）；
 *   ④ 真链路：纯工具轮在账本上留 `tool_calls` 标记（分得清"客户端拿到工具调用"与"什么都没拿到"）；
 *   ⑤ 对照组：文本轮的记账口径没被改坏（有 usage 帧 → 上游自报优先；没有 → 仍是估算）；
 *   ⑥ 真链路：上游自报的思考 token 记进 `reason`，且**不许超过 out**；
 *   ⑦ 结构性守卫：usage 帧必须在 `noteStreamLine` 的 `if (sawStreamContent) return` 早退**之前**抓
 *      （上游常把 usage 放在最后一个 chunk，早退就整帧丢了）、旧的 `estimateTokens(streamOutText)` 记账已清零。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/tool-turn-accounting-e2e.test.js     （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-toolturn-e2e-'));
const GW_KEY = 'e2e-gw', AD_KEY = 'e2e-admin';
const USAGE = path.join(TMP, 'usage.json');

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
// 从 server.js 现抠一个函数体（与其它用例同一套纪律：跑真源码，不抄一份）
function extract(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('extract: 找不到 ' + name);
  let d = 0, j = SRC.indexOf('{', i);
  for (let k = j; k < SRC.length; k++) {
    if (SRC[k] === '{') d++;
    else if (SRC[k] === '}') { d--; if (!d) return SRC.slice(i, k + 1); }
  }
  throw new Error('extract: ' + name + ' 括号不配对');
}
// 抠某个顶层 const 到下一个顶层声明之间的片段（做结构/顺序守卫用）
const sliceFrom = (marker, len = 2600) => {
  const i = SRC.indexOf(marker);
  return i < 0 ? '' : SRC.slice(i, i + len);
};

/* ── 假上游：按请求的模型名选形态（工具轮 / 文本轮 / 思考轮 × 有无 usage 帧）── */
const SSE_CHUNK = (delta, finish) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'up', choices: [{ index: 0, delta, finish_reason: finish || null }] })}\n\n`;
const USAGE_FRAME = (u) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'up', choices: [], usage: u })}\n\n`;
const TOOL_DELTA = { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"server.js"}' } }] };
const sse = (mode) => {
  let s = SSE_CHUNK({ role: 'assistant' });
  if (mode.startsWith('tools')) s += SSE_CHUNK(TOOL_DELTA);
  else if (mode.startsWith('reason')) s += SSE_CHUNK({ reasoning_content: '让我想想这个问题的边界条件。' });
  else s += SSE_CHUNK({ content: '你好，这是正文。' });
  s += SSE_CHUNK({}, mode.startsWith('tools') ? 'tool_calls' : 'stop');
  if (mode.endsWith('-u')) {
    s += mode.startsWith('reason')
      ? USAGE_FRAME({ prompt_tokens: 10, completion_tokens: 9, total_tokens: 19, completion_tokens_details: { reasoning_tokens: 7 } })
      : USAGE_FRAME({ prompt_tokens: 176351, completion_tokens: 114, total_tokens: 176465, completion_tokens_details: { reasoning_tokens: 0 } });
  }
  return s + 'data: [DONE]\n\n';
};
const upstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
    if (req.method === 'GET' && /models/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'up' }] }));
    }
    let body = null; try { body = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch { }
    const mode = String((body && body.model) || '').replace(/^up-/, '');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.end(sse(mode));
  });
});

function startGateway(cfgPath, port) {
  return spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: USAGE, GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
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
const readRows = () => { try { return JSON.parse(fs.readFileSync(USAGE, 'utf8')).recent || []; } catch { return []; } };
async function waitRows(n, ms = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (readRows().length >= n) return readRows(); await sleep(200); }
  return readRows();
}

(async () => {
  /* ══════════ 1. 两个新函数的真值表（现抠真源码） ══════════ */
  console.log('\n1. sseToolCallText / openaiUsageFromFrame（现抠真源码）');
  const sseToolCallText = new Function(extract('sseToolCallText') + '\nreturn sseToolCallText;')();
  const openaiUsageFromFrame = new Function(extract('openaiUsageFromFrame') + '\nreturn openaiUsageFromFrame;')();
  const toolLine = 'data: ' + JSON.stringify({ choices: [{ delta: TOOL_DELTA }] });
  check('工具帧 → 取到 name + arguments（工具轮也算输出）', sseToolCallText(toolLine) === 'read_file{"path":"server.js"}', sseToolCallText(toolLine));
  const shardLine = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] });
  check('arguments 分片照样累计（上游按 token 切片发送）', sseToolCallText(shardLine) === '{"a":');
  check('非 data 行 / 空行 / [DONE] → 空串', sseToolCallText('event: x') === '' && sseToolCallText('data: ') === '' && sseToolCallText('data: [DONE]') === '');
  check('没有 tool_calls 的正文帧 → 空串（不会把正文重复计一遍）', sseToolCallText('data: ' + JSON.stringify({ choices: [{ delta: { content: '正文' } }] }) ) === '');
  check('半截 JSON → 空串（不误判）', sseToolCallText('data: {"choices":[{"delta":{"tool_calls"') === '');

  const uFull = openaiUsageFromFrame({ usage: { prompt_tokens: 176351, completion_tokens: 114, total_tokens: 176465 } });
  check('usage 帧 → 归一成内部字段', uFull && uFull.prompt_tokens === 176351 && uFull.completion_tokens === 114 && uFull.total_tokens === 176465, uFull);
  const uReason = openaiUsageFromFrame({ usage: { prompt_tokens: 10, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 7 } } });
  check('上游自报的思考 token 带上（reason 用真数字而不是估算）', uReason && uReason.reasoning_tokens === 7, uReason);
  check('没有 total_tokens → 自己加（不写 undefined）', openaiUsageFromFrame({ usage: { prompt_tokens: 3, completion_tokens: 4 } }).total_tokens === 7);
  check('全 0 的空帧 → null（不覆盖已有累计）', openaiUsageFromFrame({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) === null);
  check('无 usage / 非对象 → null', openaiUsageFromFrame({ choices: [] }) === null && openaiUsageFromFrame(null) === null);
  check('只有 prompt_tokens 的帧也认（out 仍走估算兜底）', (openaiUsageFromFrame({ usage: { prompt_tokens: 99, completion_tokens: 0 } }) || {}).prompt_tokens === 99);

  /* ══════════ 2. 真链路：工具轮的 in/out 取上游真实值 ══════════ */
  console.log('\n2. 真链路（openai 客户端 → openai 渠道，流式）');
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const port = await freePort();
  const cfg = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port, health: { intervalSec: 3600, timeoutMs: 3000 },
    channels: [{
      id: 'oa', name: 'oa', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}`, apiKey: 'sk-oa', enabled: true, priority: 10,
      models: { 'm-tools-u': 'up-tools-u', 'm-tools-n': 'up-tools-n', 'm-text-u': 'up-text-u', 'm-text-n': 'up-text-n', 'm-reason-u': 'up-reason-u' },
    }],
  }));
  const gw = startGateway(cfg, port);
  const ask = async (model) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY, 'User-Agent': 'e2e-toolturn-client' },
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    return { status: r.status, text: await r.text() };
  };
  try {
    check('网关启动', await waitUp(port));

    // ★ 主用例 A：纯工具轮 + 上游自报 usage（留证回放那一发的形状）
    const a = await ask('m-tools-u');
    check('A 纯工具轮请求成功', a.status === 200, a.status);
    check('A 客户端真拿到工具调用帧（不是空回复）', /tool_calls/.test(a.text) && /read_file/.test(a.text));
    let rows = await waitRows(1);
    const rowA = rows.find((r) => r.model === 'm-tools-u');
    check('A 账本有一行', !!rowA, rows.length);
    check('★ A in 取上游自报的 176351（旧写法是估算 56324 那种量级）', rowA && rowA.in === 176351, rowA && rowA.in);
    check('★ A out 取上游自报的 114（旧写法是 0）', rowA && rowA.out === 114, rowA && rowA.out);
    check('★ A 纯工具轮留 tool_calls 标记（分得清"拿到工具调用"与"什么都没拿到"）', rowA && rowA.note === 'tool_calls', rowA && rowA.note);
    check('A 上游报 reasoning_tokens=0 且无思考帧 → 不写 reason 字段', rowA && rowA.reason === undefined, rowA && rowA.reason);

    // ★ 主用例 B：纯工具轮 + **没有** usage 帧 → 兜底也不许是 0
    const b = await ask('m-tools-n');
    check('B 纯工具轮请求成功', b.status === 200, b.status);
    rows = await waitRows(2);
    const rowB = rows.find((r) => r.model === 'm-tools-n');
    check('★ B 没有 usage 帧时 out > 0（旧写法按可见正文估算 = 0，账本显示成"零产出的成功"）', rowB && rowB.out > 0, rowB && rowB.out);
    check('B 仍然是 ok:true（工具轮是正常回合，不许记失败）', rowB && rowB.ok === true, rowB && rowB.ok);
    check('B 也带 tool_calls 标记', rowB && rowB.note === 'tool_calls', rowB && rowB.note);

    // 对照组 C：文本轮 + usage 帧 → 上游自报优先
    const c = await ask('m-text-u');
    check('C 文本轮请求成功', c.status === 200, c.status);
    rows = await waitRows(3);
    const rowC = rows.find((r) => r.model === 'm-text-u');
    check('C 文本轮 out 取上游自报的 114（usage 优先于估算）', rowC && rowC.out === 114, rowC && rowC.out);
    check('C 文本轮 in 取上游自报的 176351', rowC && rowC.in === 176351, rowC && rowC.in);
    check('C 文本轮不带 tool_calls 标记（标记只给纯工具轮）', rowC && rowC.note === undefined, rowC && rowC.note);

    // 对照组 D：文本轮 + 没有 usage 帧 → 仍是估算（老行为不变）
    const d = await ask('m-text-n');
    check('D 文本轮请求成功', d.status === 200, d.status);
    rows = await waitRows(4);
    const rowD = rows.find((r) => r.model === 'm-text-n');
    check('D 没有 usage 帧 → out 仍是估算（> 0）', rowD && rowD.out > 0, rowD && rowD.out);
    check('D 没有 usage 帧 → in 仍是估算（> 0，且远小于上游那种 176351）', rowD && rowD.in > 0 && rowD.in < 1000, rowD && rowD.in);

    // 对照组 E：思考轮 + 上游自报 reasoning_tokens → reason 用真数字且不超过 out
    const e = await ask('m-reason-u');
    check('E 思考轮请求成功', e.status === 200, e.status);
    rows = await waitRows(5);
    const rowE = rows.find((r) => r.model === 'm-reason-u');
    check('★ E 上游自报的思考 token 记进 reason（7，不是按字符估算）', rowE && rowE.reason === 7, rowE && rowE.reason);
    check('★ E reason 不许超过 out（思考是 out 的一部分）', rowE && rowE.reason <= rowE.out, rowE && { out: rowE.out, reason: rowE.reason });
  } finally { gw.kill('SIGKILL'); }
  upstream.close();

  /* ══════════ 3. 结构性守卫：别再冒出"只数可见正文"的记账 ══════════ */
  console.log('\n3. 结构性守卫（防回潮）');
  check('sseToolCallText / openaiUsageFromFrame 已定义', /function sseToolCallText\(line\) \{/.test(SRC) && /function openaiUsageFromFrame\(j\) \{/.test(SRC));
  check('handleLine 累计工具调用文本（常规链路）', sliceFrom('const handleLine = (line) => {').includes('streamToolText += sseToolCallText(line)'));
  const noteFn = sliceFrom('const noteStreamLine = (line) => {', 3200);
  // v1.18.40：帧分类统一收进 `classifyStreamFrame`（真实链路与手动测试的流式模式**共用同一份**），
  // 所以这里断言的是"noteStreamLine 一律走分类结果、且不再有能吞掉收尾帧的分支"，而不是旧的直呼
  // `openaiUsageFromFrame`。旧的 `if (sawStreamContent) return;` 只是"见过正文就别再扫了"的省算，
  // 现在分类是纯函数调用、每次都跑，这条早退连同它可能吞掉收尾帧的风险一起消失（语义等价且更强）。
  check('★ 帧事实一律走 `classifyStreamFrame`，且 `noteStreamLine` 里已无"见过正文就早退"的分支（收尾帧不会整帧丢掉）',
    noteFn.includes('const f = classifyStreamFrame(j);')
    && !/if \(sawStreamContent\) return;/.test(noteFn)
    && ['f.usage', 'f.finish', 'f.visibleText', 'f.reasoning', 'f.toolCall'].every((k) => noteFn.includes(k)));
  check('★ usage 的解析只有一处（`classifyStreamFrame` 里调 `openaiUsageFromFrame`，全仓无第二份调用）',
    (SRC.match(/openaiUsageFromFrame\(j\);/g) || []).length === 1
    && /function classifyStreamFrame\(j\) \{[\s\S]{0,2400}?openaiUsageFromFrame\(j\)/.test(SRC));
  check('成功记账用 streamUsage || passthroughUsage（两条路径同一个口径）', /const usageOut = streamUsage \|\| passthroughUsage;/.test(SRC));
  check('out 的兜底把工具调用算进去（streamOutText + streamToolText）', /const outTok = reportedOut \|\| estimateTokens\(streamOutText \+ streamToolText\);/.test(SRC));
  check('★ 旧的"只按可见正文记账"已清零（outputTokens: estimateTokens(streamOutText), ok: true）', !/outputTokens: estimateTokens\(streamOutText\), ok: true/.test(SRC));
  check('直通路径也累计思考占比（reason 在两条路径上都如实）', sliceFrom('const passthroughWrite = (u8) => {').includes('streamReasonText += sseDeltaSplit(line).reason'));

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不用硬 process.exit：避免 Windows libuv 句柄竞态把退出码搞脏
  await sleep(250);
})();
