#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/tool-emu-fuzz.test.js — tool-emu.js 的属性 / 模糊（property-based / fuzz）回归
 *
 * 为什么需要它：
 *   tool-emu.js 是"没有原生 function calling 的渠道（notion / hark / genspark /
 *   notion-agent / workbuddy…）"把模型吐的文本还原成真 tool_calls 的唯一通道。
 *   它最怕的不是抛异常，而是**静默的错**：
 *     · 解析器在某种畸形文本上直接崩（整条渠道 500）；
 *     · 流式扫描器跨块 hold 写错 → 同一段文本整块喂与分块喂产出**不同**的调用
 *       （跨块把 JSON / 转义符切断时最常见）；
 *     · 参数在还原成 OpenAI 报文时不是合法 JSON 对象；
 *     · 标记 [TOOL_CALL] 残留在给用户看的 content 里。
 *   这些都不是"多写几个例子"能守住的，所以本用例用**确定性 PRNG**（mulberry32，
 *   固定种子）生成成千上万个输入，按**性质**断言，而不是枚举样例。同种子每次结果
 *   一致，红了可逐字复现。
 *
 * 纪律：
 *   · 只用 Node 内置（零依赖）；不 require server.js、不起网关、不出网、不读私有文件。
 *   · 断言全部按 tool-emu.js 的**真实行为**写（先通读源码，再据实断言）。
 *   · 结尾打运行器认得的收尾行：`══════ 通过 N · 失败 M ══════`。
 *
 * 跑法：node test/tool-emu-fuzz.test.js   （零依赖，退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const toolEmu = require(require('path').join(__dirname, '..', 'tool-emu.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    console.log('  ✗ ' + name + (detail !== undefined ? '   ← 实际: ' + JSON.stringify(detail).slice(0, 320) : ''));
  }
}
const G = (t) => console.log('\n' + t);

/* ───────────────────────── 确定性 PRNG（mulberry32，固定种子） ─────────────────────────
 * 严禁用 Math.random() 直接当种子：否则红了没法复现。同一种子 → 同一序列 → 同一批用例。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 0x5EEDF00D;
const rng = mulberry32(SEED);
const ri = (n) => Math.floor(rng() * n);          // [0, n)
const pick = (arr) => arr[ri(arr.length)];

/* ───────────────────────── 生成器 ───────────────────────── */
const NAMES = ['read', 'glob', 'get_weather', 'search_files', 'write', '工具', 'a.b', 'f_1'];
const STRVALS = ['', '值', 'a"b', 'x\\y', 'D:\\a b\\c.txt', '😀\u200b中', 'line1\nline2', '[/TOOL_CALL]', '{"nested":"json"}', '\u0000'];

function randArgs(depth) {
  const k = ri(depth > 1 ? 3 : 6);
  if (k === 0) return pick(STRVALS);
  if (k === 1) return ri(100000);
  if (k === 2) return pick([true, false, null]);
  if (k === 3) return [pick(['a', 1, '中', true]), ri(10)];
  if (k === 4) return {};
  const o = {};
  const n = 1 + ri(3);
  for (let i = 0; i < n; i++) o[pick(['path', 'q', 'n', 'x y', '中', 'nested', 'opts'])] = randArgs(depth + 1);
  return o;
}
function randCall() { return { name: pick(NAMES), arguments: randArgs(0) }; }

// 合法文档：标签 / 围栏 / 多个标签 / 顶层数组 / 裸 JSON。
// ★ v1.18.88：以前这里刻意**不**生成"围栏套在标签里"的形态（当时那是真缺陷）。
//   缺陷已修（findCaptureSpans 去掉被包住的 span），现在必须生成——它正是最容易回归的形态。
function docValid() {
  const n = 1 + ri(4);
  const calls = [];
  for (let i = 0; i < n; i++) calls.push(randCall());
  const inner = rng() < 0.35 ? JSON.stringify(calls) : calls.map((c) => JSON.stringify(c)).join(pick(['\n', ' ', '\n\n']));
  const pre = pick(['', '好的，我来查。\n', 'thinking...\n', '先看下。\r\n']);
  const post = pick(['', '\n完毕。', '\n\n', '\r\n尾巴']);
  const mode = ri(6);
  if (mode === 0) return pre + '[TOOL_CALL]\n' + inner + '\n[/TOOL_CALL]' + post;
  if (mode === 1) return pre + '```json\n' + inner + '\n```' + post;
  if (mode === 2) return pre + '[TOOL_CALL]' + inner + '[/TOOL_CALL][TOOL_CALL]' + JSON.stringify(calls[0]) + '[/TOOL_CALL]' + post;
  if (mode === 3) return JSON.stringify(pick([
    calls[0],
    { tool_calls: calls.map((c) => ({ type: 'function', function: { name: c.name, arguments: c.arguments } })) },
    calls,
  ]));
  if (mode === 4) return pre + '```json\n' + inner + '\n```\n[TOOL_CALL]\n' + JSON.stringify(calls[0]) + '\n[/TOOL_CALL]' + post;
  return pre + '[TOOL_CALL]\n' + inner + '\n[/TOOL_CALL]' + post;
}

// 随机/对抗串：把各种"危险的碎片"拼进去（标签、围栏、引号、反斜杠、emoji、代理对、
// 零宽、NUL、CRLF、中文、随机 Unicode 标量）。
function randJunk(len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const k = ri(10);
    if (k < 5) s += String.fromCharCode(32 + ri(95));
    else if (k < 7) s += pick(['[TOOL_CALL]', '[/TOOL_CALL]', '```', '```json\n', '\n', '{', '}', '"', '\\', 'name', 'arguments', '[]', '😀', '\u200b', '\u0000', '\r\n', '\uD800', '\uDFFF']);
    else if (k < 8) s += String.fromCharCode(ri(0xFFFF));
    else if (k < 9) s += '中'.repeat(1 + ri(3));
    else s += pick([' ', '\t', '\n', '\r\n']);
  }
  return s;
}

// 流式扫描器封装：喂 chunks，收集 deltas 与 calls
function scan(chunks) {
  const deltas = [], calls = [];
  const sc = toolEmu.createToolStreamScanner((d) => deltas.push(d), (c) => calls.push(...c));
  for (const ch of chunks) sc.push(ch);
  const st = sc.end();
  return { text: deltas.join(''), calls, saw: st.sawTools };
}

// 随机切成恰好 k 块（k ∈ 1..40），切点可落在标签/JSON/转义符中间
function chunkK(s, k) {
  const L = s.length;
  if (L === 0) return [''];
  const kk = Math.max(1, Math.min(k, L));
  const cuts = new Set();
  while (cuts.size < kk - 1) cuts.add(1 + ri(L - 1));
  const pos = [0, ...[...cuts].sort((a, b) => a - b), L];
  const out = [];
  for (let i = 0; i < pos.length - 1; i++) out.push(s.slice(pos[i], pos[i + 1]));
  return out;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const callShapeOk = (c) => isPlainObject(c) && typeof c.name === 'string' && c.name.trim().length > 0 && isPlainObject(c.arguments);

/* ═══════════════════════ 0. 装配 ═══════════════════════ */
G('0. 装配（导出齐全）');
{
  const need = ['emulateRequest', 'parseEmulatedToolCalls', 'looksLikeHarkCannedFailure',
    'createToolStreamScanner', 'openaiToolCallsPayload', 'toolCallId', 'buildToolSystemPrompt', 'buildTailReminder'];
  const missing = need.filter((k) => typeof toolEmu[k] !== 'function');
  check('8 个导出全部存在且是函数', missing.length === 0, missing);
}

/* ═══════════════════════ 1. never-throws（模糊） ═══════════════════════ */
G('1. never-throws：parseEmulatedToolCalls 对任意字符串都不抛，且返回 null 或 {calls:Array,text:string}');
{
  const adversarial = [
    '', '   \t\r\n ', 'x'.repeat(100 * 1024),                       // 空 / 纯空白 / 100KB
    '😀\uD83D\uDE00\u200b\u0000中文代理对',                          // emoji / 代理对 / 零宽 / NUL
    '[TOOL_CALL]', '[/TOOL_CALL]',                                   // 只有开/闭标签
    '[TOOL_CALL]' + '[TOOL_CALL]'.repeat(200) + '[/TOOL_CALL]',      // 标签嵌套
    '```json\n{"a":1}',                                              // 围栏不闭合
    '[TOOL_CALL]{"name":"a","arguments":{"x":"[/TOOL_CALL]"}}[/TOOL_CALL]', // JSON 里嵌字面量
    '{'.repeat(10000),                                               // { 重复一万次
    'a\u0000b', 'a\r\nb\nc\r\n',                                     // NUL / CRLF+LF 混用
    '\uD800', '[TOOL', '```', '``', '{"name":', ']}',                // 半截 / 孤立片段
  ];
  let bad = null;
  for (const s of adversarial) {
    try {
      const r = toolEmu.parseEmulatedToolCalls(s);
      if (!(r === null || (isPlainObject(r) && Array.isArray(r.calls) && typeof r.text === 'string'))) { bad = { s: s.slice(0, 40), r }; break; }
    } catch (e) { bad = { s: s.slice(0, 40), threw: e && e.message }; break; }
  }
  check('对抗样本（' + adversarial.length + ' 个：空/超长/emoji/代理对/零宽/NUL/CRLF/嵌套/半截…）全部不抛且返回形状合法', bad === null, bad);

  let fuzzBad = null, n = 500;
  for (let i = 0; i < n; i++) {
    const s = randJunk(ri(400));
    try {
      const r = toolEmu.parseEmulatedToolCalls(s);
      if (!(r === null || (isPlainObject(r) && Array.isArray(r.calls)))) { fuzzBad = { i, r }; break; }
    } catch (e) { fuzzBad = { i, s: s.slice(0, 60), threw: e && e.message }; break; }
  }
  check('随机对抗串 ' + n + ' 组（固定种子）全部不抛，返回值恒为 null 或 {calls:Array}', fuzzBad === null, fuzzBad);

  // 合法文档同样不得抛（且必须真的解析出调用，证明不是空跑）
  let validBad = null, parsedCalls = 0;
  for (let i = 0; i < 300; i++) {
    const doc = docValid();
    try {
      const r = toolEmu.parseEmulatedToolCalls(doc);
      if (r) parsedCalls += r.calls.length;
    } catch (e) { validBad = { doc: doc.slice(0, 80), threw: e && e.message }; break; }
  }
  check('合法文档 300 组全部不抛（累计解析出 ' + parsedCalls + ' 个调用，非空跑）', validBad === null && parsedCalls > 300, validBad || { parsedCalls });
}

/* ═══════════════════════ 2. 输出形状不变量 ═══════════════════════ */
G('2. 输出形状不变量：每个 call 的 name 是非空字符串、arguments 是普通对象（真实实现如此，非字符串）');
{
  // 收集合法文档 + 半截文档里所有解析出来的 call
  const all = [];
  const docs = [];
  for (let i = 0; i < 300; i++) docs.push(docValid());
  for (let i = 0; i < 200; i++) { const d = docValid(); docs.push(d.slice(0, ri(d.length + 1))); } // 半截
  for (const d of docs) {
    const r = toolEmu.parseEmulatedToolCalls(d);
    if (r && r.calls) all.push(...r.calls);
  }
  const badName = all.find((c) => !(typeof c.name === 'string' && c.name.trim().length > 0));
  const badArgs = all.find((c) => !isPlainObject(c.arguments));
  check('所有 call 的 name 都是非空字符串（共 ' + all.length + ' 个 call）', !badName, badName);
  check('所有 call 的 arguments 都是普通对象（null/数组都不行）', !badArgs, badArgs);
  check('所有 call 都满足整体形状（isPlainObject + name + arguments 对象）', all.length > 0 && all.every(callShapeOk), all.length);

  // arguments 对象必须可无损 JSON 往返（这就是 openaiToolCallsPayload 里 JSON.stringify 的前提）
  const notRoundTrip = all.find((c) => {
    try { const s = JSON.stringify(c.arguments); const back = JSON.parse(s); return !isPlainObject(back); }
    catch { return true; }
  });
  check('所有 call 的 arguments 都能 JSON 往返成对象（stringify→parse 仍是对象）', !notRoundTrip, notRoundTrip);

  // 非工具 JSON 不得被误判成调用（负样本）
  check('普通 JSON（无 name/arguments 语义）不误判为调用',
    toolEmu.parseEmulatedToolCalls('{"port":8080,"name":"config"}') === null &&
    toolEmu.parseEmulatedToolCalls('随便一段没有工具的散文。') === null);
}

/* ═══════════════════════ 3. 流式分块等价性（最高价值） ═══════════════════════ */
G('3. 流式分块等价性：同一段文本，整块一次喂 vs 随机切成 k 块（k∈1..40）喂，产出必须逐字相同');
{
  const TRIALS = 60;
  let callsBad = null, textBad = null, sawBad = null, totalCalls = 0, withCalls = 0;
  for (let t = 0; t < TRIALS; t++) {
    const doc = docValid();
    const whole = scan([doc]);
    const k = 1 + ri(40);
    const parts = chunkK(doc, k);
    const split = scan(parts);
    totalCalls += whole.calls.length;
    if (whole.calls.length) withCalls++;
    if (JSON.stringify(whole.calls) !== JSON.stringify(split.calls)) {
      if (!callsBad) callsBad = { t, k, doc: doc.slice(0, 120), whole: whole.calls, split: split.calls };
    }
    if (whole.text !== split.text) {
      if (!textBad) textBad = { t, k, doc: doc.slice(0, 120), whole: whole.text, split: split.text };
    }
    if (whole.saw !== split.saw) {
      if (!sawBad) sawBad = { t, k, whole: whole.saw, split: split.saw };
    }
  }
  check('★ ' + TRIALS + ' 组随机切分：tool calls 与整块逐字相同（JSON.stringify 相等）', callsBad === null, callsBad);
  check('★ ' + TRIALS + ' 组随机切分：转发正文 deltas 与整块逐字相同', textBad === null, textBad);
  check('★ ' + TRIALS + ' 组随机切分：sawTools 标志一致', sawBad === null, sawBad);
  check('随机切分样本里有 ' + withCalls + '/' + TRIALS + ' 组真的产出了调用（非空跑）', withCalls > TRIALS / 2, { withCalls, totalCalls });
}

/* ═══════════════════════ 4. JSON 跨块：每 1 字符一块 / 任意两点切 ═══════════════════════ */
G('4. JSON 跨块极端用例：合法 tool JSON 被切成每 1 字符一块，仍必须解析出同一条调用');
{
  const tagDoc = '[TOOL_CALL]\n{"name":"read","arguments":{"path":"D:\\\\a b\\\\c.txt","q":"a\\"b\\\\c","emoji":"😀","n":-3.5,"ok":true}}\n[/TOOL_CALL]';
  const fenceDoc = '```json\n{"name":"glob","arguments":{"pattern":"**/*.md","opts":{"x":[1,2,3],"deep":{"y":null}}}}\n```';
  for (const [nm, doc] of [['[TOOL_CALL] 标记', tagDoc], ['```json 围栏', fenceDoc]]) {
    const whole = scan([doc]);
    const oneByOne = scan(doc.split(''));
    check('★ ' + nm + '：逐字符喂（' + doc.length + ' 块）与整块喂产出相同调用', JSON.stringify(whole.calls) === JSON.stringify(oneByOne.calls) && whole.calls.length === 1, { whole: whole.calls, oneByOne: oneByOne.calls });
  }

  // 对一段复杂文档，枚举**所有**两点切分位置（0..len），每一处都必须与整块一致
  const complex = '前文\n[TOOL_CALL]\n{"name":"read","arguments":{"path":"D:\\\\a b\\\\c.txt","q":"\\"引号\\"","emoji":"😀","arr":[1,2,{"z":"}"}]}}\n[/TOOL_CALL]\n中间\n[TOOL_CALL]\n{"name":"glob","arguments":{"pattern":"**/*.md"}}\n[/TOOL_CALL]\n后文';
  const cw = scan([complex]);
  let firstBad = -1;
  for (let i = 0; i <= complex.length; i++) {
    const r = scan([complex.slice(0, i), complex.slice(i)]);
    if (JSON.stringify(r.calls) !== JSON.stringify(cw.calls) || r.text !== cw.text) { firstBad = i; break; }
  }
  check('★ 复杂文档枚举全部 ' + (complex.length + 1) + ' 个两点切分位置：calls 与正文全部一致', firstBad === -1, firstBad === -1 ? undefined : { firstBad, at: complex.slice(Math.max(0, firstBad - 12), firstBad + 12) });
  check('复杂文档整块解析出 2 个调用（read + glob）', cw.calls.length === 2 && cw.calls[0].name === 'read' && cw.calls[1].name === 'glob', cw.calls.map((c) => c.name));
}

/* ═══════════════════════ 5. 幂等 / 确定性 ═══════════════════════ */
G('5. 幂等 / 确定性：同一输入连调两次结果逐字相同；emulateRequest 结构相同');
{
  let idemBad = null;
  for (let i = 0; i < 200; i++) {
    const doc = i % 2 ? docValid() : randJunk(ri(200));
    const a = toolEmu.parseEmulatedToolCalls(doc);
    const b = toolEmu.parseEmulatedToolCalls(doc);
    if (JSON.stringify(a) !== JSON.stringify(b)) { idemBad = { doc: doc.slice(0, 80) }; break; }
  }
  check('parseEmulatedToolCalls 对同一输入两次调用结果逐字相同（200 组）', idemBad === null, idemBad);

  const doc = docValid();
  const s1 = scan([doc]), s2 = scan([doc]);
  check('流式扫描器对同一输入两次运行产出相同（calls + deltas）',
    JSON.stringify(s1.calls) === JSON.stringify(s2.calls) && s1.text === s2.text);

  const body = {
    model: 'm',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '读文件' },
      { role: 'assistant', content: '好的', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'read', content: '内容Z' },
    ],
    tools: [{ type: 'function', function: { name: 'read', description: '读文件', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
  };
  const e1 = toolEmu.emulateRequest(body), e2 = toolEmu.emulateRequest(body);
  check('emulateRequest(body) 两次调用结构逐字相同（不含随机 id，可直接比较）', JSON.stringify(e1) === JSON.stringify(e2));
  check('emulateRequest 返回 {messages:Array, tools:Array} 且 tools 已归一（name/description/parameters）',
    e1 && Array.isArray(e1.messages) && Array.isArray(e1.tools) && e1.tools[0].name === 'read' && isPlainObject(e1.tools[0].parameters), e1 && e1.tools);
  check('无 tools / 空 tools / 无 name 的工具 / tool_choice:none → emulateRequest 返回 null',
    toolEmu.emulateRequest({ messages: [] }) === null &&
    toolEmu.emulateRequest({ tools: [] }) === null &&
    toolEmu.emulateRequest({ tools: [{ type: 'function' }], messages: [] }) === null &&
    toolEmu.emulateRequest({ tools: [{ name: 'x' }], messages: [], tool_choice: 'none' }) === null);
}

/* ═══════════════════════ 6. openaiToolCallsPayload 形状 ═══════════════════════ */
G('6. openaiToolCallsPayload 形状：type=function、id 前缀/唯一、arguments 是字符串、content 无标记残留');
{
  const reply = '好的，我来查。\n[TOOL_CALL]\n{"name":"get_weather","arguments":{"city":"北京","n":1}}\n[/TOOL_CALL]\n[TOOL_CALL]\n{"name":"read","arguments":{"path":"a.txt"}}\n[/TOOL_CALL]\n完毕。';
  const parsed = toolEmu.parseEmulatedToolCalls(reply);
  const payload = toolEmu.openaiToolCallsPayload('resp-x', 'model-y', parsed.calls, parsed.text || null);
  const msg = payload.choices[0].message;
  const tcs = msg.tool_calls;
  check('choices[0].message.tool_calls 数量与解析一致，finish_reason=tool_calls',
    Array.isArray(tcs) && tcs.length === parsed.calls.length && payload.choices[0].finish_reason === 'tool_calls', { n: tcs && tcs.length, fr: payload.choices[0].finish_reason });
  check('每个 tool_call 的 type 都是 "function"', tcs.every((t) => t.type === 'function'), tcs.map((t) => t.type));
  check('每个 tool_call 的 id 以 "call_" 开头且互不相同', tcs.every((t) => typeof t.id === 'string' && t.id.startsWith('call_')) && new Set(tcs.map((t) => t.id)).size === tcs.length, tcs.map((t) => t.id));
  check('function.arguments 是字符串，且 JSON.parse 后是对象（不是字符串/数组/null）',
    tcs.every((t) => typeof t.function.arguments === 'string' && isPlainObject(JSON.parse(t.function.arguments))), tcs.map((t) => t.function.arguments));
  check('给用户看的 content 里不残留 [TOOL_CALL] / [/TOOL_CALL] 标记',
    (msg.content === null || !/\[\/?TOOL_CALL\]/.test(String(msg.content))), msg.content);
  const p2 = toolEmu.openaiToolCallsPayload('r', 'm', [{ name: 'a', arguments: {} }], '');
  check('content 为空时 message.content 为 null（不是空串）', p2.choices[0].message.content === null, p2.choices[0].message.content);
}

/* ═══════════════════════ 7. toolCallId 唯一性 / 熵 ═══════════════════════ */
G('7. toolCallId 唯一性 / 字符集：批量 2000 个必须全不重复');
{
  const ids = [];
  for (let i = 0; i < 2000; i++) ids.push(toolEmu.toolCallId());
  check('2000 个 toolCallId 的 new Set().size === 2000（无碰撞）', new Set(ids).size === 2000, new Set(ids).size);
  const badShape = ids.find((s) => !/^call_[0-9a-z]+$/.test(s));
  check('全部形如 /^call_[0-9a-z]+$/（前缀 call_ + 小写 36 进制）', !badShape, badShape);
  const lens = new Set(ids.map((s) => s.length));
  check('长度稳定（全部 21 字符：call_ + 时间基 8 + 随机 8）', lens.size === 1 && ids[0].length === 21, [...lens]);
}

/* ═══════════════════════ 8. looksLikeHarkCannedFailure ═══════════════════════ */
G('8. looksLikeHarkCannedFailure：随机文本不抛且返回 boolean；正样本 true / 负样本 false');
{
  let fuzzBad = null, n = 500;
  for (let i = 0; i < n; i++) {
    const s = randJunk(ri(300));
    try { if (typeof toolEmu.looksLikeHarkCannedFailure(s) !== 'boolean') { fuzzBad = { i, s: s.slice(0, 40) }; break; } }
    catch (e) { fuzzBad = { i, threw: e && e.message }; break; }
  }
  check('随机串 ' + n + ' 组全部不抛且返回 boolean', fuzzBad === null, fuzzBad);

  const MUST_HIT = [
    "I wasn't able to answer this message.",
    "I couldn't complete your request. Please try again.",
    'Please try again.',
    "I don't have a tool that can read files from your local machine.",
    "I can't actually execute these tool calls.",
    '我在这里替你执行不了这些工具调用',
    '那种工具调用格式我这边跑不了',
  ];
  const missHit = MUST_HIT.filter((s) => !toolEmu.looksLikeHarkCannedFailure(s));
  check('正样本（hark 固定道歉 / 自称没工具，含中文）' + MUST_HIT.length + ' 条全部判 true', missHit.length === 0, missHit);

  const MUST_MISS = ['OK', '42', '巴黎', 'Done.', '# zzcsapi', '好的，我来帮你查一下。',
    '我读到了 README 的第一行：版本 v1.18.55。', 'The weather in Paris is sunny today.',
    '工具 read_local_file 的参数是 path。', 'x'.repeat(1200) + " I couldn't complete your request"];
  const falseHit = MUST_MISS.filter((s) => toolEmu.looksLikeHarkCannedFailure(s));
  check('负样本（普通短答 / 正常回复 / 长正文带道歉字样）' + MUST_MISS.length + ' 条全部判 false', falseHit.length === 0, falseHit);

  const nonStr = [42, {}, [], true, null, undefined, 0].filter((v) => toolEmu.looksLikeHarkCannedFailure(v) !== false);
  check('非字符串输入（number/object/array/bool/null/undefined）一律返回 false，不抛', nonStr.length === 0, nonStr);
}

/* ═══════════════════════ 9. 请求侧提示词 / 工具定义归一 ═══════════════════════ */
G('9. 请求侧：工具定义三种形状归一 + 尾部提醒自包含 + tool_choice 四态');
{
  const flat = toolEmu.emulateRequest({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', name: 'flat', description: 'd', parameters: { type: 'object', properties: { a: { type: 'string' } } } }] });
  const anth = toolEmu.emulateRequest({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'anth', description: 'd', input_schema: { type: 'object', properties: { b: { type: 'number' } } } }] });
  const camel = toolEmu.emulateRequest({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'cam', description: 'd', inputSchema: { type: 'object' } }] });
  check('扁平 / Anthropic(input_schema) / 驼峰(inputSchema) 三种工具定义都归一成 name+parameters',
    flat.tools[0].name === 'flat' && Object.keys(flat.tools[0].parameters.properties).length === 1 &&
    anth.tools[0].name === 'anth' && Object.keys(anth.tools[0].parameters.properties).length === 1 &&
    camel.tools[0].name === 'cam' && isPlainObject(camel.tools[0].parameters),
    { flat: flat.tools[0], anth: anth.tools[0], camel: camel.tools[0] });

  const emu = toolEmu.emulateRequest({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: {} } }] });
  check('system 提示词点名了工具名（### f）', /### f/.test(emu.messages[0].content) && emu.messages[0].role === 'system');
  check('最后一条 user 消息末尾追加了自包含的尾部提醒（含"提醒：工具由调用方执行"）',
    /提醒：工具由调用方执行/.test(emu.messages[emu.messages.length - 1].content));
  check('buildToolSystemPrompt([]) 与 buildTailReminder([]) 都返回可用的空态（不抛）',
    toolEmu.buildToolSystemPrompt([], 'auto') === '' && typeof toolEmu.buildTailReminder([]) === 'string' && /提醒：工具由调用方执行/.test(toolEmu.buildTailReminder([])));

  const req = (choice) => toolEmu.emulateRequest({ messages: [], tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: {} } }], tool_choice: choice });
  check('tool_choice: auto/required/any/{name} 四态映射正确（none→null，required/any/具名→强制调用）',
    req('none') === null &&
    /由你判断/.test(req('auto').messages[0].content) &&
    /你必须调用一个工具/.test(req('required').messages[0].content) &&
    /你必须调用一个工具/.test(req('any').messages[0].content) &&
    /必须调用工具 f/.test(req({ name: 'f' }).messages[0].content));
}

/* ═══════════════ 10. 嵌套围栏回归（v1.18.88 修的真实缺陷，现已钉成断言） ═══════════════ */
G('10. 嵌套围栏：围栏套在 [TOOL_CALL] 里 → 非流式与流式必须解析出**同样多**的调用');
{
  // 单调用被 ```json 包在 [TOOL_CALL] 里：非流式只解析 1 个（正确）。
  const single = '[TOOL_CALL]\n```json\n{"name":"write","arguments":{"path":"a.txt"}}\n```\n[/TOOL_CALL]';
  const rSingle = toolEmu.parseEmulatedToolCalls(single);
  check('围栏套在 [TOOL_CALL] 里的**单调用** → 非流式仍只解析 1 个（不重复）', !!rSingle && rSingle.calls.length === 1 && rSingle.calls[0].name === 'write', rSingle && rSingle.calls);

  // 流式扫描器对该形态是正确的（只产出 1 次）。
  const scanSingle = scan([single]);
  check('同一形态走**流式**扫描器 → 也只产出 1 个调用', scanSingle.calls.length === 1, scanSingle.calls);

  /* ★ 这一条是 v1.18.88 修掉的真实缺陷（属性测试抓到的，危险点是"重复执行写操作"）：
     旧 `findCaptureSpans` 同时收集标签区段与围栏区段、只 sort 不合并重叠 ⇒ 围栏在标签内部时
     两者 inner 是**同一段 JSON**、各解析一次 ⇒ 调用翻倍，且正文残留 `[/TOOL_CALL]`
     （content 拼接按 `pos = sp.end` 单调前进，先外后内的重叠会把内层尾巴漏进正文）。
     现在只留最外层。下面 4 条把"修复前后差异"全钉住，别再退回去。 */
  const two = '[TOOL_CALL]\n```json\n{"name":"write","arguments":{"path":"a.txt"}}\n{"name":"read","arguments":{"path":"b.txt"}}\n```\n[/TOOL_CALL]';
  const rTwo = toolEmu.parseEmulatedToolCalls(two);
  check('★ 嵌套围栏 + 2 调用 → 非流式恰好 2 个（修复前是 4 个，会重复执行写操作）',
    !!rTwo && rTwo.calls.length === 2, rTwo && rTwo.calls.length);
  check('★ 顺序与名字都不变（write 在前、read 在后——不是靠去重"碰巧"对）',
    !!rTwo && rTwo.calls.map((c) => c.name).join(',') === 'write,read', rTwo && rTwo.calls.map((c) => c.name));
  check('★ 正文不残留闭合标记（修复前是 "[/TOOL_CALL]"）',
    !!rTwo && rTwo.text === '', rTwo && rTwo.text);
  check('★ 与流式扫描器逐字一致（两条路不许再有分歧）',
    JSON.stringify(scan(two).calls.map((c) => c.name)) === JSON.stringify(rTwo && rTwo.calls.map((c) => c.name)),
    [scan(two).calls.map((c) => c.name), rTwo && rTwo.calls.map((c) => c.name)]);

  // 两个**独立**标签块仍必须都保留（别把"去重叠"写成"只留第一块"）
  const twoBlocks = '[TOOL_CALL]{"name":"a","arguments":{}}[/TOOL_CALL]\n中间\n[TOOL_CALL]{"name":"b","arguments":{}}[/TOOL_CALL]';
  const rBlocks = toolEmu.parseEmulatedToolCalls(twoBlocks);
  check('两个互不重叠的标签块都被保留（去重叠不许误杀相邻块）',
    !!rBlocks && rBlocks.calls.length === 2 && rBlocks.text === '中间', rBlocks && [rBlocks.calls.length, rBlocks.text]);
}

/* ═══════════════ 11. 非字符串入参（v1.18.88 修：以前抛 TypeError） ═══════════════ */
G('11. 非字符串入参必须是 null 而不是 TypeError（解析层不该被上游类型改动打崩）');
{
  for (const bad of [42, {}, true, [], () => 1]) {
    let threw = null, ret = 'unset';
    try { ret = toolEmu.parseEmulatedToolCalls(bad); } catch (e) { threw = e; }
    check('parseEmulatedToolCalls(' + (typeof bad === 'function' ? 'function' : JSON.stringify(bad)) + ') → 返回 null，不抛',
      threw === null && ret === null, threw ? String(threw.message) : ret);
  }
}

/* ═══════════════════════ 收尾 ═══════════════════════ */
console.log('\n' + '─'.repeat(60));
console.log('══════ 通过 ' + pass + ' · 失败 ' + fail + ' ══════');
process.exit(fail ? 1 : 0);
