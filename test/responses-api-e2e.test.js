#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/responses-api-e2e.test.js — OpenAI Responses API（/v1/responses，v1.18.38）回归
 *
 * 为什么需要它：
 *   `/v1/responses` 以前被塞进 handleOpenAIRequest 的 POST 白名单里——那个处理器按
 *   `body.messages` 找对话，而 Responses 客户端发的是 `body.input`，于是要么 404 无渠道、
 *   要么把 Responses 报文原样转发给 chat 上游。这个面**必须**做入站转换（input→messages）
 *   与出站转换（chat.completion→response 对象 / SSE 事件序列），两边都得有守卫。
 *
 * 两段：
 *   §1 单元级——从 server.js 现抠真实函数源码（不是副本），验证转换的形态与有损点；
 *   §2 端到端——真起「假上游 + 临时网关实例」，走完整 HTTP 链路验证字节、事件序列、
 *      取回/删除、记账 kind，以及"chat 面没有回归"的对照。
 *
 * 安全约束：动态空闲端口；配置/用量写到系统临时目录（ZZCSAPI_CONFIG / ZZCSAPI_USAGE），
 *          绝不读写仓库里的 config.json / usage.json；上游是本地假服务，不出网。
 *
 * 跑法：node test/responses-api-e2e.test.js     （零依赖，退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-resp-'));
const GW_KEY = 'e2e-gw', AD_KEY = 'e2e-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 260) : '')); }
};
const G = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/* ── 抠函数：按花括号配对（与 test/gemini-multimodal.test.js 同一套写法） ── */
function extract(name) {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('server.js 里找不到函数 ' + name + '（改名了？请同步本脚本与文档）');
  if (src.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
  let depth = 0, started = false;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('花括号不配对：' + name);
}

let api;
try {
  const body = [
    'const RESP_TTL_MS = 3600_000; const RESP_MAX = 200; const RESP_STORE = new Map();',
    extract('respId'), extract('respPrune'), extract('respStore'),
    extract('respContentToOpenAI'), extract('respToolsToOpenAI'), extract('respToolChoiceToOpenAI'),
    extract('responsesToOpenAI'), extract('respUsageOut'), extract('openAIToResponsesResponse'),
    extract('respSSE'), extract('createResponsesStreamConverter'),
    'return { respId, respPrune, respStore, respContentToOpenAI, respToolsToOpenAI, respToolChoiceToOpenAI, responsesToOpenAI, respUsageOut, openAIToResponsesResponse, respSSE, createResponsesStreamConverter, RESP_STORE, RESP_TTL_MS, RESP_MAX };',
  ].join('\n');
  api = new Function('crypto', body)(require('crypto'));
} catch (e) {
  console.error('✗ 装配失败：' + e.message);
  process.exit(1);
}
const CTX = (over = {}) => Object.assign({
  id: 'resp_test', createdAt: 1700000000, model: 'mock-responses', instructions: null,
  maxOutputTokens: null, metadata: {}, tools: [], toolChoice: 'auto', temperature: null,
  topP: null, reasoning: null, store: true,
}, over);

/* ═══════ §1 单元级：入站转换 ═══════ */
G('1. responsesToOpenAI：入站转换');
{
  const a = api.responsesToOpenAI({ model: 'm', input: 'hello' });
  check('字符串 input → 一条 user 消息', JSON.stringify(a.messages) === JSON.stringify([{ role: 'user', content: 'hello' }]), a.messages);

  const b = api.responsesToOpenAI({ model: 'm', instructions: 'be brief', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] });
  check('instructions → system 在最前', b.messages[0].role === 'system' && b.messages[0].content === 'be brief', b.messages);
  check('input_text 数组 → 纯文本字符串（不变形态）', b.messages[1].content === 'hi', b.messages[1]);

  const c = api.responsesToOpenAI({ model: 'm', input: [{ role: 'developer', content: 'dev rules' }, { role: 'user', content: 'x' }] });
  check('developer 角色 → system', c.messages[0].role === 'system' && c.messages[0].content === 'dev rules', c.messages);

  const d = api.responsesToOpenAI({ model: 'm', input: [
    { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"bj"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '{"t":1}' },
  ] });
  check('function_call → assistant.tool_calls（配对 id）', d.messages[0].role === 'assistant' && d.messages[0].tool_calls[0].id === 'call_1' && d.messages[0].tool_calls[0].function.name === 'get_weather', d.messages[0]);
  check('function_call_output → role:tool（tool_call_id 配对）', d.messages[1].role === 'tool' && d.messages[1].tool_call_id === 'call_1' && d.messages[1].content === '{"t":1}', d.messages[1]);

  const e = api.responsesToOpenAI({ model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: '看这张图' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }] });
  check('input_image → image_url block（供图片能力门识别）', Array.isArray(e.messages[0].content) && e.messages[0].content[1].image_url.url === 'data:image/png;base64,AAAA', e.messages[0]);

  const f = api.responsesToOpenAI({ model: 'm', input: 'x', tools: [{ type: 'function', name: 'fn1', description: 'd', parameters: { type: 'object' } }, { type: 'web_search' }] });
  check('扁平 function 工具 → chat 嵌套形态', !!(f.tools && f.tools[0].function && f.tools[0].function.name === 'fn1'), f.tools);
  check('内置工具（web_search）被丢弃（有损点，文档写明）', !!(f.tools && f.tools.length === 1), f.tools);
  check('tool_choice 函数形态 → chat 形态', JSON.stringify(api.responsesToOpenAI({ model: 'm', input: 'x', tool_choice: { type: 'function', name: 'fn1' } }).tool_choice) === JSON.stringify({ type: 'function', function: { name: 'fn1' } }));
  check('max_output_tokens → max_completion_tokens（预算活着穿过）', api.responsesToOpenAI({ model: 'm', input: 'x', max_output_tokens: 4096 }).max_completion_tokens === 4096);
  check('空 input + 空 instructions → messages 为空（由 handler 回 400）', api.responsesToOpenAI({ model: 'm' }).messages.length === 0);
}

G('2. openAIToResponsesResponse：出站转换');
{
  const oai = { choices: [{ message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, completion_tokens_details: { reasoning_tokens: 1 } } };
  const r = api.openAIToResponsesResponse(oai, CTX());
  check('object = response / status = completed', r.object === 'response' && r.status === 'completed', { o: r.object, s: r.status });
  check('output[0] 是 message + output_text part', r.output[0].type === 'message' && r.output[0].content[0].type === 'output_text' && r.output[0].content[0].text === 'hi there', r.output);
  check('output_text 便利字段有值', r.output_text === 'hi there', r.output_text);
  check('usage 字段名按 Responses 口径（input_tokens/output_tokens）', r.usage.input_tokens === 7 && r.usage.output_tokens === 3 && r.usage.total_tokens === 10, r.usage);
  check('思考 token 进 output_tokens_details.reasoning_tokens', r.usage.output_tokens_details.reasoning_tokens === 1, r.usage);

  const tc = api.openAIToResponsesResponse({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }], usage: {} }, CTX());
  check('工具调用 → output[] 里的 function_call item', tc.output[0].type === 'function_call' && tc.output[0].call_id === 'call_9' && tc.output[0].arguments === '{"a":1}', tc.output);

  const trunc = api.openAIToResponsesResponse({ choices: [{ message: { role: 'assistant', content: 'cut' }, finish_reason: 'length' }], usage: {} }, CTX());
  check('finish_reason=length → status incomplete + 原因（不假装完成）', trunc.status === 'incomplete' && trunc.incomplete_details.reason === 'max_output_tokens', trunc.status);
}

G('3. 流式事件序列（真实转换器，非副本）');
{
  const ctx = CTX({ id: 'resp_stream' });
  const conv = api.createResponsesStreamConverter(ctx);
  let out = conv.start();
  out += conv.push({ choices: [{ delta: { role: 'assistant', content: 'he' } }] });
  out += conv.push({ choices: [{ delta: { content: 'llo' } }] });
  out += conv.push({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } });
  out += conv.end();
  const types = (out.match(/^event: (.+)$/gm) || []).map((s) => s.slice(7));
  const need = ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed'];
  check('九类关键事件齐全', need.every((t) => types.includes(t)), types);
  check('每个事件都带 event: 行 + data 行', /^event: response\.created\ndata: \{/.test(out), out.slice(0, 80));
  const deltas = (out.match(/^event: response\.output_text\.delta$/gm) || []).length;
  check('两段正文各出一个 delta 事件', deltas === 2, deltas);
  const completed = JSON.parse(out.slice(out.lastIndexOf('data: ') + 6).trim());
  check('response.completed 带全文与 usage', completed.response.output_text === 'hello' && completed.response.usage.total_tokens === 4, completed.response.output_text);
  check('sequence_number 单调递增', (() => { const ns = (out.match(/"sequence_number":(\d+)/g) || []).map((s) => Number(s.split(':')[1])); return ns.every((v, i) => i === 0 || v > ns[i - 1]); })());
  const again = conv.end();
  check('end() 幂等（[DONE] 与 epilogue 都会调它）', again === '', again && again.slice(0, 60));
  check('流式响应已落内存表（GET 取得到）', !!api.RESP_STORE.get('resp_stream'), [...api.RESP_STORE.keys()]);
}

G('4. 装配守卫');
{
  check('RESP_TTL_MS = 3600_000（对齐 notion2api 的 response_ttl_seconds）', /const RESP_TTL_MS = 3600_000;/.test(src));
  check('RESP_MAX = 200', /const RESP_MAX = 200;/.test(src));
  check('/v1/responses 路由指向 handleResponsesRequest', /url\.pathname === '\/v1\/responses'[\s\S]{0,260}handleResponsesRequest\(req, res, url\)/.test(src));
  check('/v1/responses/{id} 走 handleResponsesItem', /startsWith\('\/v1\/responses\/'\)[\s\S]{0,400}handleResponsesItem\(req, res, url\)/.test(src));
  const oaiWhitelist = src.slice(src.indexOf("url.pathname === '/v1/chat/completions'"), src.indexOf('handleOpenAIRequest(req, res, url)'));
  check('/v1/responses 已从 handleOpenAIRequest 的白名单里摘掉（否则 input 报文会被当 chat 处理）',
    oaiWhitelist.length > 0 && oaiWhitelist.length < 400 && !/\/v1\/responses/.test(oaiWhitelist), oaiWhitelist.length);
  const respBlock = src.slice(src.indexOf('async function handleResponsesRequest'), src.indexOf('function handleResponsesItem'));
  check('Responses 段**不设** clientProto（设了就会把入站报文直通给 chat 上游）', !/clientProto\s*:/.test(respBlock), (respBlock.match(/clientProto\s*:/) || []).length);
  check('chat 面与 responses 面共用同一条候选链（定义 1 + 调用 2）', (src.match(/openAICandidateChain\(requested\)/g) || []).length === 3, (src.match(/openAICandidateChain\(requested\)/g) || []).length);
  check('streamEpilogue 与 [DONE] 都收敛到同一个幂等 end()', /data === '\[DONE\]'\) return conv\.end\(\)/.test(src) && /streamEpilogue: \(\) => conv\.end\(\)/.test(src));
}

/* ═══════ §2 端到端 ═══════ */
let lastBody = null, lastUrl = null;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { }
    lastBody = body; lastUrl = req.url;
    if (req.method === 'GET' && /models/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-responses' }] }));
    }
    if (body && body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
      res.write(frame({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'STREAM-' } }] }));
      res.write(frame({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'OK' } }] }));
      res.write(frame({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock', object: 'chat.completion', model: body && body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK-REPLY' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
    }));
  });
});

const startGateway = (cfgPath, port) => spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
  stdio: 'ignore',
});
const waitUp = async (port, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true; } catch { }
    await sleep(200);
  }
  return false;
};
const post = async (port, p, body, headers) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });
  let txt = ''; try { txt = await r.text(); } catch { }
  let json = null; try { json = JSON.parse(txt); } catch { }
  return { status: r.status, json, txt, channel: r.headers.get('X-ZZCSAPI-Channel') };
};
const bearer = (extra = {}) => ({ Authorization: `Bearer ${GW_KEY}`, ...extra });

(async () => {
  const UP_PORT = await freePort(), GW_PORT = await freePort();
  await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));
  const cfgPath = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW_PORT,
    health: { intervalSec: 3600, timeoutMs: 3000 },
    retries: { perChannel: 1, maxModelFallbacks: 99 },
    channels: [{ id: 'mock-openai', name: 'mock openai', protocol: 'openai', baseUrl: `http://127.0.0.1:${UP_PORT}/v1`, apiKey: 'sk-mock', priority: 1, enabled: true, models: { 'mock-responses': 'mock-responses' } }],
  }, null, 2));
  const gw = startGateway(cfgPath, GW_PORT);
  const stopChild = () => new Promise((res) => {
    if (!gw || gw.exitCode !== null || gw.signalCode !== null) return res();
    gw.once('exit', () => res());
    try { gw.kill(); } catch { }
    setTimeout(res, 1500);
  });

  try {
    if (!await waitUp(GW_PORT)) throw new Error('临时网关未起来（端口 ' + GW_PORT + '）');

    G('5. 非流式 POST /v1/responses（真 HTTP 链路）');
    lastBody = null;
    let r = await post(GW_PORT, '/v1/responses', { model: 'mock-responses', input: 'hello responses', instructions: 'be brief', max_output_tokens: 2048 }, bearer());
    check('HTTP 200', r.status === 200, r);
    check('上游收到的是 chat 报文（messages，不是 input）', !!(lastBody && Array.isArray(lastBody.messages) && lastBody.input === undefined), lastBody);
    check('instructions 变成 system 消息', !!(lastBody && lastBody.messages[0].role === 'system' && lastBody.messages[0].content === 'be brief'), lastBody && lastBody.messages);
    check('max_output_tokens → 上游 max_completion_tokens=2048', !!(lastBody && lastBody.max_completion_tokens === 2048), lastBody && lastBody.max_completion_tokens);
    check('上游 URL 是 chat/completions（Responses 面无独立上游）', lastUrl === '/v1/chat/completions', lastUrl);
    check('客户端拿到 Responses 形态（object=response）', !!(r.json && r.json.object === 'response' && r.json.status === 'completed'), r.json);
    check('output_text = 上游正文', !!(r.json && r.json.output_text === 'MOCK-REPLY'), r.json && r.json.output_text);
    check('usage 按 Responses 口径', !!(r.json && r.json.usage.input_tokens === 11 && r.json.usage.output_tokens === 4), r.json && r.json.usage);
    check('id 是 resp_ 前缀', !!(r.json && /^resp_/.test(r.json.id)), r.json && r.json.id);
    const rid = r.json && r.json.id;

    G('6. GET / DELETE /v1/responses/{id}');
    let g = await fetch(`http://127.0.0.1:${GW_PORT}/v1/responses/${rid}`, { headers: bearer() });
    check('GET 取回同一条（id 一致）', g.status === 200 && (await g.clone().json()).id === rid, g.status);
    let del = await fetch(`http://127.0.0.1:${GW_PORT}/v1/responses/${rid}`, { method: 'DELETE', headers: bearer() });
    const delJson = await del.json();
    check('DELETE → deleted:true 且 existed:true', del.status === 200 && delJson.deleted === true && delJson.existed === true, delJson);
    g = await fetch(`http://127.0.0.1:${GW_PORT}/v1/responses/${rid}`, { headers: bearer() });
    check('删掉后再 GET → 404', g.status === 404, g.status);
    g = await fetch(`http://127.0.0.1:${GW_PORT}/v1/responses/resp_nope`, { headers: bearer() });
    const nf = await g.json();
    check('未知 id → 404 且说明留存策略（不假装成功）', g.status === 404 && /not found/.test(JSON.stringify(nf)), nf);
    const unauth = await fetch(`http://127.0.0.1:${GW_PORT}/v1/responses/${rid}`);
    check('取回面同样要网关密钥（401）', unauth.status === 401, unauth.status);

    G('7. store:false 不落表');
    r = await post(GW_PORT, '/v1/responses', { model: 'mock-responses', input: 'x', store: false }, bearer());
    check('响应里 store=false', !!(r.json && r.json.store === false), r.json && r.json.store);
    g = await fetch(`http://127.0.0.1:${GW_PORT}/v1/responses/${r.json.id}`, { headers: bearer() });
    check('store:false 的 id 取不到（404）', g.status === 404, g.status);

    G('8. 流式 POST /v1/responses（SSE 事件序列）');
    const sr = await fetch(`http://127.0.0.1:${GW_PORT}/v1/responses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer() },
      body: JSON.stringify({ model: 'mock-responses', input: 'stream it', stream: true }),
    });
    const sTxt = await sr.text();
    check('HTTP 200 + text/event-stream', sr.status === 200 && /text\/event-stream/.test(sr.headers.get('content-type') || ''), sr.headers.get('content-type'));
    const evTypes = (sTxt.match(/^event: (.+)$/gm) || []).map((s) => s.slice(7));
    for (const t of ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed']) {
      check('事件序列含 ' + t, evTypes.includes(t), evTypes);
    }
    const lastEv = JSON.parse(sTxt.slice(sTxt.lastIndexOf('data: ') + 6).trim());
    check('response.completed 的正文是两段 delta 拼起来的', lastEv.response.output_text === 'STREAM-OK', lastEv.response.output_text);
    check('流式 usage 来自上游 usage 帧', lastEv.response.usage.input_tokens === 5 && lastEv.response.usage.output_tokens === 2, lastEv.response.usage);
    check('response.created 的 id 与 completed 一致（同一发）', JSON.parse(sTxt.slice(0, sTxt.indexOf('\n\n')).replace(/^event: [^\n]*\ndata: /, '')).response.id === lastEv.response.id);
    const sId = lastEv.response.id;
    const gs = await fetch(`http://127.0.0.1:${GW_PORT}/v1/responses/${sId}`, { headers: bearer() });
    check('流式那一发也能按 id 取回', gs.status === 200 && (await gs.json()).output_text === 'STREAM-OK', gs.status);

    G('9. 记账与对照');
    // usage.json 是**4 秒防抖落盘**（scheduleUsageFlush），所以轮询等它出现，别用固定 sleep 赌
    const readRows = () => { try { return JSON.parse(fs.readFileSync(path.join(TMP, 'usage.json'), 'utf8')).recent || []; } catch { return []; } };
    const t0 = Date.now();
    let rRows = [];
    while (Date.now() - t0 < 9000) {
      rRows = readRows().filter((x) => x && x.kind === 'responses');
      if (rRows.length >= 2) break;
      await sleep(200);
    }
    check('账本里有 kind=responses 的行（可归因）', rRows.length >= 2, readRows().map((x) => x && x.kind));
    check('记账行带真实模型名与渠道', rRows.length > 0 && rRows[rRows.length - 1].model === 'mock-responses' && rRows[rRows.length - 1].channelId === 'mock-openai', rRows[rRows.length - 1]);
    lastBody = null;
    const chat = await post(GW_PORT, '/v1/chat/completions', { model: 'mock-responses', messages: [{ role: 'user', content: 'hi' }] }, bearer());
    check('对照：chat 面未回归（仍 200 + 上游报文原样回传）', chat.status === 200 && !!(chat.json && chat.json.choices && chat.json.choices[0].message.content === 'MOCK-REPLY'), chat.json);
    check('对照：chat 面收到的仍是 messages（未被 responses 转换污染）', !!(lastBody && lastBody.messages && lastBody.messages.length === 1), lastBody && lastBody.messages);
    const bad = await post(GW_PORT, '/v1/responses', { model: 'mock-responses' }, bearer());
    check('空 input → 400 且文案说明原因', bad.status === 400 && /empty input/.test(JSON.stringify(bad.json)), bad.json);
    const noModel = await post(GW_PORT, '/v1/responses', { input: 'x' }, bearer());
    check('缺 model → 400 missing model', noModel.status === 400, noModel.json);
    const wrongMethod = await fetch(`http://127.0.0.1:${GW_PORT}/v1/responses`, { headers: bearer() });
    check('GET /v1/responses（无 id）→ 405', wrongMethod.status === 405, wrongMethod.status);
  } catch (e) {
    fail++;
    console.log('  ✗ 端到端阶段抛错：' + (e && e.message));
  } finally {
    await stopChild();
    try { upstream.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log((fail === 0 ? '✓ 全部通过' : '✗ 有失败') + `（${pass + fail} 项断言，通过 ${pass}，失败 ${fail}）`);
  console.log('─'.repeat(58));
  process.exitCode = fail === 0 ? 0 : 1;
})();
