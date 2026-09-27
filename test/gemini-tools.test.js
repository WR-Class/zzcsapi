#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/gemini-tools.test.js — Gemini **客户端路由**的工具调用透传（单元级，零依赖）
 *                                                              PT33 的回归
 *
 * 问题（PT33）：`/gemini/...` 这条**入站**路由只会映射文本 ——
 *   · `geminiToOpenAI`（客户端 → 内部 OpenAI）把 `functionCall` / `functionResponse` 降级成
 *     一段可读文本，`tools` 虽已映射但 `tool_choice` 读的是 **OpenAI 的字段名**（真 Gemini 客户端
 *     从不发它），于是 `toolConfig.functionCallingConfig` 的 ANY / NONE 形同虚设；
 *   · `openAIToGeminiResponse`（内部 → 客户端）只取 `choices[0].message.content`，
 *     `openAIStreamToGeminiSSE` 只取 `delta.content` —— 客户端**永远拿不到 `functionCall`**。
 * 于是"用 Gemini 原生 SDK 的客户端"根本无法使用工具调用（OpenAI / Anthropic 两条路由一直是好的）。
 *
 * 本轮的契约（红字部分是关键判据）：
 *   · `functionCall` → 真的 `assistant.tool_calls`（**不再**降级文本）；
 *   · `functionResponse` → `role:'tool'` 消息，且 `tool_call_id` 与前面那条 `tool_calls[].id` **严格配对**
 *     （Gemini 认函数名不认 id，所以入站这层替它合成 id、用同名 FIFO 队列配对）；
 *   · **配不上**的 `functionResponse`（无状态客户端只回结果）→ 退回文本形态，**绝不**硬造 tool_call_id
 *     （否则上游会因"有 tool 消息却没有配对的 assistant.tool_calls"直接 400）；
 *   · 响应侧：`tool_calls` → `functionCall` 部件（`args` 解析回对象），`finishReason` 按 STOP 收尾；
 *   · 流式：OpenAI 按 index 拆片的 `tool_calls` **必须攒成完整对象**再发一帧（Gemini 的 args 不能是半截 JSON）；
 *   · `toolConfig.functionCallingConfig` 三态 AUTO / ANY / NONE → `auto` / `required`（单一白名单时强制该函数）/ `none`；
 *   · **兼容性**：工具仿真链（notion / genspark 这些没有工具能力的渠道）照旧拿得到可读文本 ——
 *     这里直接调 `tool-emu.renderEmulatedMessages` 证明，而不是口头声明。
 *
 * 跑法：node test/gemini-tools.test.js   （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const toolEmu = require(path.join(ROOT, 'tool-emu.js'));

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 260) : '')); }
};
const G = (t) => console.log('\n' + t);

/* 从真实 server.js 里抠函数（大括号配对；与本仓库其它回归同一套做法） */
function extract(name) {
  const at = SRC.search(new RegExp('(?:^|\\n)(?:async\\s+)?function\\s+' + name + '\\s*\\('));
  if (at < 0) throw new Error('server.js 里找不到函数 ' + name);
  let depth = 0, end = -1;
  for (let i = SRC.indexOf('{', at); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
  }
  return SRC.slice(at, end);
}
// extract() 返回的就是**完整的函数声明**（含 function 关键字与大括号），所以直接拼进 Function 体；
// 不要再用 'function x(...) { ' + extract('x') + ' }' 包一层——那会声明出一个同名的空壳把真的挡住。
const api = new Function(
  extract('oaiContentBlocks') + '\n' +
  extract('oaiTextOf') + '\n' +
  extract('geminiToOpenAI') + '\n' +
  extract('openAIToGeminiResponse') + '\n' +
  extract('openAIStreamToGeminiSSE') + '\n' +
  'return { geminiToOpenAI, openAIToGeminiResponse, openAIStreamToGeminiSSE };'
)();

const DECL = [{ functionDeclarations: [{ name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } }, { name: 'get_time', description: '查时间', parameters: { type: 'object', properties: {} } }] }];

/* ═══════════════════ 0. 装配守卫 ═══════════════════ */
G('0. 装配守卫（源码里必须真的是这套接线）');
{
  check('server.js 定义了三个转换函数',
    /function geminiToOpenAI\(/.test(SRC) && /function openAIToGeminiResponse\(/.test(SRC) && /function openAIStreamToGeminiSSE\(/.test(SRC));
  check('★ 入站不再把 functionCall / functionResponse 降级成文本（PT33 的根因）',
    !/functionCall\) blocks\.push\(\{ type: 'text'/.test(SRC) && !/functionResponse\) blocks\.push\(\{ type: 'text'/.test(SRC));
  check('★ 响应侧真的读了 tool_calls（不再只取 content）',
    /function openAIToGeminiResponse[\s\S]{0,900}?msg\.tool_calls/.test(SRC));
  check('★ 流式侧真的读了 delta.tool_calls 且带跨 chunk 状态',
    /function openAIStreamToGeminiSSE\(chunks, state\)[\s\S]{0,700}?delta\.tool_calls|function openAIStreamToGeminiSSE\(chunks, state\)[\s\S]{0,900}?d\.tool_calls/.test(SRC));
  check('★ Gemini 路由把状态传下去了（否则分片参数攒不起来）',
    /geminiStreamState = \{\}/.test(SRC) && /openAIStreamToGeminiSSE\(\[j\], geminiStreamState\)/.test(SRC));
  check('★ tool_choice 读的是 Gemini 的 toolConfig（不再只读 OpenAI 的 body.tool_choice）',
    /toolConfig[\s\S]{0,200}?functionCallingConfig/.test(SRC) && /fccMode === 'ANY'/.test(SRC) && /fccMode === 'NONE'/.test(SRC));
}

/* ═══════════════════ 1. 入站：请求方向的工具调用 ═══════════════════ */
G('1. 入站 geminiToOpenAI：tools / toolConfig / functionCall / functionResponse');
{
  const b = api.geminiToOpenAI({ contents: [{ role: 'user', parts: [{ text: '上海天气？' }] }], tools: DECL }, 'm');
  check('tools[0].functionDeclarations → OpenAI tools（保留 description 与 parameters）',
    b.tools && b.tools.length === 2 && b.tools[0].type === 'function'
    && b.tools[0].function.name === 'get_weather' && b.tools[0].function.description === '查天气'
    && b.tools[0].function.parameters.properties.city.type === 'string', b.tools);
  check('★ 默认（没给 toolConfig）→ tool_choice 是 auto', b.tool_choice === 'auto', b.tool_choice);

  const none = api.geminiToOpenAI({ contents: [{ role: 'user', parts: [{ text: 'x' }] }], tools: DECL, toolConfig: { functionCallingConfig: { mode: 'NONE' } } }, 'm');
  check('★ toolConfig NONE → tool_choice none（老代码读 body.tool_choice，真客户端永远命中不到）', none.tool_choice === 'none', none.tool_choice);

  const any1 = api.geminiToOpenAI({ contents: [{ role: 'user', parts: [{ text: 'x' }] }], tools: DECL, toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_time'] } } }, 'm');
  check('★ ANY + 单一白名单 → 强制该函数（tool_choice 对象形态）',
    any1.tool_choice && any1.tool_choice.type === 'function' && any1.tool_choice.function.name === 'get_time', any1.tool_choice);
  check('★ ANY + 白名单时把工具集也收窄（比只写 required 更接近原意）',
    any1.tools.length === 1 && any1.tools[0].function.name === 'get_time', any1.tools.map((t) => t.function.name));

  const anyN = api.geminiToOpenAI({ contents: [{ role: 'user', parts: [{ text: 'x' }] }], tools: DECL, toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather', 'get_time'] } } }, 'm');
  check('ANY + 多个白名单 → required（OpenAI 表达不了"只准这几个"里的任选，有损但方向对）',
    anyN.tool_choice === 'required' && anyN.tools.length === 2, anyN.tool_choice);

  check('下划线字段名也认（function_calling_config / function_declarations 同一套双写）',
    api.geminiToOpenAI({ contents: [], tools: [{ function_declarations: [{ name: 'z', parameters: {} }] }], tool_config: { function_calling_config: { mode: 'NONE' } } }, 'm').tool_choice === 'none');
}

/* ═══════════════════ 2. 入站：工具回合的消息形态与 id 配对 ═══════════════════ */
G('2. 入站：functionCall → tool_calls、functionResponse → role:tool，且 id 严格配对');
{
  const b = api.geminiToOpenAI({
    contents: [
      { role: 'user', parts: [{ text: '上海和北京天气？' }] },
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: '上海' } } }, { functionCall: { name: 'get_weather', args: { city: '北京' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 31 } } }, { functionResponse: { name: 'get_weather', response: { temp: 24 } } }] },
    ],
  }, 'm');
  const asst = b.messages.find((m) => m.role === 'assistant');
  const tools = b.messages.filter((m) => m.role === 'tool');
  check('★ functionCall → assistant.tool_calls（不再是 JSON 文本块）',
    !!asst && Array.isArray(asst.tool_calls) && asst.tool_calls.length === 2
    && asst.tool_calls[0].type === 'function' && asst.tool_calls[0].function.name === 'get_weather'
    && asst.tool_calls[0].function.arguments === '{"city":"上海"}', asst);
  check('assistant 只有工具调用时 content 为 null（不是空字符串、也不是文本块）', asst.content === null, asst.content);
  check('★ functionResponse → role:\'tool\' 两条，且顺序与调用一致',
    tools.length === 2 && tools[0].content === '{"temp":31}' && tools[1].content === '{"temp":24}', tools);
  check('★★ tool_call_id 与 tool_calls[].id 严格配对（同名多次调用按 FIFO 对上）',
    tools[0].tool_call_id === asst.tool_calls[0].id && tools[1].tool_call_id === asst.tool_calls[1].id,
    { ids: asst.tool_calls.map((t) => t.id), got: tools.map((t) => t.tool_call_id) });
  check('合成的 id 形如 call_g<n>_<name>（与出站方向 geminiPartsToOai 同一套命名，可读可查）',
    /^call_g0_get_weather$/.test(asst.tool_calls[0].id) && /^call_g1_get_weather$/.test(asst.tool_calls[1].id),
    asst.tool_calls.map((t) => t.id));

  const mixed = api.geminiToOpenAI({
    contents: [
      { role: 'user', parts: [{ text: '来' }] },
      { role: 'model', parts: [{ text: '我查一下' }, { functionCall: { name: 'get_time', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'get_time', response: { now: '12:00' } } }] },
    ],
  }, 'm');
  const a2 = mixed.messages.find((m) => m.role === 'assistant');
  check('文本 + 工具调用在同一轮 → 合并进同一条 assistant（文本在 content、调用在 tool_calls）',
    a2.content === '我查一下' && a2.tool_calls.length === 1 && a2.tool_calls[0].function.name === 'get_time', a2);

  const orphan = api.geminiToOpenAI({
    contents: [{ role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 31 } } }] }],
  }, 'm');
  const orphanTools = orphan.messages.filter((m) => m.role === 'tool');
  check('★ 无状态客户端（只回结果、不带上文的 functionCall）：不硬造 tool_call_id',
    orphanTools.length === 0, orphanTools);
  check('★ 而是退回文本形态（结果照样进上下文，且不会让上游因"孤儿 tool 消息"400）',
    orphan.messages.some((m) => typeof m.content === 'string' && m.content.includes('get_weather') && m.content.includes('31')),
    orphan.messages);

  const noArgs = api.geminiToOpenAI({
    contents: [{ role: 'model', parts: [{ functionCall: { name: 'ping' } }] }],
  }, 'm');
  check('functionCall 没给 args → 落成 {} 而不是 undefined（上游认字符串 JSON）',
    noArgs.messages[0].tool_calls[0].function.arguments === '{}', noArgs.messages[0]);
  check('空条目被跳过（不塞空 assistant 消息去惹上游 400）',
    api.geminiToOpenAI({ contents: [{ role: 'model', parts: [] }, { role: 'user', parts: [{ text: 'hi' }] }] }, 'm').messages.length === 1);
}

/* ═══════════════════ 3. 出站：响应方向的 functionCall ═══════════════════ */
G('3. 出站 openAIToGeminiResponse：tool_calls → functionCall 部件');
{
  const g = api.openAIToGeminiResponse({
    model: 'm1',
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }] } }],
    usage: { prompt_tokens: 5, completion_tokens: 7 },
  });
  const parts = g.candidates[0].content.parts;
  check('★ 客户端拿到的 parts 里有 functionCall（这正是 PT33 里丢掉的东西）',
    parts.length === 1 && !!parts[0].functionCall && parts[0].functionCall.name === 'get_weather', parts);
  check('★ args 是**对象**而不是 JSON 字符串（Gemini 的 args 必须是对象）',
    parts[0].functionCall.args && parts[0].functionCall.args.city === '上海', parts[0].functionCall.args);
  check('有工具调用时 finishReason 是 STOP（Gemini 没有 tool_calls 这个结束原因）',
    g.candidates[0].finishReason === 'STOP', g.candidates[0].finishReason);
  check('usageMetadata 照旧带上（token 计数没被工具支持挤掉）',
    g.usageMetadata.promptTokenCount === 5 && g.usageMetadata.candidatesTokenCount === 7 && g.usageMetadata.totalTokenCount === 12, g.usageMetadata);

  const textAndCalls = api.openAIToGeminiResponse({
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '我先查一下', tool_calls: [{ function: { name: 't', arguments: '{}' } }] } }],
  });
  check('文本与 functionCall 同时出现 → 两个部件都在，顺序为 文本 → functionCall',
    textAndCalls.candidates[0].content.parts.length === 2
    && textAndCalls.candidates[0].content.parts[0].text === '我先查一下'
    && !!textAndCalls.candidates[0].content.parts[1].functionCall);

  const brokenMsg = { role: 'assistant', content: '', tool_calls: [{ function: { name: 't', arguments: '{"a":' } }] };
  const broken = api.openAIToGeminiResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: brokenMsg }] });
  check('arguments 是半截 JSON → 不静默丢件，原样塞进 _raw_arguments',
    broken.candidates[0].content.parts[0].functionCall.args._raw_arguments === '{"a":', broken.candidates[0].content.parts[0].functionCall.args);

  const arr = api.openAIToGeminiResponse({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: '数组形态的文本' }] } }] });
  check('content 是数组（跨协议带图）时也能取到文本（用 oaiTextOf 而不是裸 .content）',
    arr.candidates[0].content.parts[0].text === '数组形态的文本', arr.candidates[0].content.parts);
  check('content_filter / refusal → SAFETY（与流式侧同一套映射）',
    api.openAIToGeminiResponse({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }).candidates[0].finishReason === 'SAFETY'
    && api.openAIToGeminiResponse({ choices: [{ message: { content: '' }, finish_reason: 'refusal' }] }).candidates[0].finishReason === 'SAFETY');
  check('length → MAX_TOKENS 没被改坏',
    api.openAIToGeminiResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }).candidates[0].finishReason === 'MAX_TOKENS');
}

/* ═══════════════════ 4. 流式：分片工具调用必须攒成完整对象 ═══════════════════ */
G('4. 流式 openAIStreamToGeminiSSE：按 index 拆片的 tool_calls 攒成完整 functionCall');
{
  const state = {};
  const out = [];
  const feed = (j) => { for (const g of api.openAIStreamToGeminiSSE([j], state)) out.push(g); };
  feed({ choices: [{ index: 0, delta: { role: 'assistant', content: '查一下' } }] });
  feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] });
  feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }] });
  feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"上海"}' } }] } }] });
  feed({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } });

  const textParts = out.filter((g) => (g.candidates[0].content.parts || []).some((p) => p.text)).map((g) => g.candidates[0].content.parts[0].text);
  check('文本分片照旧逐帧转发（流式文本没被工具支持影响）',
    textParts.join('') === '查一下', textParts);
  const callPart = out.map((g) => (g.candidates[0].content.parts || []).find((p) => p.functionCall)).find(Boolean);
  check('★ 客户端最后拿到了 functionCall',
    !!callPart && callPart.functionCall.name === 'get_weather', callPart);
  check('★★ 而且 args 是**完整对象**（半截 JSON 绝不会发给客户端）',
    callPart.functionCall.args && callPart.functionCall.args.city === '上海', callPart && callPart.functionCall.args);
  check('★ functionCall 单独占一帧、且在 finishReason 那帧**之前**（客户端读到结束就停手也不会漏）',
    out.findIndex((g) => (g.candidates[0].content.parts || []).some((p) => p.functionCall))
    < out.findIndex((g) => g.candidates[0].finishReason), out.map((g) => ({ p: (g.candidates[0].content.parts || []).length, fr: g.candidates[0].finishReason })));
  check('结束帧带 finishReason STOP 与 usageMetadata',
    out.some((g) => g.candidates[0].finishReason === 'STOP' && g.usageMetadata && g.usageMetadata.totalTokenCount === 7),
    out.filter((g) => g.candidates[0].finishReason).map((g) => g.candidates[0].finishReason));
  check('★ 结束帧之后状态被清空（同一 state 复用下一次调用不会串台）',
    api.openAIStreamToGeminiSSE([{ choices: [{ index: 0, delta: {} }] }], state).length === 0 && state.calls.size === 0, state.calls.size);

  const parallel = {};
  const p2 = [];
  api.openAIStreamToGeminiSSE([{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'a', arguments: '{"x":1}' } }, { index: 1, function: { name: 'b', arguments: '{"y":2}' } }] } }] }], parallel).forEach((g) => p2.push(g));
  api.openAIStreamToGeminiSSE([{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }], parallel).forEach((g) => p2.push(g));
  const calls = p2.map((g) => (g.candidates[0].content.parts || []).flatMap((p) => p.functionCall ? [p.functionCall] : []));
  const flat = calls.flat();
  check('★ 并行工具调用（多个 index）各自独立攒、按 index 顺序输出',
    flat.length === 2 && flat[0].name === 'a' && flat[0].args.x === 1 && flat[1].name === 'b' && flat[1].args.y === 2, flat);

  const legacy = api.openAIStreamToGeminiSSE([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }]);
  check('不传 state 也能用（老的单帧调用方式保持兼容）',
    legacy.some((g) => g.candidates[0].finishReason === 'STOP'), legacy);
}

/* ═══════════════════ 5. 兼容性：工具仿真链照样拿到可读文本 ═══════════════════ */
G('5. ★ 兼容性：改真报文后，notion / genspark 的"工具仿真"链一点没少');
{
  /* 这是本轮最该被证明的一条：旧实现之所以把 functionCall 降级成文本，是为了喂给
     "没有工具能力"的渠道（notion / genspark / workbuddy 走 tool-emu 仿真）。
     现在入站产出真 tool_calls，仿真链是否还能看到工具回合？——直接调 tool-emu 证明。 */
  const body = api.geminiToOpenAI({
    contents: [
      { role: 'user', parts: [{ text: '上海天气？' }] },
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: '上海' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 31 } } }] },
    ],
    tools: DECL,
  }, 'm');
  const emu = toolEmu.emulateRequest(body);
  const flat = JSON.stringify(emu);
  check('tool-emu 认这条请求（有 tools 时进入仿真）', !!emu && Array.isArray(emu.messages), emu && Object.keys(emu));
  check('★ 仿真后的 messages 里能看到**函数名与参数**（工具调用没丢）',
    flat.includes('get_weather') && flat.includes('上海'), flat.slice(0, 300));
  check('★ 也能看到**工具执行结果**（functionResponse 的内容进了上下文）',
    flat.includes('31'), flat.slice(0, 300));
  check('★ 且仿真链看到的是纯文本消息（不含 tool_calls 结构、也没有 role:tool —— 那些渠道不认）',
    emu.messages.every((m) => typeof m.content === 'string' && m.role !== 'tool' && !m.tool_calls),
    emu.messages.map((m) => m.role));
}

console.log('\n──────────────────────────────────────────────────────────');
console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
process.exitCode = fail ? 1 : 0;
