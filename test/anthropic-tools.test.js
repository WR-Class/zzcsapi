#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/anthropic-tools.test.js — Anthropic tool_use ↔ OpenAI tool_calls 转换回归
 *
 * 为什么需要它（README「Anthropic tool_use 完整转换」/ detailed §8.14）：
 *   网关内部统一用 OpenAI 格式，而 Claude 客户端说的是 Anthropic 的 tool_use / tool_result。
 *   这条翻译链最怕的不是报错，而是**静默丢件**：工具参数少了半个 JSON、工具结果里的图片
 *   没了、失败的工具体现成正常结果 —— 模型会拿着残缺上下文继续一本正经地推理。
 *
 * 怎么测的：
 *   从 server.js **按花括号配对抠出真实函数源码**（不是复制副本），在沙箱里跑转换，
 *   断言请求侧、响应侧、流式侧三种形态，以及最关键的"id 往返配对"性质。
 *
 * 不覆盖：真实上游是否支持 function calling（那取决于模型与渠道本身）。
 *         依赖函数名 anthropicToOpenAI / openAIToAnthropicResponse / openAIStreamToAnthropicSSE /
 *         mapFinishReason / sanitizeToolId，改名会让本脚本报错 —— 这是刻意的。
 *
 * 跑法：node test/anthropic-tools.test.js      （零依赖，退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');

/* ── 抠函数（含生成器 function* 形态） ─────────────────────────────────────── */
function extract(name) {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) i = src.indexOf('function* ' + name + '(');
  if (i < 0) throw new Error('server.js 里找不到函数 ' + name + '（改名了？请同步本脚本与文档）');
  let depth = 0, started = false;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('花括号不配对：' + name);
}

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← 实际: ' + JSON.stringify(extra).slice(0, 260) : '')); }
}
const G = (t) => console.log('\n' + t);

let api;
try {
  api = new Function([
    extract('sanitizeToolId'),
    extract('mapFinishReason'),
    // 工具结果图片的内部锚点：server.js 里是模块级 const，抠函数时要一起带上（否则 ReferenceError）
    (src.match(/^const TOOL_RESULT_IMAGE_MARK = .*$/m) || [''])[0],
    extract('anthropicToOpenAI'),
    extract('openAIToAnthropicResponse'),
    extract('createAnthropicStreamConverter'),
    extract('openAIStreamToAnthropicSSE'),
    extract('bodyHasImages'),
    'return { sanitizeToolId, mapFinishReason, anthropicToOpenAI, openAIToAnthropicResponse, createAnthropicStreamConverter, openAIStreamToAnthropicSSE, bodyHasImages };',
  ].join('\n'))();
} catch (e) {
  console.error('✗ 装配失败：' + e.message);
  process.exit(1);
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const TOOL = { name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };

/* ═══════ 1. 工具定义与 tool_choice ═══════ */
function testTools() {
  G('1. 工具定义 / tool_choice / 采样参数');
  const base = (extra) => api.anthropicToOpenAI({
    model: 'claude-x', max_tokens: 100, temperature: 0.2, top_p: 0.9,
    stop_sequences: ['\n\nHuman:'],
    system: [{ type: 'text', text: '你严谨' }, { type: 'text', text: '第二段' }],
    tools: [TOOL],
    messages: [{ role: 'user', content: '上海天气' }],
    ...extra,
  });

  const r = base({});
  check('tools[].input_schema → function.parameters（原样）',
    JSON.stringify(r.tools[0].function.parameters) === JSON.stringify(TOOL.input_schema), r.tools);
  check('工具名与描述透传', r.tools[0].function.name === 'get_weather' && r.tools[0].function.description === '查天气');
  check('stop_sequences → stop', JSON.stringify(r.stop) === JSON.stringify(['\n\nHuman:']), r.stop);
  check('system 块数组 → 单条 system 消息（换行拼接）',
    r.messages[0].role === 'system' && r.messages[0].content === '你严谨\n第二段', r.messages[0]);
  check('采样参数透传', r.temperature === 0.2 && r.top_p === 0.9 && r.max_tokens === 100);

  check("tool_choice auto → 'auto'", base({ tool_choice: { type: 'auto' } }).tool_choice === 'auto');
  check("tool_choice any → 'required'", base({ tool_choice: { type: 'any' } }).tool_choice === 'required');
  check("tool_choice tool → function 指定",
    JSON.stringify(base({ tool_choice: { type: 'tool', name: 'get_weather' } }).tool_choice) === '{"type":"function","function":{"name":"get_weather"}}');
  check("★ tool_choice none → 'none'（以前没映射，会被当成未指定）",
    base({ tool_choice: { type: 'none' } }).tool_choice === 'none');
  check('★ disable_parallel_tool_use → parallel_tool_calls:false',
    base({ tool_choice: { type: 'auto', disable_parallel_tool_use: true } }).parallel_tool_calls === false);
  check('未要求时不下发 parallel_tool_calls（不改变默认行为）',
    !('parallel_tool_calls' in base({})));
}

/* ═══════ 2. 请求侧：tool_use → tool_calls ═══════ */
function testToolUse() {
  G('2. assistant 的 tool_use → OpenAI tool_calls');
  const r = api.anthropicToOpenAI({
    model: 'm', max_tokens: 64,
    messages: [{
      role: 'assistant',
      content: [{ type: 'text', text: '我查一下' }, { type: 'tool_use', id: 'toolu_a1', name: 'get_weather', input: { city: '上海' } }],
    }],
  });
  const m = r.messages[0];
  check('文本与 tool_calls 合并进同一条 assistant 消息', m.role === 'assistant' && m.content === '我查一下');
  check('tool_calls 形状正确（id 保留、arguments 序列化成 JSON 字符串）',
    m.tool_calls[0].id === 'toolu_a1' && m.tool_calls[0].type === 'function' &&
    m.tool_calls[0].function.name === 'get_weather' && m.tool_calls[0].function.arguments === '{"city":"上海"}', m.tool_calls);
  check('多个 tool_use 全部保留',
    api.anthropicToOpenAI({
      model: 'm', max_tokens: 8,
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'a', input: {} }, { type: 'tool_use', id: 't2', name: 'b', input: {} }] }],
    }).messages[0].tool_calls.length === 2);
  check('thinking 块被丢弃但不破坏结构（tool_calls 仍在）',
    api.anthropicToOpenAI({
      model: 'm', max_tokens: 8,
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '内部推理' }, { type: 'tool_use', id: 't1', name: 'a', input: {} }] }],
    }).messages[0].tool_calls.length === 1);
}

/* ═══════ 3. 请求侧：tool_result → role:'tool' ═══════ */
function testToolResult() {
  G('3. tool_result → role:"tool"');
  const mk = (b) => api.anthropicToOpenAI({ model: 'm', max_tokens: 8, messages: [{ role: 'user', content: [b] }] }).messages;

  const text = mk({ type: 'tool_result', tool_use_id: 'toolu_a1', content: '25℃ 晴' });
  check('文本结果 → tool 消息，tool_call_id 配对',
    text.length === 1 && text[0].role === 'tool' && text[0].tool_call_id === 'toolu_a1' && text[0].content === '25℃ 晴', text);

  const err = mk({ type: 'tool_result', tool_use_id: 't', content: 'connection refused', is_error: true });
  check('★ is_error → 显式 [tool_error] 标记（否则模型把失败当正常结果）',
    err[0].content === '[tool_error] connection refused', err[0].content);
  const errEmpty = mk({ type: 'tool_result', tool_use_id: 't', is_error: true });
  check('★ is_error 且无内容 → [tool_error] 而不是 (ok)', errEmpty[0].content === '[tool_error]', errEmpty[0].content);
  const okEmpty = mk({ type: 'tool_result', tool_use_id: 't', content: '' });
  check('成功但无内容 → (ok)（老行为不变）', okEmpty[0].content === '(ok)');

  const blocks = mk({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] });
  check('多文本块 → 换行拼接', blocks[0].content === '第一行\n第二行', blocks[0].content);
}

/* ═══════ 4. ★ 工具结果里的图片（本轮重点） ═══════ */
function testToolResultImage() {
  G('4. ★ tool_result 带图片：不能塞进 tool 消息，改跟在后面的 user 消息');
  const out = api.anthropicToOpenAI({
    model: 'm', max_tokens: 64,
    messages: [{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_s1', content: [{ type: 'text', text: '截图完成' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
        { type: 'tool_result', tool_use_id: 'toolu_s2', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/b.png' } }] },
      ],
    }],
  });
  const msgs = out.messages;
  check('两条 tool_result → 两条 tool 消息（各自配对 id）',
    msgs[0].role === 'tool' && msgs[0].tool_call_id === 'toolu_s1' && msgs[1].role === 'tool' && msgs[1].tool_call_id === 'toolu_s2',
    msgs.map((m) => m.role));
  check('tool 消息的 content 是**字符串**（OpenAI 的 tool 消息只允许文本部件，塞数组会被上游 400）',
    typeof msgs[0].content === 'string' && typeof msgs[1].content === 'string', msgs.map((m) => typeof m.content));
  check('文字部分没丢', msgs[0].content === '截图完成' && msgs[1].content === '(ok)', msgs.map((m) => m.content));
  const imgMsg = msgs[2];
  check('图片补在紧随其后的 user 消息里', imgMsg && imgMsg.role === 'user', msgs.map((m) => m.role));
  check('★ base64 图 → data URL（字节零改动）',
    imgMsg.content[1].image_url.url === 'data:image/png;base64,' + PNG, imgMsg.content);
  check('★ url 图 → 直链', imgMsg.content[2].image_url.url === 'https://example.com/b.png', imgMsg.content);
  check('带 `[tool_result image]` 锚点，模型知道这图属于工具结果', imgMsg.content[0].type === 'text' && imgMsg.content[0].text === '[tool_result image]');
  check('★ 这种形态能被「图片能力门」识别（含图 → 只走 openai 渠道）', api.bodyHasImages(out) === true);

  const noImg = api.anthropicToOpenAI({
    model: 'm', max_tokens: 8,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: {} }] }] }],
  });
  check('空 source 不额外产出 user 消息（宁少一块，不产空图）', noImg.messages.length === 1, noImg.messages);
}

/* ═══════ 5. 响应侧：tool_calls → tool_use ═══════ */
function testResponse() {
  G('5. OpenAI tool_calls → Anthropic tool_use（非流式）');
  const oai = {
    id: 'chatcmpl-1', model: 'up-model',
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '我来查', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }] } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 } },
  };
  const r = api.openAIToAnthropicResponse(oai, 'claude-x');
  check('文本块在前、tool_use 块在后', r.content[0].type === 'text' && r.content[1].type === 'tool_use', r.content);
  check('tool_use 的 id / name / input 正确',
    r.content[1].id === 'call_1' && r.content[1].name === 'get_weather' && JSON.stringify(r.content[1].input) === '{"city":"上海"}', r.content[1]);
  check("stop_reason: tool_calls → 'tool_use'", r.stop_reason === 'tool_use');
  check('usage 映射（含 cached_tokens → cache_read_input_tokens）',
    r.usage.input_tokens === 11 && r.usage.output_tokens === 7 && r.usage.cache_read_input_tokens === 5, r.usage);
  check('非法字符的 id 被清洗成 Anthropic 允许的字符集',
    /^[A-Za-z0-9_-]+$/.test(api.openAIToAnthropicResponse({
      choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call/1 x', function: { name: 'f', arguments: '{}' } }] } }],
    }, 'm').content[0].id));
  check("参数不是合法 JSON 时退化成 {} 而不是崩",
    JSON.stringify(api.openAIToAnthropicResponse({
      choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{"city":' } }] } }],
    }, 'm').content[0].input) === '{}');
  check('无工具时 stop_reason: length → max_tokens',
    api.openAIToAnthropicResponse({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }, 'm').stop_reason === 'max_tokens');
}

/* ═══════ 6. 流式：tool_calls 增量 → Anthropic SSE 事件序列 ═══════ */
function testStream() {
  G('6. 流式 tool_calls → content_block_start / input_json_delta / stop');
  const chunks = [
    { choices: [{ delta: { role: 'assistant', content: '查一下：' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"上海"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
  ];
  const evs = [...api.openAIStreamToAnthropicSSE(chunks, 'claude-x')];
  const names = evs.map((e) => e.event);
  check('事件序列：message_start → 文本块 → 工具块 → message_delta → message_stop',
    names[0] === 'message_start' && names[names.length - 2] === 'message_delta' && names[names.length - 1] === 'message_stop', names);
  const tb = evs.find((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use');
  check('★ tool_use 块起始带 input:{}（官方 SDK 以它为累积 base）',
    !!tb && JSON.stringify(tb.data.content_block.input) === '{}' && tb.data.content_block.name === 'get_weather', tb && tb.data.content_block);
  const args = evs.filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
  check('★ 分片参数拼回来是完整合法 JSON',
    args === '{"city":"上海"}' && (() => { try { JSON.parse(args); return true; } catch { return false; } })(), args);
  const idx = tb.data.index;
  check('工具块有对应的 content_block_stop',
    evs.some((e) => e.event === 'content_block_stop' && e.data.index === idx));
  const md = evs.find((e) => e.event === 'message_delta');
  check("message_delta 的 stop_reason 是 'tool_use'", md.data.delta.stop_reason === 'tool_use', md.data.delta);
  check('usage 透传', md.data.usage.output_tokens === 3, md.data.usage);
  check('文本块也正确闭合',
    evs.some((e) => e.event === 'content_block_stop' && e.data.index !== idx));
}

/* ═══════ 6B. ★ 有状态转换器：按路由的真实用法逐行喂 ═══════ */
function testStatefulStream() {
  G('6B. ★ 有状态转换器（逐行喂 = 路由的实际用法）');
  const conv = api.createAnthropicStreamConverter('claude-x');
  let evs = conv.start();
  const push = (c) => { const o = conv.push(c); evs = evs.concat(o); return o; };

  check('start() 只发一次 message_start', evs.length === 1 && evs[0].event === 'message_start', evs.map((e) => e.event));
  push({ choices: [{ delta: { content: '查一下：' } }] });
  const firstTool = push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'get_weather', arguments: '{"city"' } }] } }] });
  const secondTool = push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"上海"}' } }] } }] });
  check('tool_use 的 content_block_start 只出现一次（旧写法每行都会重开一块）',
    firstTool.filter((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use').length === 1 &&
    secondTool.filter((e) => e.event === 'content_block_start').length === 0,
    [firstTool.map((e) => e.event), secondTool.map((e) => e.event)]);
  check('★ 参数分片跨行累积在同一个块里（第二行只发 delta）',
    secondTool.length === 0, secondTool.map((e) => e.event));

  const closing = conv.end();
  const args = evs.concat(closing).filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
  check('★ 收尾时把累计参数一次发完且是合法 JSON', (() => { try { return JSON.parse(args).city === '上海'; } catch { return false; } })(), args);
  check('end() 幂等（[DONE] 与收尾钩子都调也不会重复发包）', conv.end().length === 0);
  check('收尾事件顺序：关块 → message_delta → message_stop',
    closing[0].event === 'content_block_stop' && closing[closing.length - 2].event === 'message_delta' && closing[closing.length - 1].event === 'message_stop',
    closing.map((e) => e.event));

  // 并行工具调用：两个 index → 两个独立块、索引不重叠
  const c2 = api.createAnthropicStreamConverter('m');
  c2.start();
  const p1 = c2.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'f1', arguments: '{}' } }, { index: 1, id: 'b', function: { name: 'f2', arguments: '{}' } }] } }] });
  const starts = p1.filter((e) => e.event === 'content_block_start');
  check('并行工具调用 → 两个块且索引不同', starts.length === 2 && starts[0].data.index !== starts[1].data.index,
    starts.map((e) => e.data.index));
  check('两个块都能被收尾关闭', c2.end().filter((e) => e.event === 'content_block_stop').length === 2);
}

/* ═══════ 7. ★ 核心性质：id 往返配对 ═══════ */
function testRoundTrip() {
  G('7. ★ id 往返：响应给出的 tool_use.id 必须能被下一轮回传对上 tool_call_id');
  const oai = { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call_abc/123', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }] } }] };
  const resp = api.openAIToAnthropicResponse(oai, 'm');
  const tu = resp.content.find((c) => c.type === 'tool_use');

  // 客户端拿到的 id 原样回传（Claude SDK 就是这么做的）
  const back = api.anthropicToOpenAI({
    model: 'm', max_tokens: 9,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: '25℃' }] },
    ],
  });
  check('assistant 侧 id 一致', back.messages[0].tool_calls[0].id === tu.id, [tu.id, back.messages[0].tool_calls[0].id]);
  check('user 侧 tool_call_id 一致（配对不裂）', back.messages[1].tool_call_id === tu.id, [tu.id, back.messages[1].tool_call_id]);
  check('清洗后的 id 在 Anthropic 允许的字符集内', /^[A-Za-z0-9_-]+$/.test(tu.id), tu.id);
}

/* ═══════ 8. 对照组：证明本测试抓得住"只抽文本"的旧写法（防恒真） ═══════ */
function testControl() {
  G('8. 对照组（整改前的写法，必须被本测试抓住）');
  const oldMap = (blocks) => blocks.map((c) => (c.type === 'text' ? c.text : '')).join('\n').trim();   /* 旧实现 */
  const got = oldMap([{ type: 'text', text: '截图完成' }, { type: 'image', source: { data: PNG } }]);
  check('旧写法把工具结果里的图片丢了（只剩文字）→ 本测试具备捕捉能力', got === '截图完成' && !got.includes(PNG), got);
  check('旧写法把 is_error 当普通结果（模型无法知道工具失败了）',
    oldMap([{ type: 'text', text: 'connection refused' }]) === 'connection refused');
  const oldChoice = { auto: 'auto', any: 'required', tool: 'function' };   /* 旧实现只认三种 */
  check('旧写法不认 tool_choice none（会被静默忽略）', oldChoice['none'] === undefined);
}

/* ═══════ 9. 装配守卫 ═══════ */
function testWiring() {
  G('9. 装配守卫');
  check('Anthropic 路由用的是这套转换（anthropicToOpenAI 有真实调用点）',
    /const oaiBody = sanitizeOpenAIToolIds\(anthropicToOpenAI\(body\)\)/.test(src));
  check('刻意丢弃的块有显式注释（防止后人当成漏了而乱补）', src.includes('刻意丢弃的块'));
  check('Anthropic 路由带图片能力门（工具结果里的图同样受它保护）',
    /candidates = filterCandidatesForImages\(candidates, oaiBody\)/.test(src));
}

testTools();
testToolUse();
testToolResult();
testToolResultImage();
testResponse();
testStream();
testStatefulStream();
testRoundTrip();
testControl();
testWiring();

console.log('\n' + '─'.repeat(58));
console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
process.exit(fail ? 1 : 0);
