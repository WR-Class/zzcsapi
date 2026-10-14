#!/usr/bin/env node
/* 上下文节食回归（node test/context-diet.test.js，零依赖）
 *
 * 守的是什么：**摘掉几十轮前的旧截图**这条规则，既不能摘错、也不能在关闭时动一个字节。
 * 动机来自真实落盘报文：一份 4.52MB 的请求里 8 张图占 3.96MB（85%），其中 7 张距今
 * 88~189 条消息 —— 早被分析完，结论写在后面的 assistant 消息里，字节却每轮重发。
 *
 * 纪律（每条都有断言）：
 *   ① 默认关闭时**零行为变化**（不是"结果一样"，是字节级不动）
 *   ② 两条同时满足才保留：最近 K 条消息内 **且** 最近 N 张之内
 *   ③ 只摘图：不碰文本、不碰工具消息、不碰工具参数
 *   ④ 失败安全：结构异常时不抛、原样发
 *   ⑤ 摘完若已无图，含图渠道裁剪不再生效（候选链变宽，这是正确的）
 *   ⑥ 必须在**含图渠道裁剪之前**执行（四套客户端路由都如此）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

/* ── 从源码现抠（大括号配对，沿用其它测试的抽法）── */
function extract(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(SRC);
  if (!m) throw new Error('找不到函数: ' + name);
  const start = m.index;
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return SRC.slice(start, i);
}
function extractDecl(decl) {
  const m = new RegExp('^(?:const|let)\\s+' + decl + '\\s*=.*$', 'm').exec(SRC);
  if (!m) throw new Error('找不到声明: ' + decl);
  return m[0];
}

/* 用指定环境变量现抠一份节食实现 —— 常量是在求值时读 process.env 的，
   所以先把 env 摆好再 new Function，就能对同一个实现跑不同参数的真值表。 */
const ENV_KEYS = ['ZZCSAPI_CONTEXT_DIET', 'ZZCSAPI_DIET_KEEP_MSGS', 'ZZCSAPI_DIET_KEEP_IMAGES'];
function loadDiet(env) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = String(env[k]);
  }
  try {
    const code = [
      extractDecl('DIET_ON'), extract('envNonNegInt'), extractDecl('DIET_KEEP_MSGS'), extractDecl('DIET_KEEP_IMAGES'), extractDecl('DIET_PLACEHOLDER'),
      extract('dietContextImages'),
    ].join('\n');
    return new Function(code + '\nreturn { dietContextImages, DIET_ON, DIET_KEEP_MSGS, DIET_KEEP_IMAGES, DIET_PLACEHOLDER };')();
  } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const bodyHasImages = new Function(extract('bodyHasImages') + '\nreturn bodyHasImages;')();

/* ── 造报文 ── */
const B64 = (n) => 'data:image/png;base64,' + 'A'.repeat(n);
const imgPart = (n) => ({ type: 'image_url', image_url: { url: B64(n) } });
const anthImg = (n) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(n) } });
const textPart = (s) => ({ type: 'text', text: s });
const turnsWith = (spec) => spec.map((has, i) => ({
  role: 'user', content: has ? [textPart('看这个 m' + i + ' (35 字符左右的一点文本)'), imgPart(1000)] : [textPart('m' + i)],
}));
const countImages = (body) => (body.messages || []).reduce((a, m) => a + (Array.isArray(m.content) ? m.content.filter((p) => p && p.type === 'image_url').length : 0), 0);
const countPlaceholders = (body) => (body.messages || []).reduce((a, m) => a + (Array.isArray(m.content) ? m.content.filter((p) => p && p.type === 'text' && /图片已省略/.test(p.text)).length : 0), 0);

console.log('\n1. 默认关闭：零行为变化');
{
  const diet = loadDiet({});
  check('未设 ZZCSAPI_CONTEXT_DIET 时 DIET_ON 为 false', diet.DIET_ON === false);
  const body = { messages: turnsWith([1, 0, 0, 0, 0, 0, 0, 0, 0, 1]) };
  const snapshot = JSON.stringify(body);
  const r = diet.dietContextImages(body);
  check('★ 关闭时返回 null（不是"结果一样"，是不做任何事）', r === null, r);
  check('★ 关闭时报文**字节级未改**', JSON.stringify(body) === snapshot);
}

console.log('\n2. 开启：两条规则同时满足才保留');
{
  const diet = loadDiet({ ZZCSAPI_CONTEXT_DIET: '1', ZZCSAPI_DIET_KEEP_MSGS: 3, ZZCSAPI_DIET_KEEP_IMAGES: 5 });
  check('参数解析：K=3 / N=5', diet.DIET_KEEP_MSGS === 3 && diet.DIET_KEEP_IMAGES === 5, [diet.DIET_KEEP_MSGS, diet.DIET_KEEP_IMAGES]);

  // 图在第 0 条（窗口外，共 10 条 → 窗口 = 第 7~9 条）
  const b1 = { messages: turnsWith([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]) };
  const r1 = diet.dietContextImages(b1);
  check('窗口外的图被摘掉', r1 && r1.stripped === 1, r1);
  check('摘掉后替换成 text 占位符（不是删掉部件，content 数组仍非空）',
    countPlaceholders(b1) === 1 && countImages(b1) === 0 && b1.messages[0].content.length === 2);
  check('占位符文本点明了"可重新发送"', /重新发送/.test(JSON.stringify(b1.messages[0].content)));

  // 图在第 9 条（窗口内）且是最近 1 张 → 留
  const b2 = { messages: turnsWith([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) };
  const snapshot2 = JSON.stringify(b2);
  check('窗口内 + 上限内的图原样保留（返回 null，零改动）', diet.dietContextImages(b2) === null && JSON.stringify(b2) === snapshot2);

  // 窗口富余但有 4 张图（第 7、8、9 条 + 第 0 条）→ 上限 N=5 不触发，先看窗口
  const diet2 = loadDiet({ ZZCSAPI_CONTEXT_DIET: '1', ZZCSAPI_DIET_KEEP_MSGS: 1000, ZZCSAPI_DIET_KEEP_IMAGES: 2 });
  const b3 = { messages: turnsWith([1, 1, 0, 0, 0, 0, 0, 1, 0, 1]) };   // 4 张图，都在窗口内
  const r3 = diet2.dietContextImages(b3);
  check('★ 上限生效：窗口很宽时只留最近 2 张，摘 2 张', r3 && r3.stripped === 2 && countImages(b3) === 2, r3);
  check('留下的是**最近**的两张（第 7 条与第 9 条）',
    b3.messages[7].content.some((p) => p.type === 'image_url') && b3.messages[9].content.some((p) => p.type === 'image_url'));

  // 窗口紧、上限宽 → 窗口仍然否决
  const diet3 = loadDiet({ ZZCSAPI_CONTEXT_DIET: '1', ZZCSAPI_DIET_KEEP_MSGS: 1, ZZCSAPI_DIET_KEEP_IMAGES: 100 });
  const b4 = { messages: turnsWith([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]) };
  const r4 = diet3.dietContextImages(b4);
  check('★ 上限宽不能救窗口外的图（两条是"与"不是"或"）', r4 && r4.stripped === 1, r4);

  check('返回的 savedBytes 等于被摘部件的 JSON 长度', r1 && r1.savedBytes === JSON.stringify(imgPart(1000)).length, r1);
}

console.log('\n3. 三种报文形态');
{
  const diet = loadDiet({ ZZCSAPI_CONTEXT_DIET: '1', ZZCSAPI_DIET_KEEP_MSGS: 1, ZZCSAPI_DIET_KEEP_IMAGES: 1 });
  const anth = { messages: [{ role: 'user', content: [textPart('x'), anthImg(500)] }, { role: 'user', content: [textPart('y')] }] };
  const rA = diet.dietContextImages(anth);
  check('anthropic 形 image 块也被摘', rA && rA.stripped === 1 && anth.messages[0].content[1].type === 'text', rA);

  const gem = {
    contents: [
      { role: 'user', parts: [{ text: 'a' }, { inlineData: { mimeType: 'image/png', data: 'C'.repeat(3000) } }] },
      { role: 'user', parts: [{ text: 'b' }] },
    ],
  };
  const rG = diet.dietContextImages(gem);
  check('gemini 形 inlineData 被摘', rG && rG.stripped === 1 && !gem.contents[0].parts.some((p) => p.inlineData), rG);
  check('gemini 摘后留下 text 部件（parts 不空）', gem.contents[0].parts.length === 2 && typeof gem.contents[0].parts[1].text === 'string');

  const gem2 = { contents: [{ role: 'user', parts: [{ text: 'a' }, { fileData: { fileUri: 'https://x/y.png', mimeType: 'image/png' } }] }, { role: 'user', parts: [{ text: 'b' }] }] };
  const snapshotG2 = JSON.stringify(gem2);
  check('★ gemini 的 fileData（外链引用，几十字节）不动它 —— 摘掉引用是无谓的信息损失',
    diet.dietContextImages(gem2) === null && JSON.stringify(gem2) === snapshotG2);

  const mixed = { messages: [{ role: 'user', content: [textPart('m'), imgPart(100)] }, { role: 'user', content: [textPart('n')] }], contents: [] };
  check('两种形态可共存于同一 body（各按自己的长度算窗口）', diet.dietContextImages(mixed) !== null);
}

console.log('\n4. 只摘图：文本 / 工具消息 / 工具参数一律不动');
{
  const diet = loadDiet({ ZZCSAPI_CONTEXT_DIET: '1', ZZCSAPI_DIET_KEEP_MSGS: 0, ZZCSAPI_DIET_KEEP_IMAGES: 0 });
  const body = {
    messages: [
      { role: 'system', content: 'S'.repeat(5000) },
      { role: 'user', content: [textPart('U'.repeat(4000)), imgPart(900)] },
      { role: 'assistant', content: 'A'.repeat(3000), tool_calls: [{ id: 't1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'x', content: 'W'.repeat(6000) }) } }] },
      { role: 'tool', tool_call_id: 't1', content: 'R'.repeat(7000) },
    ],
  };
  const systemBefore = body.messages[0].content;
  const toolArgsBefore = body.messages[2].tool_calls[0].function.arguments;
  const toolResBefore = body.messages[3].content;
  const r = diet.dietContextImages(body);
  check('K=0/N=0 时所有图都被摘', r && r.stripped === 1, r);
  check('★ system 提示一字未动', body.messages[0].content === systemBefore);
  check('★ 同一条消息里的 user 文本一字未动', body.messages[1].content[0].text === 'U'.repeat(4000));
  check('★ 工具调用参数一字未动', body.messages[2].tool_calls[0].function.arguments === toolArgsBefore);
  check('★ tool 结果一字未动', body.messages[3].content === toolResBefore);
  check('assistant 文本一字未动', body.messages[2].content === 'A'.repeat(3000));
}

console.log('\n5. 失败安全：结构异常不抛、原样发');
{
  const diet = loadDiet({ ZZCSAPI_CONTEXT_DIET: '1' });
  const weird = [
    { name: 'messages 不是数组', body: { messages: 'nope' } },
    { name: 'content 为 null', body: { messages: [{ role: 'user', content: null }] } },
    { name: 'content 是字符串（旧式）', body: { messages: [{ role: 'user', content: 'plain' }] } },
    { name: 'content 数组里混 null', body: { messages: [{ role: 'user', content: [null, imgPart(10)] }] } },
    { name: 'body 为 null', body: null },
    { name: 'body 是字符串', body: 'x' },
  ];
  let threw = null;
  for (const w of weird) {
    const snap = JSON.stringify(w.body);
    try { diet.dietContextImages(w.body); } catch (e) { threw = w.name + ': ' + e.message; }
    if (w.body !== null && typeof w.body === 'object') { /* 可以改，只要不抛 */ }
    if (w.name.includes('null') || w.name.includes('字符串')) {
      check(`${w.name} → 不抛且原样`, JSON.stringify(w.body) === snap, { name: w.name });
    }
  }
  check('★ 六种异常结构一个都不抛', threw === null, threw);
}

console.log('\n6. 摘完之后的连带效应：候选链会放宽（有意为之）');
{
  const diet = loadDiet({ ZZCSAPI_CONTEXT_DIET: '1', ZZCSAPI_DIET_KEEP_MSGS: 1, ZZCSAPI_DIET_KEEP_IMAGES: 1 });
  const body = { messages: [{ role: 'user', content: [textPart('x'), imgPart(50)] }, { role: 'user', content: [textPart('y')] }] };
  check('摘之前 bodyHasImages = true', bodyHasImages(body) === true);
  diet.dietContextImages(body);
  check('★ 摘光之后 bodyHasImages = false → filterCandidatesForImages 不再裁剪，候选链变宽（正确的连带效应）',
    bodyHasImages(body) === false);

  const body2 = { messages: [{ role: 'user', content: [textPart('x')] }, { role: 'user', content: [textPart('y'), imgPart(50)] }] };
  diet.dietContextImages(body2);
  check('还有图保留时 bodyHasImages 仍为 true（渠道裁剪照旧）', bodyHasImages(body2) === true);
}

console.log('\n7. 装配守卫：四套客户端路由都挂上了，且顺序正确');
{
  const calls = [...SRC.matchAll(/applyContextDiet\(/g)].length;
  check('applyContextDiet 出现 1 次定义 + 4 次调用（= 5 处）', calls === 5, calls);
  /* 按函数边界切片，别用正则去啃标点：本用例第一版就是这么误报的（正则碰上 `} });` 就假失败）。 */
  const segOf = (name) => {
    const i = SRC.indexOf('async function ' + name);
    if (i < 0) return '';
    const rest = SRC.slice(i + 10);
    const m = /\n(?:async\s+)?function\s/.exec(rest);
    return m ? SRC.slice(i, i + 10 + m.index) : SRC.slice(i);
  };
  const HANDLERS = ['handleOpenAIRequest', 'handleResponsesRequest', 'handleAnthropicRequest', 'handleGeminiRequest'];
  for (const h of HANDLERS) check(`${h} 里挂了 applyContextDiet`, segOf(h).includes('applyContextDiet('));
  check('responses 路由节食的是转换后的 oaiBody（原始 Responses body 里根本没有 messages）',
    /applyContextDiet\(oaiBody\)/.test(segOf('handleResponsesRequest')));
  check('★ 四个入口都在「含图渠道裁剪」**之前**节食（顺序反了：图摘了却仍被限制在含图渠道上）',
    HANDLERS.every((h) => {
      const seg = segOf(h);
      const d = seg.indexOf('applyContextDiet(');
      const f = seg.indexOf('filterCandidatesForImages(');
      return d >= 0 && (f < 0 || d < f);
    }));

  // ★ 顺序：openai 路由里必须先节食、再做含图渠道裁剪
  const oaiStart = SRC.indexOf('async function handleOpenAIRequest');
  const oaiEnd = SRC.indexOf('async function handleResponsesRequest');
  const seg = SRC.slice(oaiStart, oaiEnd);
  const iDiet = seg.indexOf('applyContextDiet(');
  const iFilter = seg.indexOf('filterCandidatesForImages(');
  check('★ openai 路由里 applyContextDiet 在 filterCandidatesForImages **之前**（顺序反了：摘了图却仍被限制在含图渠道上）',
    iDiet >= 0 && iFilter >= 0 && iDiet < iFilter, { iDiet, iFilter });

  check('默认关：DIET_ON 读的是 ZZCSAPI_CONTEXT_DIET，缺省判为关',
    /const DIET_ON = \/\^\(1\|true\|on\|yes\)\$\/i\.test\(String\(process\.env\.ZZCSAPI_CONTEXT_DIET \|\| ''\)\)/.test(SRC));
  check('参数有钳制（envNonNegInt 内 Math.max/Min 钳到 max），防止配置写错把整个上下文掏空',
    /Math\.max\(0, Math\.min\(max, Math\.floor\(n\)\)\)/.test(extract('envNonNegInt')));
  check('★ 钳制上限：K ≤ 10000 / N ≤ 1000',
    /envNonNegInt\('ZZCSAPI_DIET_KEEP_MSGS', 30, 10000\)/.test(SRC) && /envNonNegInt\('ZZCSAPI_DIET_KEEP_IMAGES', 5, 1000\)/.test(SRC));
  /* ★ 这一条是本节最要紧的：**显式 0 ≠ 没设**。
     第一版实现写成 `Number(env) || 默认`，于是 K=0（把图全摘掉）被静默当成"没设"回落到 30 ——
     配置永远不生效、还不报错。本项目栽过同类的坑（把用户的显式值当缺省）。 */
  {
    const d0 = loadDiet({ ZZCSAPI_CONTEXT_DIET: '1', ZZCSAPI_DIET_KEEP_MSGS: '0', ZZCSAPI_DIET_KEEP_IMAGES: '0' });
    const dU = loadDiet({ ZZCSAPI_CONTEXT_DIET: '1' });
    const dE = loadDiet({ ZZCSAPI_CONTEXT_DIET: '1', ZZCSAPI_DIET_KEEP_MSGS: '', ZZCSAPI_DIET_KEEP_IMAGES: '' });
    const dB = loadDiet({ ZZCSAPI_CONTEXT_DIET: '1', ZZCSAPI_DIET_KEEP_MSGS: 'abc', ZZCSAPI_DIET_KEEP_IMAGES: '99999' });
    check('★ 显式 "0" 就是 0（不是"没设"）', d0.DIET_KEEP_MSGS === 0 && d0.DIET_KEEP_IMAGES === 0, [d0.DIET_KEEP_MSGS, d0.DIET_KEEP_IMAGES]);
    check('未设 → 默认 30 / 5', dU.DIET_KEEP_MSGS === 30 && dU.DIET_KEEP_IMAGES === 5, [dU.DIET_KEEP_MSGS, dU.DIET_KEEP_IMAGES]);
    check('空串 → 默认（compose 的 `${VAR:-}` 未设时传空串，不能把它当 0）', dE.DIET_KEEP_MSGS === 30 && dE.DIET_KEEP_IMAGES === 5, [dE.DIET_KEEP_MSGS, dE.DIET_KEEP_IMAGES]);
    check('非数字 → 默认；超上限 → 钳到上限', dB.DIET_KEEP_MSGS === 30 && dB.DIET_KEEP_IMAGES === 1000, [dB.DIET_KEEP_MSGS, dB.DIET_KEEP_IMAGES]);
  }
  check('函数体里没有任何对 role/tool_calls 的改写（只摘图这条纪律的机械守卫）', !/tool_calls/.test(extract('dietContextImages')));
  check('入口有启动日志（否则开着也不知道）', /\[diet\] 上下文节食已开启/.test(SRC));
  check('每次摘图打一行日志（可事后核账）', /\[diet\] 摘掉 \$\{r\.stripped\} 张旧图/.test(SRC));
}

console.log('\n' + '─'.repeat(58));
if (fail === 0) console.log(`✓ 全部通过（${pass} 项断言）`);
else { console.log(`✗ ${pass} 通过 / ${fail} 失败`); process.exitCode = 1; }
