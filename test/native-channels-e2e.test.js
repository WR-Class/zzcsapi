#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/native-channels-e2e.test.js — 原生 anthropic / gemini 渠道出站（端到端，零依赖）
 *
 * 单元测试证明转换函数对，这个文件证明**真实链路上**：客户端说一套协议、渠道讲另一套协议，照样能通。
 * 真起「原生 Anthropic 假上游 + 原生 Gemini 假上游 + 临时网关」，断言：
 *   · 上游**真的收到了原生格式**（URL / 鉴权头 / 报文字段），不是 OpenAI 格式硬塞；
 *   · 客户端**真的收到自己那套协议**的响应（三条客户端路由 × 两种原生渠道）；
 *   · 流式：原生 SSE → OpenAI SSE →（必要时再转）客户端协议 SSE，事件序列完整、能收尾；
 *   · 图片与工具调用跨协议可用；上游错误体原样透传（不被翻译成假的成功）。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/native-channels-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-native-e2e-'));
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

/* ── 原生 Anthropic 假上游（严格按官方报文形状）── */
const antSeen = [];
const antUpstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
    if (req.method === 'GET' && /\/v1\/models/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'claude-x', type: 'model' }] }));
    }
    const body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}');
    antSeen.push({ url: req.url, headers: req.headers, body });
    // 错误注入：model=claude-error 时回一个**原生 Anthropic 错误体**（验证它不会被翻译成假成功）
    if (body.model === 'claude-error') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be greater than 0' } }));
    }
    const wantsTool = Array.isArray(body.tools) && body.tools.length && !JSON.stringify(body.messages || []).includes('tool_result');
    if (wantsTool && !body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'msg_e2e', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'tool_use', id: 'toolu_e2e_1', name: body.tools[0].name, input: { city: '上海' } }],
        stop_reason: 'tool_use', usage: { input_tokens: 11, output_tokens: 4 },
      }));
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ev = (t, o) => res.write(`event: ${t}\ndata: ${JSON.stringify(o)}\n\n`);
      ev('message_start', { type: 'message_start', message: { id: 'msg_e2e_s', model: body.model, role: 'assistant', usage: { input_tokens: 7, output_tokens: 0 } } });
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      const frags = ['ANTHROPIC', '-NATIVE', '-STREAM'];
      for (const f of frags) ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: f } });
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } });
      ev('message_stop', { type: 'message_stop' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_e2e', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: 'ANTHROPIC-NATIVE-OK' }],
      stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 },
    }));
  });
});

/* ── 原生 Gemini 假上游 ── */
const gemSeen = [];
const gemUpstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
    if (req.method === 'GET' && /\/v1beta\/models/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: [{ name: 'models/gemini-x' }] }));
    }
    const body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}');
    gemSeen.push({ url: req.url, headers: req.headers, body });
    const streaming = /streamGenerateContent/.test(req.url);
    if (streaming) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const parts = ['GEMINI', '-NATIVE', '-STREAM'];
      for (const p of parts) res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: p }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 } })}\n\n`);
      return res.end();
    }
    const wantsTool = Array.isArray(body.tools) && body.tools.length && !JSON.stringify(body.contents || []).includes('functionResponse');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: wantsTool ? [{ functionCall: { name: body.tools[0].functionDeclarations[0].name, args: { city: '上海' } } }] : [{ text: 'GEMINI-NATIVE-OK' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2, totalTokenCount: 8 },
      modelVersion: 'gemini-x',
    }));
  });
});

function startGateway(cfgPath, usagePath, port) {
  return spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: usagePath, GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
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
const sseData = (txt) => txt.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter((d) => d !== '[DONE]');
const sseEvents = (txt) => txt.split('\n\n').map((b) => /^event: (.+)$/m.exec(b)?.[1]).filter(Boolean);

(async () => {
  const PA = await freePort(), PG = await freePort(), GW = await freePort();
  await new Promise((r) => antUpstream.listen(PA, '127.0.0.1', r));
  await new Promise((r) => gemUpstream.listen(PG, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'native.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 1, maxModelFallbacks: 99 },
    channels: [
      { id: 'mock-anthropic', name: 'A', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${PA}`, apiKey: 'sk-ant-e2e', priority: 10, enabled: true, models: { 'claude-a': 'claude-x', 'claude-err': 'claude-error' } },
      { id: 'mock-gemini', name: 'G', protocol: 'gemini', baseUrl: `http://127.0.0.1:${PG}`, apiKey: 'gk-e2e', priority: 9, enabled: true, models: { 'gemini-a': 'gemini-x' } },
      { id: 'mock-openai', name: 'O', protocol: 'openai', baseUrl: `http://127.0.0.1:${PA}/v1`, apiKey: 'sk-oai', priority: 1, enabled: true, models: { 'oai-a': 'oai-x' } },
    ],
  }));
  const gw = startGateway(cfgPath, path.join(TMP, 'usage.json'), GW);
  const cleanup = () => {
    try { gw.kill(); } catch { }
    try { antUpstream.close(); gemUpstream.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  };
  const post = async (p, body, headers) => {
    const r = await fetch(`http://127.0.0.1:${GW}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, ct: r.headers.get('content-type'), ch: r.headers.get('X-ZZCSAPI-Channel'), txt: await r.text() };
  };
  const OAI = { Authorization: 'Bearer ' + GW_KEY };
  const ANT = { 'x-api-key': GW_KEY };
  const GEM = { 'x-goog-api-key': GW_KEY };

  try {
    if (!await waitUp(GW)) throw new Error('临时网关未起来');

    console.log('\n1. ★ OpenAI 客户端 → anthropic 协议渠道（非流式）');
    let r = await post('/v1/chat/completions', { model: 'claude-a', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }] }, OAI);
    let saw = antSeen[antSeen.length - 1];
    check('HTTP 200 且走的是 anthropic 渠道', r.status === 200 && r.ch === 'mock-anthropic', [r.status, r.ch]);
    check('★ 上游 URL 是原生的 /v1/messages', saw.url === '/v1/messages', saw.url);
    check('★ 鉴权头是 x-api-key + anthropic-version（不是 Bearer）', saw.headers['x-api-key'] === 'sk-ant-e2e' && saw.headers['anthropic-version'] === '2023-06-01' && !saw.headers.authorization, Object.keys(saw.headers));
    check('★ 报文是原生格式：model=渠道 upstream、system 在顶层、max_tokens 有值',
      saw.body.model === 'claude-x' && saw.body.system === 'SYS' && saw.body.max_tokens > 0 && Array.isArray(saw.body.messages), saw.body);
    check('客户端拿到 OpenAI 格式响应', JSON.parse(r.txt).choices[0].message.content === 'ANTHROPIC-NATIVE-OK', r.txt.slice(0, 120));
    check('usage 映射（含 cache_read）', JSON.parse(r.txt).usage.prompt_tokens === 5 && JSON.parse(r.txt).usage.prompt_tokens_details.cached_tokens === 2, JSON.parse(r.txt).usage);

    console.log('\n2. ★ OpenAI 客户端 → anthropic 渠道（流式）');
    r = await post('/v1/chat/completions', { model: 'claude-a', stream: true, messages: [{ role: 'user', content: 'hi' }] }, OAI);
    const lines = sseData(r.txt);
    check('HTTP 200 + SSE', r.status === 200 && /event-stream/.test(r.ct || ''), [r.status, r.ct]);
    check('★ 客户端收到的是 OpenAI 分片（object=chat.completion.chunk）', lines.length > 0 && lines.every((l) => JSON.parse(l).object === 'chat.completion.chunk'), lines.slice(0, 2));
    check('文本增量拼出 ANTHROPIC-NATIVE-STREAM',
      lines.map((l) => JSON.parse(l).choices[0].delta.content || '').join('') === 'ANTHROPIC-NATIVE-STREAM',
      lines.map((l) => JSON.parse(l).choices[0].delta.content || ''));
    check('★ 以 data: [DONE] 收尾（原生 message_stop 被翻译过来）', r.txt.trimEnd().endsWith('data: [DONE]'), r.txt.slice(-80));
    check('finish_reason 出现', lines.some((l) => JSON.parse(l).choices[0].finish_reason === 'stop'));

    console.log('\n3. ★ Anthropic 客户端 → anthropic 渠道（双重转换，流式）');
    r = await post('/anthropic/v1/messages', { model: 'claude-a', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] }, ANT);
    const evs = sseEvents(r.txt);
    check('HTTP 200 + SSE', r.status === 200, r.status);
    check('★ 客户端收回 Anthropic 协议事件（message_start 恰好一次 / message_stop 收尾）',
      evs.filter((e) => e === 'message_start').length === 1 && evs[evs.length - 1] === 'message_stop', evs);
    check('文本经两跳转换后完好',
      sseData(r.txt).filter((d) => /content_block_delta/.test(d)).map((d) => JSON.parse(d).delta.text).join('') === 'ANTHROPIC-NATIVE-STREAM',
      sseData(r.txt));

    console.log('\n4. ★ Gemini 客户端 → gemini 协议渠道（非流式）');
    r = await post('/gemini/v1beta/models/gemini-a:generateContent', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, GEM);
    saw = gemSeen[gemSeen.length - 1];
    check('HTTP 200 且走的是 gemini 渠道', r.status === 200 && r.ch === 'mock-gemini', [r.status, r.ch]);
    check('★ 上游 URL 含模型名与 :generateContent', /\/v1beta\/models\/gemini-x:generateContent$/.test(saw.url), saw.url);
    check('★ 鉴权头是 x-goog-api-key', saw.headers['x-goog-api-key'] === 'gk-e2e' && !saw.headers.authorization, Object.keys(saw.headers));
    check('★ 报文是原生格式：contents/parts，没有 model 字段', Array.isArray(saw.body.contents) && saw.body.model === undefined && saw.body.contents[0].parts[0].text === 'hi', saw.body);
    check('客户端拿到 Gemini 格式响应', JSON.parse(r.txt).candidates[0].content.parts[0].text === 'GEMINI-NATIVE-OK', r.txt.slice(0, 120));

    console.log('\n5. ★ Gemini 客户端 → gemini 渠道（流式）');
    r = await post('/gemini/v1beta/models/gemini-a:streamGenerateContent', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, GEM);
    saw = gemSeen[gemSeen.length - 1];
    const gLines = sseData(r.txt);
    check('★ 上游收到的是 :streamGenerateContent?alt=sse', /:streamGenerateContent\?alt=sse$/.test(saw.url), saw.url);
    check('客户端拿到 Gemini SSE 分片',
      gLines.length > 0 && gLines.map((l) => ((JSON.parse(l).candidates[0].content.parts[0]) || {}).text || '').join('') === 'GEMINI-NATIVE-STREAM',
      gLines.map((l) => ((JSON.parse(l).candidates[0].content.parts[0]) || {}).text || ''));
    check('收尾分片带 finishReason', gLines.some((l) => JSON.parse(l).candidates[0].finishReason === 'STOP'), gLines.slice(-1));

    console.log('\n6. ★ 图片跨原生协议（图片能力门现在允许 anthropic / gemini）');
    const PNG = 'data:image/png;base64,AAAB';
    r = await post('/v1/chat/completions', { model: 'claude-a', messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: PNG } }] }] }, OAI);
    saw = antSeen[antSeen.length - 1];
    check('★ 带图请求不再被图片门拦（HTTP 200）', r.status === 200, [r.status, r.txt.slice(0, 100)]);
    check('★ 上游收到 Anthropic image 块（base64 + media_type）',
      saw.body.messages[0].content[1].type === 'image' && saw.body.messages[0].content[1].source.type === 'base64' && saw.body.messages[0].content[1].source.media_type === 'image/png', saw.body.messages[0]);
    r = await post('/v1/chat/completions', { model: 'gemini-a', messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: PNG } }] }] }, OAI);
    saw = gemSeen[gemSeen.length - 1];
    check('★ gemini 渠道收到 inlineData', saw.body.contents[0].parts[1].inlineData.mimeType === 'image/png', saw.body.contents[0]);
    check('图片请求同样拿到 200', r.status === 200 && JSON.parse(r.txt).choices[0].message.content === 'GEMINI-NATIVE-OK', r.status);

    console.log('\n7. ★ 工具调用跨原生协议（要工具 → 客户端配对）');
    const TOOL = { type: 'function', function: { name: 'get_weather', description: 'd', parameters: { type: 'object', properties: { city: { type: 'string' } } } } };
    r = await post('/v1/chat/completions', { model: 'claude-a', tools: [TOOL], messages: [{ role: 'user', content: '上海天气' }] }, OAI);
    saw = antSeen[antSeen.length - 1];
    const oaiResp = JSON.parse(r.txt);
    check('★ 上游收到 tools[].input_schema（原生字段名）', saw.body.tools[0].input_schema.properties.city.type === 'string', saw.body.tools[0]);
    check('★ 客户端拿到 tool_calls（id 可回传配对）', oaiResp.choices[0].message.tool_calls[0].function.name === 'get_weather' && !!oaiResp.choices[0].message.tool_calls[0].id, oaiResp.choices[0].message);
    check('finish_reason=tool_calls', oaiResp.choices[0].finish_reason === 'tool_calls');
    check('arguments 是 JSON 字符串（OpenAI 形态）', JSON.parse(oaiResp.choices[0].message.tool_calls[0].function.arguments).city === '上海');

    console.log('\n8. ★ 上游错误体原样透传（不被翻译成假的成功）');
    // 上游对 claude-error 回 400 + 原生 Anthropic 错误体。若翻译层不看状态码就硬翻，
    // 客户端会收到一个"看起来成功但空内容"的 200 —— 那是最坏的结果。
    r = await post('/v1/chat/completions', { model: 'claude-err', messages: [{ role: 'user', content: 'hi' }] }, OAI);
    check('★ 客户端拿到上游的 400（不是被吞掉/伪装成 200）', r.status === 400, [r.status, r.txt.slice(0, 160)]);
    check('★ 错误信息是上游原文（没被翻译成 OpenAI 空响应）',
      /max_tokens: must be greater than 0/.test(r.txt) && !/chat\.completion/.test(r.txt), r.txt.slice(0, 200));

    console.log('\n9. 对照组：openai 协议渠道行为完全不变（Bearer + chat/completions）');
    r = await post('/v1/chat/completions', { model: 'oai-a', messages: [{ role: 'user', content: 'hi' }] }, OAI);
    check('openai 渠道仍被选中（没被原生渠道抢走）', r.ch === 'mock-openai', [r.status, r.ch, r.txt.slice(0, 80)]);
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    cleanup();
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exit(fail ? 1 : 0);
})();
