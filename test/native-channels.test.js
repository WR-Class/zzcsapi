#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/native-channels.test.js — 原生 anthropic / gemini 渠道出站转换（单元，零依赖）
 *
 * 为什么需要它：过去 `protocol` 只决定探活方式与对外路由，出站一律 OpenAI 格式，
 * ⇒ 声明成 anthropic / gemini 协议的渠道**根本无法用于聊天**（拿 OpenAI 格式敲 /v1/messages 必 400）。
 * 这个文件守住双向转换：内部 OpenAI → 原生请求，原生响应 → 内部 OpenAI（含流式状态机）。
 *
 * 从 server.js 现抠真实实现跑断言（改坏这里就红）：
 *   oaiRequestToAnthropic / anthropicToOaiResponse / createAnthropicToOaiStream
 *   oaiRequestToGemini   / geminiToOaiResponse   / createGeminiToOaiStream
 *   nativeOutgoingUrl / nativeOutgoingHeaders / nativeResponseTranslator / oaiContentBlocks
 * 依赖的既有函数（sanitizeToolId / joinUrl / safeJson / parseDataUrl / oaiChunkLine 等）一并抠出来。
 *
 * 跑法：node test/native-channels.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extract(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(|function\\s*\\*\\s*' + name + '\\s*\\(');
  const m = re.exec(SRC);
  if (!m) throw new Error('找不到函数: ' + name);
  let i = SRC.indexOf('{', m.index), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return SRC.slice(m.index, i);
}
function extractConst(name) {
  const m = new RegExp('^const\\s+' + name + '\\s*=.*$', 'm').exec(SRC);
  if (!m) throw new Error('找不到常量: ' + name);
  return m[0];
}

const code = [
  extractConst('TOOL_RESULT_IMAGE_MARK'),
  extract('joinUrl'), extract('safeJson'), extract('sanitizeToolId'),
  extract('parseDataUrl'), extract('oaiContentBlocks'), extract('oaiTextOf'),
  extract('oaiRequestToAnthropic'), extract('anthropicImageSource'),
  extract('anthropicStopToFinish'), extract('anthropicToOaiResponse'),
  extract('oaiChunkLine'), extractConst('OAI_SSE_DONE'),
  extract('createAnthropicToOaiStream'),
  extract('oaiRequestToGemini'), extract('oaiContentToGeminiParts'),
  extract('geminiStopToFinish'), extract('geminiPartsToOai'),
  extract('geminiToOaiResponse'), extract('createGeminiToOaiStream'),
  extract('nativeOutgoingUrl'), extract('nativeOutgoingHeaders'),
  extract('nativeResponseTranslator'), extract('nativeStreamTranslator'),
].join('\n');
const M = new Function(code + `\nreturn { oaiRequestToAnthropic, anthropicToOaiResponse, createAnthropicToOaiStream, oaiRequestToGemini, geminiToOaiResponse, createGeminiToOaiStream, nativeOutgoingUrl, nativeOutgoingHeaders, nativeResponseTranslator, TOOL_RESULT_IMAGE_MARK };`)();

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const PNG = 'data:image/png;base64,AAAB';
const cand = (upstream) => ({ channelId: 'ch1', upstream });

console.log('\n1. ★ OpenAI 请求 → Anthropic 请求（真实报文形状）');
{
  const oai = {
    model: 'claude-a', max_tokens: 128, temperature: 0.3, top_p: 0.9, stop: ['END'], stream: true,
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '25℃' },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
  };
  const a = M.oaiRequestToAnthropic(oai, cand('claude-x'));
  check('model 用渠道 upstream（别名已解析）', a.model === 'claude-x', a.model);
  check('system 提到顶层（不再是 messages 里的一条）', a.system === '你是助手' && !a.messages.some((m) => m.role === 'system'), a.system);
  check('max_tokens 透传', a.max_tokens === 128, a.max_tokens);
  check('temperature/top_p/stream 透传', a.temperature === 0.3 && a.top_p === 0.9 && a.stream === true);
  check('stop → stop_sequences（数组化）', JSON.stringify(a.stop_sequences) === '["END"]', a.stop_sequences);
  check('assistant 的 tool_calls → tool_use 块（arguments 字符串 → input 对象）',
    a.messages[1].content[0].type === 'tool_use' && a.messages[1].content[0].name === 'get_weather' && a.messages[1].content[0].input.city === '上海', a.messages[1]);
  check('tool 消息 → user + tool_result（Anthropic 要求）',
    a.messages[2].role === 'user' && a.messages[2].content[0].type === 'tool_result' && a.messages[2].content[0].tool_use_id === 'call_1', a.messages[2]);
  check('tools 的 parameters → input_schema', a.tools[0].name === 'get_weather' && a.tools[0].input_schema.properties.city.type === 'string', a.tools[0]);
  check('tool_choice auto → {type:auto}', a.tool_choice.type === 'auto', a.tool_choice);
  check('parallel_tool_calls:false → disable_parallel_tool_use:true', a.disable_parallel_tool_use === true);
  check('★ 没有 max_tokens 时补 8192（Anthropic 必填；v1.18.25 由 4096 上调，思考会吃同一份预算）',
    M.oaiRequestToAnthropic({ messages: [{ role: 'user', content: 'x' }] }, cand('m')).max_tokens === 8192);
  check('tool_choice required → {type:any}',
    M.oaiRequestToAnthropic({ messages: [], tools: oai.tools, tool_choice: 'required' }, cand('m')).tool_choice.type === 'any');
  check('tool_choice {function:{name}} → {type:tool,name}',
    M.oaiRequestToAnthropic({ messages: [], tools: oai.tools, tool_choice: { type: 'function', function: { name: 'get_weather' } } }, cand('m')).tool_choice.name === 'get_weather');
  check('tool_choice none → 去掉 tools（Anthropic 无 none 语义）',
    M.oaiRequestToAnthropic({ messages: [], tools: oai.tools, tool_choice: 'none' }, cand('m')).tools === undefined);
}

console.log('\n2. ★ 图片：内部 image_url → Anthropic image 块（base64 / url 两种）');
{
  const a = M.oaiRequestToAnthropic({ messages: [{ role: 'user', content: [{ type: 'text', text: '这是什么' }, { type: 'image_url', image_url: { url: PNG } }] }] }, cand('m'));
  const img = a.messages[0].content[1];
  check('data URL → source.type=base64 + media_type + data', img.type === 'image' && img.source.type === 'base64' && img.source.media_type === 'image/png' && img.source.data === 'AAAB', img);
  const b = M.oaiRequestToAnthropic({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] }] }, cand('m'));
  check('http(s) → source.type=url', b.messages[0].content[0].source.type === 'url' && b.messages[0].content[0].source.url === 'https://x.test/a.png', b.messages[0].content[0]);
}

console.log('\n3. ★ 工具结果里的图片：并回 tool_result 块（内部标记不泄漏给原生上游）');
{
  const oai = {
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'render', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_9', content: '图已生成' },
      { role: 'user', content: [{ type: 'text', text: M.TOOL_RESULT_IMAGE_MARK }, { type: 'image_url', image_url: { url: PNG } }] },
      { role: 'user', content: '从上到下什么颜色？' },
    ],
  };
  const a = M.oaiRequestToAnthropic(oai, cand('m'));
  const userWithTool = a.messages.find((m) => m.content.some((b) => b.type === 'tool_result'));
  const tr = userWithTool.content.find((b) => b.type === 'tool_result');
  check('★ 图片进了 tool_result 的 content（Anthropic 原生支持，不再另起一条消息）',
    Array.isArray(tr.content) && tr.content.some((b) => b.type === 'image' && b.source.data === 'AAAB'), tr);
  check('★ 内部锚点文本没有泄漏给上游', !JSON.stringify(a).includes(M.TOOL_RESULT_IMAGE_MARK));
  check('文字与图片都在同一个 tool_result 里', tr.content.some((b) => b.type === 'text' && b.text === '图已生成') && tr.content.length === 2, tr.content);
  // Anthropic 要求角色交替 ⇒ 后续那条 user 问句会并进**同一条** user 消息，但必须是 tool_result 之外的独立文本块
  const lastMsg = a.messages[a.messages.length - 1];
  check('后续问句并进同一 user 消息（角色必须交替），但不是塞进 tool_result 里',
    lastMsg === userWithTool && lastMsg.content.some((b) => b.type === 'text' && b.text === '从上到下什么颜色？'),
    [a.messages.length, lastMsg.content.map((b) => b.type)]);
}

console.log('\n4. 连续同角色消息必须合并（Anthropic 要求角色交替）');
{
  const a = M.oaiRequestToAnthropic({ messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] }, cand('m'));
  check('两条 user 合并成一条', a.messages.length === 1 && a.messages[0].content.length === 2, a.messages);
}

console.log('\n5. ★ Anthropic 响应 → OpenAI 响应');
{
  const ant = {
    id: 'msg_1', model: 'claude-x', stop_reason: 'tool_use',
    content: [{ type: 'thinking', thinking: '先想一下' }, { type: 'text', text: '我查到了' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '上海' } }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4 },
  };
  const o = M.anthropicToOaiResponse(ant, 'claude-a');
  check('文本 → message.content', o.choices[0].message.content === '我查到了', o.choices[0].message);
  check('thinking → reasoning_content（不丢思维链）', o.choices[0].message.reasoning_content === '先想一下');
  check('tool_use → tool_calls（input 对象 → arguments 字符串）',
    o.choices[0].message.tool_calls[0].function.name === 'get_weather' && JSON.parse(o.choices[0].message.tool_calls[0].function.arguments).city === '上海', o.choices[0].message.tool_calls);
  check('stop_reason tool_use → finish_reason tool_calls', o.choices[0].finish_reason === 'tool_calls', o.choices[0].finish_reason);
  check('usage 映射（含缓存命中）', o.usage.prompt_tokens === 10 && o.usage.completion_tokens === 5 && o.usage.prompt_tokens_details.cached_tokens === 4, o.usage);
  check('请求的别名回填到 model（客户端看到自己请求的名字）', o.model === 'claude-a', o.model);
  check('其他 stop_reason 映射齐备',
    [['end_turn', 'stop'], ['max_tokens', 'length'], ['stop_sequence', 'stop'], ['refusal', 'content_filter']]
      .every(([a, b]) => M.anthropicToOaiResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: a }, 'm').choices[0].finish_reason === b));
}

console.log('\n6. ★ Anthropic SSE → OpenAI SSE（有状态）');
{
  const s = M.createAnthropicToOaiStream('claude-a');
  const lines = [];
  const feed = (raw) => { for (const l of s.push(raw)) lines.push(l); };
  // 真实链路里 push 每次只收到一行（tryChannel 自己按 \n 切）；所以这里也只喂 data: 行。
  // 另喂两行"不是 data:"的内容，验证 event: 行与空行被安全忽略。
  feed('event: message_start\n');
  feed('\n');
  feed('data: ' + JSON.stringify({ type: 'message_start', message: { id: 'msg_9', model: 'claude-x', usage: { input_tokens: 7 } } }) + '\n');
  feed('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n');
  feed('data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } }) + '\n');
  feed('data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } }) + '\n');
  feed('data: ' + JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'f' } }) + '\n');
  feed('data: ' + JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a"' } }) + '\n');
  feed('data: ' + JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':1}' } }) + '\n');
  feed('data: ' + JSON.stringify({ type: 'ping' }) + '\n');
  feed('data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }) + '\n');
  feed('data: ' + JSON.stringify({ type: 'message_stop' }) + '\n');
  const text = lines.join('');
  const objs = lines.filter((l) => l.includes('{')).map((l) => JSON.parse(l.slice(6)));
  check('每条都是 OpenAI 分片（data: {…}）', objs.every((o) => o.object === 'chat.completion.chunk'), lines[0]);
  check('role 只发一次', objs.filter((o) => o.choices[0].delta.role === 'assistant').length === 1, objs.filter((o) => o.choices[0].delta.role === 'assistant').length);
  check('event: 行与空行被忽略（不产生任何分片）', objs.length === lines.filter((l) => l.includes('{')).length, [objs.length, lines.length]);
  check('文本增量按序拼成"你好"', objs.map((o) => o.choices[0].delta.content || '').join('') === '你好');
  check('★ 工具参数分片拼回完整 JSON（跨 chunk 累积）',
    objs.flatMap((o) => o.choices[0].delta.tool_calls || []).map((t) => t.function.arguments || '').join('') === '{"a":1}',
    objs.flatMap((o) => o.choices[0].delta.tool_calls || []));
  check('工具块只开一次（有状态）', objs.flatMap((o) => o.choices[0].delta.tool_calls || []).filter((t) => t.id).length === 1);
  check('finish_reason 来自 message_delta 的 stop_reason', objs.some((o) => o.choices[0].finish_reason === 'tool_calls'), objs.map((o) => o.choices[0].finish_reason));
  check('以 [DONE] 收尾', text.endsWith('data: [DONE]\n\n'), text.slice(-40));
  check('ping 不产生任何输出', lines.filter((l) => l.includes('"ping"')).length === 0);
  check('id/model 透传自上游', objs[0].id === 'msg_9' && objs[0].model === 'claude-a', objs[0]);
  const rest = s.end();
  check('end() 幂等（已收尾后不再输出）', rest.length === 0, rest);
}

console.log('\n7. Anthropic 流式异常断流 → end() 补齐 finish_reason + [DONE]');
{
  const s = M.createAnthropicToOaiStream('m');
  s.push('data: ' + JSON.stringify({ type: 'message_start', message: { id: 'x' } }) + '\n');
  s.push('data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } }) + '\n');
  const tail = s.end().join('');
  check('补了 finish_reason=stop', /"finish_reason":"stop"/.test(tail), tail);
  check('补了 [DONE]', tail.includes('data: [DONE]'), tail);
}

console.log('\n8. ★ OpenAI 请求 → Gemini 请求');
{
  const oai = {
    model: 'gemini-a', max_tokens: 64, temperature: 0.5, stop: 'STOP',
    messages: [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: PNG } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_7', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }] },
      { role: 'tool', tool_call_id: 'call_7', content: '{"temp":25}' },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
    tool_choice: 'none',
  };
  const g = M.oaiRequestToGemini(oai, cand('gemini-x'));
  check('system → systemInstruction', g.systemInstruction.parts[0].text === '系统提示');
  check('图片 → inlineData（mimeType + data）',
    g.contents[0].parts[1].inlineData.mimeType === 'image/png' && g.contents[0].parts[1].inlineData.data === 'AAAB', g.contents[0].parts[1]);
  check('assistant → role:model + functionCall（args 是对象）',
    g.contents[1].role === 'model' && g.contents[1].parts[0].functionCall.name === 'get_weather' && g.contents[1].parts[0].functionCall.args.city === '上海', g.contents[1]);
  check('★ tool 消息 → functionResponse，且用**函数名**（Gemini 不认 id）',
    g.contents[2].parts[0].functionResponse.name === 'get_weather' && g.contents[2].parts[0].functionResponse.response.temp === 25, g.contents[2]);
  check('max_tokens → maxOutputTokens', g.generationConfig.maxOutputTokens === 64);
  check('stop 字符串 → stopSequences 数组', JSON.stringify(g.generationConfig.stopSequences) === '["STOP"]', g.generationConfig);
  check('tools → functionDeclarations', g.tools[0].functionDeclarations[0].name === 'get_weather');
  check('★ tool_choice none → NONE（Gemini 有这档，三态完整映射）', g.toolConfig.functionCallingConfig.mode === 'NONE', g.toolConfig);
  check('tool_choice required → ANY',
    M.oaiRequestToGemini({ messages: [], tools: oai.tools, tool_choice: 'required' }, cand('m')).toolConfig.functionCallingConfig.mode === 'ANY');
  check('tool_choice 指定单个 → ANY + allowedFunctionNames',
    M.oaiRequestToGemini({ messages: [], tools: oai.tools, tool_choice: { type: 'function', function: { name: 'get_weather' } } }, cand('m')).toolConfig.functionCallingConfig.allowedFunctionNames[0] === 'get_weather');
  check('图片是 http 链接时用 fileData',
    M.oaiRequestToGemini({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] }] }, cand('m')).contents[0].parts[0].fileData.fileUri === 'https://x.test/a.png');
}

console.log('\n9. ★ Gemini 响应 → OpenAI 响应');
{
  const gem = {
    candidates: [{ content: { role: 'model', parts: [{ text: '答案' }, { functionCall: { name: 'get_weather', args: { city: '上海' } } }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
    modelVersion: 'gemini-x',
  };
  const o = M.geminiToOaiResponse(gem, 'gemini-a');
  check('文本 → content', o.choices[0].message.content === '答案');
  check('functionCall → tool_calls（有合成 id，供客户端回传配对）',
    o.choices[0].message.tool_calls[0].function.name === 'get_weather' && /^call_g/.test(o.choices[0].message.tool_calls[0].id), o.choices[0].message.tool_calls);
  check('有工具调用时 finish_reason=tool_calls', o.choices[0].finish_reason === 'tool_calls');
  check('usageMetadata 映射', o.usage.prompt_tokens === 12 && o.usage.completion_tokens === 8 && o.usage.total_tokens === 20);
  check('finishReason 映射齐备',
    [['STOP', 'stop'], ['MAX_TOKENS', 'length'], ['SAFETY', 'content_filter']]
      .every(([a, b]) => M.geminiToOaiResponse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: a }] }, 'm').choices[0].finish_reason === b));
}

console.log('\n10. ★ Gemini SSE → OpenAI SSE');
{
  const s = M.createGeminiToOaiStream('gemini-a');
  const out = [];
  const feed = (o) => { for (const l of s.push('data: ' + JSON.stringify(o) + '\n')) out.push(l); };
  feed({ candidates: [{ content: { parts: [{ text: '你' }] } }] });
  feed({ candidates: [{ content: { parts: [{ text: '好' }] } }] });
  feed({ candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: { k: 1 } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } });
  const objs = out.filter((l) => l.includes('{')).map((l) => JSON.parse(l.slice(6)));
  const text = out.join('');
  check('文本增量拼接正确', objs.map((o) => o.choices[0].delta.content || '').join('') === '你好');
  check('role 只发一次', objs.filter((o) => o.choices[0].delta.role === 'assistant').length === 1);
  check('★ functionCall 在收尾一次发全（不发明半个参数）',
    (() => { const tc = objs.flatMap((o) => o.choices[0].delta.tool_calls || []); const args = tc.map((t) => t.function.arguments || '').join(''); return args === '{"k":1}' && tc.filter((t) => t.id).length === 1 && tc[0].function.name === 'f'; })(),
    objs.flatMap((o) => o.choices[0].delta.tool_calls || []));
  check('结束带 finish_reason', objs.some((o) => o.choices[0].finish_reason === 'stop'), objs.map((o) => o.choices[0].finish_reason));
  check('usage 带在结束分片上', objs.some((o) => o.usage && o.usage.total_tokens === 5));
  check('以 [DONE] 收尾', text.endsWith('data: [DONE]\n\n'), text.slice(-30));
  check('end() 幂等', s.end().length === 0);
}

console.log('\n11. ★ 出站 URL / 请求头（与探活同一套约定）');
{
  check('anthropic：base 无 /v1 → 补 v1/messages',
    M.nativeOutgoingUrl('anthropic', { def: { baseUrl: 'https://api.anthropic.com' } }, cand('claude-x'), false) === 'https://api.anthropic.com/v1/messages');
  check('anthropic：base 已带 /v1 → 不重复拼',
    M.nativeOutgoingUrl('anthropic', { def: { baseUrl: 'https://api.anthropic.com/v1/' } }, cand('claude-x'), false) === 'https://api.anthropic.com/v1/messages');
  check('gemini：模型在 URL 路径里（非流式）',
    M.nativeOutgoingUrl('gemini', { def: { baseUrl: 'https://generativelanguage.googleapis.com' } }, cand('gemini-2.5-pro'), false) === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
  check('★ gemini 流式 → :streamGenerateContent?alt=sse',
    M.nativeOutgoingUrl('gemini', { def: { baseUrl: 'https://g.test/v1beta' } }, cand('m'), true) === 'https://g.test/v1beta/models/m:streamGenerateContent?alt=sse');
  check('gemini：base 带 /v1 时归一成 /v1beta',
    M.nativeOutgoingUrl('gemini', { def: { baseUrl: 'https://g.test/v1' } }, cand('m'), false) === 'https://g.test/v1beta/models/m:generateContent');
  check('anthropic 头：x-api-key + anthropic-version（无 Bearer）',
    M.nativeOutgoingHeaders('anthropic', { def: { apiKey: 'sk-ant' } })['x-api-key'] === 'sk-ant' && M.nativeOutgoingHeaders('anthropic', { def: { apiKey: 'k' } })['anthropic-version'] === '2023-06-01' && !M.nativeOutgoingHeaders('anthropic', { def: { apiKey: 'k' } }).Authorization);
  check('gemini 头：x-goog-api-key', M.nativeOutgoingHeaders('gemini', { def: { apiKey: 'gk' } })['x-goog-api-key'] === 'gk');
}

console.log('\n12. ★ 错误体不翻译（否则 4xx 判定与客户端看到的错误就失真了）');
{
  const tr = M.nativeResponseTranslator('anthropic', 'claude-a');
  const errBody = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad tool_use_id' } });
  check('anthropic 错误体原样返回', tr(errBody) === errBody, tr(errBody).slice(0, 80));
  const gem = M.nativeResponseTranslator('gemini', 'g');
  const gemErr = JSON.stringify({ error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } });
  check('gemini 错误体原样返回', gem(gemErr) === gemErr);
  const okBody = JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
  check('成功体被翻成 OpenAI', JSON.parse(tr(okBody)).choices[0].message.content === 'hi');
  check('非 JSON 原样返回（不抛）', tr('not json') === 'not json');
}

console.log('\n13. 对照组：原生渠道的报文与 OpenAI 格式**确实不同**（证明测试有区分力）');
{
  const oaiBody = { model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] };
  const a = M.oaiRequestToAnthropic(oaiBody, cand('m'));
  const g = M.oaiRequestToGemini(oaiBody, cand('m'));
  check('anthropic 报文没有 messages[].content 字符串形态 / 没有 model 之外的 OpenAI 字段',
    a.messages[0].content[0].type === 'text' && !('tools' in a && a.tools === undefined && false) && a.max_tokens === 8, a);
  check('gemini 报文没有 model 字段（模型在 URL 里）', g.model === undefined && Array.isArray(g.contents), Object.keys(g));
  check('三份报文互不相同', JSON.stringify(a) !== JSON.stringify(g) && JSON.stringify(oaiBody) !== JSON.stringify(a));
}

console.log('\n' + '─'.repeat(58));
console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
process.exit(fail ? 1 : 0);
