#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/thinking-fidelity.test.js — thinking / 签名 在各条链路上的保真度地图
 *
 * 为什么需要它（docs/thinking-replay-design.md §7.1 的前置验证）：
 *   那份设计稿提出"跨协议时思维链与签名会丢，要不要做一张回放缓存"。要回答这个问题，
 *   先得把**现状**钉死。逐行核对后发现的事实与最初的假设不一致，本用例就是这份事实的
 *   可执行版本——它锁的不是"某个 bug"，而是**当前刻意设计的行为地图**：
 *
 *     · server.js 里 `signature` 曾出现 **0 次**（网关不保存/校验/伪造签名）；v1.18.8 起它只活在
 *       **thinking 回放块**与 **4xx 作废分支**两处（docs/thinking-replay-design.md §9 第三次决策：
 *       同协议直通上把上游自己签的那枚补回客户端弄丢的地方——跨协议转换器仍一个都不碰）；
 *     · Anthropic 客户端请求 → 内部 OpenAI 格式：`thinking` / `redacted_thinking` **刻意丢弃**
 *       （OpenAI 上游没有签名校验需求，回塞 content 反而污染上下文）；
 *     · 原生 Anthropic 上游 → 内部：thinking 的**文本**进 `reasoning_content`，**签名丢掉**；
 *     · 内部 → 原生 Anthropic 出站：**不产出** `thinking` 块（即使消息上挂着 `reasoning_content`）；
 *     · 内部 → Anthropic 客户端（非流式 + 流式）：**一样不产出** `thinking` 块；
 *     · 因此**跨协议**路上"客户端回传无签名 thinking 块 → 上游 400"**不可达**（客户端根本收不到）；
 *       唯一能收到的是 v1.15 同协议直通——那条路 v1.18.8 起有回放缓存把丢失的签名补回去
 *       （只补上游真签过的，完整回归见 test/thinking-replay-e2e.test.js）。
 *
 *   v1.18 前置验证的结论"在现有实现下无收益"对**跨协议**路径仍然成立（本用例锁住的地图没变）；
 *   v1.18.8 按设计稿 §9 第三次决策为"同协议直通 + 会弄丢签名的客户端"实现了回放，
 *   本用例的守卫随之从"`signature` 出现 0 次"改写成"它只活在回放块与 4xx 作废分支里"——
 *   再往任一转换器里加 `signature`，本用例仍会失败。
 *
 * 怎么测的：从 server.js **按花括号配对抠出真实函数源码**（不是复制副本）在沙箱里跑。
 * 跑法：node test/thinking-fidelity.test.js      （零依赖，退出码非 0 表示保真度地图变了）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

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
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← 实际: ' + JSON.stringify(extra).slice(0, 260) : '')); }
};
const G = (t) => console.log('\n' + t);

const SRC_OF = {};
for (const n of ['anthropicToOpenAI', 'openAIToAnthropicResponse', 'createAnthropicStreamConverter',
  'openAIStreamToAnthropicSSE', 'anthropicToOaiResponse', 'createAnthropicToOaiStream',
  'oaiRequestToAnthropic', 'sanitizeToolId', 'mapFinishReason', 'anthropicStopToFinish', 'oaiChunkLine', 'estimateTokens',
  'oaiTextOf', 'oaiContentBlocks', 'clientBudgetOf']) {
  SRC_OF[n] = extract(n);
}

let api;
try {
  api = new Function([
    SRC_OF.sanitizeToolId, SRC_OF.mapFinishReason, SRC_OF.anthropicStopToFinish, SRC_OF.oaiChunkLine, SRC_OF.estimateTokens,
    SRC_OF.oaiTextOf, SRC_OF.oaiContentBlocks, SRC_OF.clientBudgetOf,
    (src.match(/^const TOOL_RESULT_IMAGE_MARK = .*$/m) || [''])[0],
    SRC_OF.anthropicToOpenAI, SRC_OF.openAIToAnthropicResponse, SRC_OF.createAnthropicStreamConverter,
    SRC_OF.openAIStreamToAnthropicSSE, SRC_OF.anthropicToOaiResponse, SRC_OF.createAnthropicToOaiStream,
    SRC_OF.oaiRequestToAnthropic,
    'return { sanitizeToolId, mapFinishReason, anthropicToOpenAI, openAIToAnthropicResponse, createAnthropicStreamConverter, openAIStreamToAnthropicSSE, anthropicToOaiResponse, createAnthropicToOaiStream, oaiRequestToAnthropic };',
  ].join('\n'))();
} catch (e) {
  console.error('✗ 装配失败：' + e.message);
  process.exit(1);
}

const SIG = 'sig-XyZ-9f2a-上游账号A的签名';
const THINK = '我在推理：先查天气再决定要不要带伞。';

/* ═══════ 0. 装配守卫（源码级：地图的每一条都要能找到出处） ═══════ */
G('0. 装配守卫（这份地图的每条结论都对应 server.js 里的一段真实代码）');
check('server.js 里 `signature` 只活在回放块与 4xx 作废分支里（跨协议转换器一个都不碰，v1.18.8 改写原"0 次"守卫）',
  (() => {
    const hits = [...src.matchAll(/signature/g)].map((m) => m.index);
    const rStart = src.indexOf('thinking 回放缓存（v1.18.8）');
    const rEnd = src.indexOf('// 运行期重新套用这四组设置');
    const outside = hits.filter((i) => i < rStart || i >= rEnd);
    // 区域外只允许一处：tryChannel 4xx 透传分支里判"报错文案是否指向签名/thinking"的正则
    return hits.length > 0 && outside.length === 1 &&
      /\/signature\|thinking\/i\.test\(text\)/.test(src.slice(Math.max(0, outside[0] - 80), outside[0] + 80));
  })(), (src.match(/signature/g) || []).length);
check('入站转换里"刻意丢弃 thinking"的解释性注释还在（删了注释就没人知道这是设计而非漏写）',
  /刻意丢弃的块[\s\S]{0,200}thinking \/ redacted_thinking/.test(SRC_OF.anthropicToOpenAI));
check('入站转换把 thinking 文本塞进 content 的代码不存在（只有注释里提到它）',
  !/reasoning_content\s*[:=]/.test(SRC_OF.anthropicToOpenAI));
check('→ Anthropic 客户端（非流式）转换器里没有 thinking/reasoning（所以客户端收不到块）',
  !/thinking|reasoning/.test(SRC_OF.openAIToAnthropicResponse));
check('→ Anthropic 客户端（流式）转换器里没有 thinking/reasoning',
  !/thinking|reasoning/.test(SRC_OF.createAnthropicStreamConverter));
check('→ 原生 Anthropic 出站转换器里没有 thinking/reasoning（即使有内容也不会被送出去）',
  !/thinking|reasoning/.test(SRC_OF.oaiRequestToAnthropic));
check('原生 Anthropic 上游 → 内部：确实把 thinking 文本搬进 reasoning_content（这是唯一的学习点）',
  /reasoning \+= b\.thinking/.test(SRC_OF.anthropicToOaiResponse) && /message\.reasoning_content = reasoning/.test(SRC_OF.anthropicToOaiResponse));
check('原生 Anthropic 上游（流式）→ 内部：thinking_delta 搬进 reasoning_content',
  /d\.type === 'thinking_delta'[\s\S]{0,160}reasoning_content/.test(SRC_OF.createAnthropicToOaiStream));
check('签名的唯一活路仍是 v1.15 同协议直通（逐字节转发，不经任何转换）；v1.18.8 的回放缓存只是把上游真签过的那枚补回客户端弄丢的地方（不生成、不猜测）',
  /passthroughChannelOpts/.test(src) && /rawClientBody/.test(src) && /passthroughWrite/.test(src) &&
  /function repairThinkingBody\(/.test(src) &&
  (src.match(/repairThinkingBody\(/g) || []).length === 2 &&   // 定义 + 直通选路处注入，别处不许碰
  SRC_OF.anthropicToOpenAI.indexOf('repairThinkingBody') < 0);

/* ═══════ 1. Anthropic 客户端 → 内部：thinking 与签名一起静默丢弃 ═══════ */
G('1. Anthropic 客户端请求 → 内部 OpenAI 格式（跨协议入站）');
{
  const body = {
    model: 'claude-x', max_tokens: 64,
    system: '你是助手',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '北京今天要带伞吗' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: THINK, signature: SIG },
          { type: 'redacted_thinking', data: 'ENCRYPTED_BLOB' },
          { type: 'text', text: '我查一下天气' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴，32 度' }] },
    ],
  };
  const out = api.anthropicToOpenAI(body);
  const raw = JSON.stringify(out);
  check('不报错、结构完整（thinking 丢失不是错误，是设计）', !!out && Array.isArray(out.messages), out && Object.keys(out));
  check('思维链文本没有出现在任何地方（不污染下游上下文）', !raw.includes('我在推理'), raw.slice(0, 200));
  check('签名没有出现在任何地方（不伪造、不残留）', !raw.includes(SIG));
  check('redacted_thinking 的密文也没被带走', !raw.includes('ENCRYPTED_BLOB'));
  check('紧随其后的 tool_use 完好（丢 thinking 不会连带丢掉工具调用）',
    JSON.stringify(out.messages).includes('get_weather') && JSON.stringify(out.messages).includes('toolu_1'));
  check('工具结果照旧配对成 role:tool', out.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'toolu_1'));
}

/* ═══════ 2. 原生 Anthropic 上游 → 内部：文本留下、签名丢掉 ═══════ */
G('2. 原生 Anthropic 上游响应 → 内部（文本留、签名丢）');
{
  const ant = {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-3',
    content: [{ type: 'thinking', thinking: THINK, signature: SIG }, { type: 'text', text: '答案' }],
    stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 7 },
  };
  const oai = api.anthropicToOaiResponse(ant, 'claude-x');
  const msg = oai.choices[0].message;
  check('思维链文本被搬进 reasoning_content（内部格式唯一能装它的地方）', msg.reasoning_content === THINK, msg.reasoning_content);
  check('签名彻底消失', !JSON.stringify(oai).includes(SIG));
  check('正文与 usage 不受影响', msg.content === '答案' && oai.usage.prompt_tokens === 11 && oai.usage.completion_tokens === 7);
}

/* ═══════ 3. 原生 Anthropic 上游流式 → 内部：同上 ═══════ */
G('3. 原生 Anthropic 上游流式 → 内部（thinking_delta → reasoning_content）');
{
  const s = api.createAnthropicToOaiStream('claude-x');
  const frames = [
    'data: {"type":"message_start","message":{"id":"msg_s","usage":{"input_tokens":5,"output_tokens":0}}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想一下"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
  ];
  const out = [];
  for (const f of frames) out.push(...s.push(f + '\n'));   // 真实链路里每次只喂一行（tryChannel 自己按 \n 切）
  const raw = out.join('\n');
  check('thinking 分片被翻译成 reasoning_content 分片', /"reasoning_content":"想一下"/.test(raw), raw.slice(0, 240));
  check('签名一个字都没留下', !raw.includes(SIG));
  check('文本分片照旧进 content', /"content":"好"/.test(raw));
}

/* ═══════ 4. 内部 → 原生 Anthropic 出站：不产出 thinking 块 ═══════ */
G('4. 内部 → 原生 Anthropic 渠道（出站）：不会把 reasoning_content 变回 thinking');
{
  const body = {
    model: 'claude-x', max_tokens: 32, stream: false,
    messages: [
      { role: 'user', content: '北京今天要带伞吗' },
      {
        role: 'assistant', content: '我查一下天气',
        reasoning_content: THINK,                        // 上一家给回来的思维链，就挂在消息上
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '晴，32 度' },
    ],
  };
  const out = api.oaiRequestToAnthropic(body, { upstream: 'claude-real', headers: {} });
  const raw = JSON.stringify(out);
  check('出站报文里没有 thinking 块（哪怕消息上挂着 reasoning_content）', !/"type":"thinking"/.test(raw), raw.slice(0, 260));
  check('出站报文里没有 reasoning_content 字段名（内部字段不外泄）', !raw.includes('reasoning_content'));
  check('也不含任何签名', !raw.includes(SIG));
  check('工具调用与结果照旧映射为 tool_use / tool_result', /"type":"tool_use"/.test(raw) && /"type":"tool_result"/.test(raw));
}

/* ═══════ 5. 内部 → Anthropic 客户端（非流式）：客户端收不到 thinking ═══════ */
G('5. 内部 → Anthropic 客户端（非流式）：不产出 thinking 块');
{
  const oai = {
    id: 'chatcmpl-1', model: 'gpt-x', created: 1,
    choices: [{ index: 0, message: { role: 'assistant', content: '答案是 42', reasoning_content: THINK }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  };
  const ant = api.openAIToAnthropicResponse(oai, 'claude-x');
  const raw = JSON.stringify(ant);
  check('客户端拿到的 content 里没有 thinking 块', !/"type":"thinking"/.test(raw), raw.slice(0, 240));
  check('思维链文本没有泄漏给客户端', !raw.includes('我在推理'));
  check('更不会伪造 signature 字段（宁可少一个块，不许编签名）', !/signature/.test(raw));
  check('正文 stop_reason / usage 照旧正确', ant.content[0].text === '答案是 42' && ant.stop_reason === 'end_turn' && ant.usage.output_tokens === 4);
}

/* ═══════ 6. 内部 → Anthropic 客户端（流式）：同上 ═══════ */
G('6. 内部 → Anthropic 客户端（流式）：不产出 thinking 块、不伪造签名');
{
  const chunks = [
    { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { reasoning_content: THINK }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } },
  ];
  const conv = api.createAnthropicStreamConverter('claude-x');
  const started = typeof conv.start === 'function' ? conv.start() : [];
  const pushed = typeof conv.push === 'function' ? [].concat(conv.push(chunks[1]) || []) : [];
  const all = [...api.openAIStreamToAnthropicSSE(chunks, 'claude-x')].concat(started, pushed);
  const raw = JSON.stringify(all);
  check('事件里没有 thinking / thinking_delta 内容块', !/"type":"thinking/.test(raw), raw.slice(0, 260));
  check('没有伪造签名', !/signature/.test(raw));
  check('message_start 里也不预先声明 thinking 内容块', !/"content":\[\{[^}]*thinking/.test(raw));
}

/* ═══════ 7. 结论：跨协议路不可达；同协议直通路 v1.18.8 已有回放 ═══════ */
G('7. 结论（把设计决策写进测试，免得下次凭印象重来）');
check('地图上"网关会把 thinking 块发给客户端"的路径数 = 0（除直通外）',
  !/thinking/.test(SRC_OF.openAIToAnthropicResponse) && !/thinking/.test(SRC_OF.createAnthropicStreamConverter));
check('**跨协议**路上"客户端回传无签名 thinking → 上游 400"不可达（客户端手里根本没有我们给的块）', true);
check('唯一真会 400 的场景是"客户端自带的签名跨到了另一个 Anthropic 渠道"（签名与上游账号绑定）——回放缓存**也不救**（键含渠道，A 家的签名不借给 B 家）',
  /REPLAY = new Map\(\)/.test(src) && /channelId/.test(src.slice(src.indexOf('function replayBlockKey('), src.indexOf('function replayLearn('))));
check('v1.18.8 按 §9 第三次决策实现了回放：thinkingReplay 第四组设置 + 学习/修复/作废三入口齐全（完整回归在 test/thinking-replay-e2e.test.js）',
  /thinkingReplay: \(config && config\.thinkingReplay\) \|\| undefined/.test(src) &&
  /function replayLearn\(/.test(src) && /function replayStale\(/.test(src) && /function replayStatus\(/.test(src));

console.log('\n' + '─'.repeat(58));
console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
process.exitCode = fail ? 1 : 0;
