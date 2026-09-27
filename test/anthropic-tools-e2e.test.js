#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/anthropic-tools-e2e.test.js — Anthropic 工具调用端到端回归（真起进程，零依赖）
 *
 * 与 test/anthropic-tools.test.js 的分工：
 *   · 那个是**单元级**：现抠转换函数，验形态（快）。
 *   · 这个是**端到端**：真起「假上游 + 临时网关实例」，走完整 HTTP 链路，验
 *     ★ 客户端协议 → 网关 → 上游的**实际字节**（尤其"工具结果里的图片"这条侧门），
 *     以及第一轮回传的 tool_use.id 是否真的在第二轮成了上游看到的 tool_call_id。
 *
 * 为什么需要它：
 *   工具调用是**多轮**的：第一轮模型要工具、第二轮把结果送回去。任何一轮的配对错位
 *   （id 变了、图片掉了、is_error 没标）在单轮测试里都看不出来，只有真链路+两轮才能现形。
 *
 * 安全约束（与图片 e2e 同规矩）：
 *   · 动态空闲端口，不碰 8787；配置/用量写系统临时目录（ZZCSAPI_CONFIG / ZZCSAPI_USAGE），
 *     **绝不读写仓库里的 config.json / usage.json**；上游是本地假服务，不出网、不耗额度。
 *
 * 跑法：node test/anthropic-tools-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const IMG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-tools-e2e-'));
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

/* ── 假上游：只认 OpenAI 协议；把收到的完整请求体存下来供断言 ── */
let lastBody = null;
const sse = (res, obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { }
    if (body) lastBody = body;
    if (req.method === 'GET' && /models/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-vision' }] }));
    }
    const sawImg = JSON.stringify(body || {}).includes('"image_url"');
    const sawToolMsg = Array.isArray(body?.messages) && body.messages.some((m) => m.role === 'tool');
    // 只有"第一轮（还没送回过工具结果）"才回工具调用；第二轮要回文本，否则测不到回传链路
    const wantsTool = Array.isArray(body?.tools) && body.tools.length > 0 && !sawToolMsg;
    if (body && body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const id = 'chatcmpl-s';
      if (!wantsTool) {
        sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'MOCK-STREAM-TEXT' } }] });
        sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } });
      } else {
        sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '查一下：' } }] });
        sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_stream_1', type: 'function', function: { name: 'get_weather', arguments: '{"city"' } }] } }] });
        sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"上海"}' } }] } }] });
        sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 4 } });
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (wantsTool) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chatcmpl-tool', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '我来查', tool_calls: [{ id: 'call_e2e_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock', object: 'chat.completion', model: body && body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: sawToolMsg && sawImg ? 'MOCK-SAW-TOOL-IMAGE' : (sawImg ? 'MOCK-SAW-IMAGE' : 'MOCK-TEXT-ONLY') }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
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
async function call(port, p, body, headers) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  let txt = ''; try { txt = await r.text(); } catch { }
  let json = null; try { json = JSON.parse(txt); } catch { }
  return { status: r.status, json, txt, channel: r.headers.get('X-ZZCSAPI-Channel') };
}
/* 解析 Anthropic SSE → [{event, data}] */
function parseSSE(txt) {
  const out = [];
  for (const block of txt.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block);
    const dt = /^data: (.+)$/m.exec(block);
    if (!ev) continue;
    let data = null; try { data = JSON.parse(dt ? dt[1] : '{}'); } catch { }
    out.push({ event: ev[1].trim(), data });
  }
  return out;
}
const bearer = (extra = {}) => ({ Authorization: `Bearer ${GW_KEY}`, ...extra });

const writeCfg = (file, port, channels) => {
  const p = path.join(TMP, file);
  fs.writeFileSync(p, JSON.stringify({ port, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 1, maxModelFallbacks: 99 }, channels }, null, 2));
  return p;
};

const TOOL = { name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const A = '/anthropic/v1/messages';

(async () => {
  const UP_PORT = await freePort(), GW_PORT = await freePort(), GW2_PORT = await freePort();
  await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

  const cfgMain = writeCfg('main.json', GW_PORT, [
    { id: 'mock-openai', name: 'mock openai', protocol: 'openai', baseUrl: `http://127.0.0.1:${UP_PORT}/v1`, apiKey: 'sk-mock', priority: 1, enabled: true, models: { 'mock-vision': 'mock-vision' } },
    { id: 'mock-notion', name: 'mock notion', protocol: 'notion', baseUrl: 'http://127.0.0.1:1', apiKey: 'token_v2=mock', priority: 99, enabled: true, models: { 'mock-vision': 'mock-vision' } },
  ]);
  const cfgNoImg = writeCfg('noimg.json', GW2_PORT, [
    { id: 'mock-notion-only', name: 'mock notion only', protocol: 'notion', baseUrl: 'http://127.0.0.1:1', apiKey: 'token_v2=mock', priority: 99, enabled: true, models: { 'mock-vision': 'mock-vision' } },
  ]);
  const gw = startGateway(cfgMain, GW_PORT), gw2 = startGateway(cfgNoImg, GW2_PORT);
  const cleanup = () => {
    try { gw.kill(); } catch { }
    try { gw2.kill(); } catch { }
    try { upstream.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  };

  try {
    if (!await waitUp(GW_PORT) || !await waitUp(GW2_PORT)) throw new Error('临时网关未起来（端口 ' + GW_PORT + '/' + GW2_PORT + '）');

    console.log('\n1. 第一轮：客户端要工具 → 上游收到 function 工具定义，客户端收到 tool_use');
    lastBody = null;
    let r = await call(GW_PORT, A, {
      model: 'mock-vision', max_tokens: 64, tools: [TOOL], tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [{ role: 'user', content: '上海天气？请调用工具' }],
    }, { 'x-api-key': GW_KEY });
    check('HTTP 200（非流式 Anthropic 工具请求）', r.status === 200, r.status + ' ' + r.txt.slice(0, 140));
    check('上游收到 tools[].function.parameters（input_schema 原样）',
      !!(lastBody?.tools?.[0]?.function?.parameters?.properties?.city), lastBody?.tools);
    check('★ disable_parallel_tool_use → 上游收到 parallel_tool_calls:false', lastBody?.parallel_tool_calls === false, lastBody?.parallel_tool_calls);
    check("tool_choice 映射为 'auto'", lastBody?.tool_choice === 'auto', lastBody?.tool_choice);
    const tu = (r.json?.content || []).find((c) => c.type === 'tool_use');
    check('★ 客户端收到 tool_use 块（id/name/input 正确）',
      !!tu && tu.id === 'call_e2e_1' && tu.name === 'get_weather' && tu.input?.city === '上海', r.json?.content);
    check("stop_reason 是 'tool_use'（客户端据此判断要不要执行工具）", r.json?.stop_reason === 'tool_use', r.json?.stop_reason);
    check('文本块也在（"我来查"）', r.json?.content?.[0]?.text === '我来查', r.json?.content);

    console.log('\n2. ★ 第二轮：把工具结果送回（文本 + is_error + 图片 = 侧门）');
    lastBody = null;
    r = await call(GW_PORT, A, {
      model: 'mock-vision', max_tokens: 64, tools: [TOOL],
      messages: [
        { role: 'user', content: '上海天气？请调用工具' },
        { role: 'assistant', content: [{ type: 'text', text: '我来查' }, { type: 'tool_use', id: tu.id, name: 'get_weather', input: tu.input }] },
        {
          role: 'user', content: [
            { type: 'tool_result', tool_use_id: tu.id, content: [{ type: 'text', text: '25℃ 晴' }] },
            { type: 'tool_result', tool_use_id: 'call_e2e_2', content: [{ type: 'text', text: '连接被拒' }], is_error: true },
            { type: 'tool_result', tool_use_id: 'call_e2e_3', content: [{ type: 'text', text: '这是截图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG } }] },
          ],
        },
      ],
    }, { 'x-api-key': GW_KEY });
    check('HTTP 200', r.status === 200, r.status + ' ' + r.txt.slice(0, 140));
    const msgs = lastBody?.messages || [];
    const asst = msgs.find((m) => m.role === 'assistant');
    check('★ 上游看到的 assistant.tool_calls[].id 与本客户端拿到的 tool_use.id 完全一致（配对不裂）',
      asst?.tool_calls?.[0]?.id === tu.id, [tu.id, asst?.tool_calls?.[0]?.id]);
    const tools_ = msgs.filter((m) => m.role === 'tool');
    check('三条 tool_result → 三条 role:"tool" 消息，tool_call_id 各自配对',
      tools_.length === 3 && tools_[0].tool_call_id === tu.id && tools_[1].tool_call_id === 'call_e2e_2' && tools_[2].tool_call_id === 'call_e2e_3',
      tools_.map((m) => m.tool_call_id));
    check('tool 消息 content 全是字符串（上游不会因数组形态 400）', tools_.every((m) => typeof m.content === 'string'), tools_.map((m) => typeof m.content));
    check('文本结果原样', tools_[0].content === '25℃ 晴', tools_[0].content);
    check('★ is_error → 上游看到 [tool_error] 标记', tools_[1].content === '[tool_error] 连接被拒', tools_[1].content);
    const imgMsg = msgs.filter((m) => m.role === 'user').pop();
    check('★ 工具结果里的图片补在 tool 消息之后的 user 消息里（data URL 字节一致）',
      imgMsg?.content?.[1]?.image_url?.url === 'data:image/png;base64,' + IMG, imgMsg?.content);
    check('图片消息在 tool 消息之后（顺序：工具结果 → 图）',
      msgs.indexOf(imgMsg) > msgs.indexOf(tools_[2]), msgs.map((m) => m.role));
    check('上游确实同时看到了 tool 消息与 image_url（假上游据此回标记）',
      r.json?.content?.[0]?.text === 'MOCK-SAW-TOOL-IMAGE', r.json?.content);

    console.log('\n3. 流式工具回合：OpenAI SSE 增量 → Anthropic 事件序列');
    const sr = await fetch(`http://127.0.0.1:${GW_PORT}${A}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': GW_KEY },
      body: JSON.stringify({ model: 'mock-vision', max_tokens: 64, stream: true, tools: [TOOL], messages: [{ role: 'user', content: '上海天气？请调用工具' }] }),
    });
    const stxt = await sr.text();
    check('HTTP 200 + SSE 内容类型', sr.status === 200 && /event-stream/.test(sr.headers.get('content-type') || ''), sr.headers.get('content-type'));
    if (!/^event: /m.test(stxt)) console.log('    [诊断] 流式原始响应 → ' + JSON.stringify(stxt.slice(0, 500)));
    const evs = parseSSE(stxt);
    const names = evs.map((e) => e.event);
    check('事件序列完整（message_start … message_stop）',
      names[0] === 'message_start' && names[names.length - 1] === 'message_stop', names);
    const tb = evs.find((e) => e.event === 'content_block_start' && e.data?.content_block?.type === 'tool_use');
    check('★ content_block_start 的 tool_use 带 input:{} 与正确 name',
      !!tb && JSON.stringify(tb.data.content_block.input) === '{}' && tb.data.content_block.name === 'get_weather', tb?.data?.content_block);
    const args = evs.filter((e) => e.data?.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
    let parsed = null; try { parsed = JSON.parse(args); } catch { }
    check('★ input_json_delta 拼回完整合法 JSON（分片未错位）', parsed?.city === '上海', args);
    check('工具块与文本块都闭合',
      evs.filter((e) => e.event === 'content_block_stop').length >= 2, names);
    check("message_delta 的 stop_reason 是 'tool_use'",
      evs.find((e) => e.event === 'message_delta')?.data?.delta?.stop_reason === 'tool_use');
    check('usage 透传到 message_delta', evs.find((e) => e.event === 'message_delta')?.data?.usage?.output_tokens === 4);

    console.log('\n4. 侧门同样受「图片能力门」保护（只有 notion 渠道时明确 400）');
    r = await call(GW2_PORT, A, {
      model: 'mock-vision', max_tokens: 32,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG } }] }] }],
    }, { 'x-api-key': GW_KEY });
    check('★ 工具结果里的图也算"含图请求" → 400（不是静默丢图作答）', r.status === 400, r.status + ' ' + r.txt.slice(0, 140));
    check('错误文案说明原因', !!(r.txt || '').includes('only openai-protocol channels'), (r.txt || '').slice(0, 160));

    console.log('\n5. 无工具请求不受影响（回归）');
    lastBody = null;
    r = await call(GW_PORT, A, { model: 'mock-vision', max_tokens: 16, messages: [{ role: 'user', content: '只说文本' }] }, { 'x-api-key': GW_KEY });
    check('HTTP 200 且上游没收到 tools', r.status === 200 && !('tools' in (lastBody || {})), Object.keys(lastBody || {}));
    check('响应是普通文本块', r.json?.content?.[0]?.text === 'MOCK-TEXT-ONLY', r.json?.content);
    check('tool_choice 未设置时不下发 parallel_tool_calls', !('parallel_tool_calls' in (lastBody || {})));

    console.log('\n6. OpenAI 协议客户端走工具（同一条内部链路）');
    lastBody = null;
    r = await call(GW_PORT, '/v1/chat/completions', { model: 'mock-vision', tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }], messages: [{ role: 'user', content: '天气' }] }, bearer());
    check('HTTP 200 且上游收到 tools', r.status === 200 && Array.isArray(lastBody?.tools), r.status);
    check('OpenAI 客户端拿到原生 tool_calls', r.json?.choices?.[0]?.message?.tool_calls?.[0]?.id === 'call_e2e_1', r.json?.choices?.[0]?.message);
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
