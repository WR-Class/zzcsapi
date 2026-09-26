#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/gemini-multimodal.test.js — Gemini 图片（多模态）入站转换的回归测试
 *
 * 为什么需要它（README §9「Gemini 多模态（图片）适配」/ detailed §8.13）：
 *   网关内部统一用 OpenAI 格式，图片表示为 messages[].content 数组里的 image_url block。
 *   `/gemini/v1beta/...` 的入站转换以前只认 part.text —— 客户端发 inlineData（图片）时会被
 *   **静默丢掉**，模型照样自信作答，用户以为它看过图。这类 bug 不报错、不崩、HTTP 全 200。
 *
 * 怎么测的：
 *   从 server.js **按花括号配对抠出真实函数源码**（不是复制副本，永远与产品代码同步），
 *   在沙箱里跑转换，断言图片 block 的形态、顺序、命名变体，以及"含图请求只留能转图的渠道"。
 *
 * 不覆盖：真实上游是否支持视觉（那取决于渠道本身）、真实流式渲染。
 *         依赖函数名 geminiToOpenAI / bodyHasImages / filterCandidatesForImages，
 *         改名会让本脚本报错 —— 这是刻意的。
 *
 * 跑法：node test/gemini-multimodal.test.js     （零依赖，退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');

/* ── 抠函数：按花括号配对 ─────────────────────────────────────────────────── */
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

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← 实际: ' + JSON.stringify(extra) : '')); }
}
const G = (t) => console.log('\n' + t);

/* ── 装配：把真实源码塞进沙箱 ────────────────────────────────────────────── */
let api;
try {
  const constLine = (src.match(/const IMAGE_CAPABLE_PROTOCOLS = \[[^\]]*\];/) || [])[0];
  if (!constLine) throw new Error('server.js 里找不到 IMAGE_CAPABLE_PROTOCOLS');
  const body = [
    constLine,
    extract('geminiToOpenAI'),
    extract('bodyHasImages'),
    extract('filterCandidatesForImages'),
    'return { geminiToOpenAI, bodyHasImages, filterCandidatesForImages, IMAGE_CAPABLE_PROTOCOLS };',
  ].join('\n');
  api = new Function(body)();
} catch (e) {
  console.error('✗ 装配失败：' + e.message);
  process.exit(1);
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/* ═══════ 1. inlineData（客户端把图片当 base64 发过来） ═══════ */
function testInline() {
  G('1. Gemini inlineData → OpenAI image_url');
  const out = api.geminiToOpenAI({
    contents: [{
      role: 'user',
      parts: [
        { text: '这张图里是什么颜色？' },
        { inlineData: { mimeType: 'image/png', data: PNG } },
      ],
    }],
  }, 'gemini-3.8-flash');

  const msg = out.messages[0];
  check('含图时 content 用 block 数组', Array.isArray(msg.content), msg.content);
  check('block 顺序与 Gemini parts 一致（先文后图）',
    msg.content[0].type === 'text' && msg.content[1].type === 'image_url', msg.content.map((b) => b.type));
  check('文本内容原样保留', msg.content[0].text === '这张图里是什么颜色？');
  check('图片转成 data URL（mime 正确）',
    msg.content[1].image_url.url === 'data:image/png;base64,' + PNG);
  check('base64 数据零改动（未被截断/重编码）',
    msg.content[1].image_url.url.split(',')[1] === PNG);
  check('模型名透传', out.model === 'gemini-3.8-flash');
}

/* ═══════ 2. 命名变体与缺省值（真实客户端两种命名都用） ═══════ */
function testVariants() {
  G('2. 命名变体：inline_data / mime_type / file_data');
  const snake = api.geminiToOpenAI({
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: 'AAA' } }] }],
  }, 'm');
  check('snake_case inline_data 也能识别',
    snake.messages[0].content[0].image_url.url === 'data:image/jpeg;base64,AAA');

  const noMime = api.geminiToOpenAI({
    contents: [{ role: 'user', parts: [{ inlineData: { data: 'BBB' } }] }],
  }, 'm');
  check('缺 mimeType 时默认 image/png（不产生 undefined）',
    noMime.messages[0].content[0].image_url.url === 'data:image/png;base64,BBB');

  const file = api.geminiToOpenAI({
    contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'image/png', fileUri: 'https://example.com/a.png' } }] }],
  }, 'm');
  check('fileData(fileUri) 转成直链 image_url',
    file.messages[0].content[0].image_url.url === 'https://example.com/a.png');

  const empty = api.geminiToOpenAI({
    contents: [{ role: 'user', parts: [{ inlineData: {} }] }],
  }, 'm');
  check('空 inlineData 不产生垃圾 block（无 data 时忽略）', empty.messages.length === 0, empty.messages);
}

/* ═══════ 3. 纯文本 / 系统指令 / 生成参数（不能因本次改动而回归） ═══════ */
function testBackCompat() {
  G('3. 纯文本与既有字段不回归');
  const txt = api.geminiToOpenAI({
    systemInstruction: { parts: [{ text: '你是严谨的助手' }] },
    contents: [{ role: 'user', parts: [{ text: '你好' }] }, { role: 'model', parts: [{ text: '你好，请说' }] }],
    generationConfig: { maxOutputTokens: 512, temperature: 0.3, topP: 0.9 },
    stream: true,
  }, 'm');
  check('纯文本仍用字符串形态（兼容只认 string 的上游）',
    typeof txt.messages[1].content === 'string', txt.messages[1].content);
  check('systemInstruction → system 消息',
    txt.messages[0].role === 'system' && txt.messages[0].content === '你是严谨的助手');
  check('model 角色 → assistant', txt.messages[2].role === 'assistant');
  check('generationConfig 映射（maxOutputTokens→max_tokens / topP→top_p）',
    txt.max_tokens === 512 && txt.temperature === 0.3 && txt.top_p === 0.9);
  check('stream 透传', txt.stream === true);

  const tool = api.geminiToOpenAI({
    contents: [{ role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: '上海' } } }] }],
  }, 'm');
  check('functionCall 仍降级为可读文本（工具仿真链未回归）',
    typeof tool.messages[0].content === 'string' && tool.messages[0].content.includes('get_weather'));
}

/* ═══════ 4. 图片能力门：含图请求不得落到转不了图的渠道 ═══════ */
function testImageGate() {
  G('4. 含图请求的候选裁剪（防止静默丢图）');
  const withImg = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }] };
  const textOnly = { messages: [{ role: 'user', content: '你好' }] };
  const legacyImg = { messages: [{ role: 'user', content: [{ type: 'image', source: { data: 'AA' } }] }] };

  check('bodyHasImages 认 image_url block', api.bodyHasImages(withImg) === true);
  check('bodyHasImages 认旧式 image block', api.bodyHasImages(legacyImg) === true);
  check('bodyHasImages 纯文本为 false', api.bodyHasImages(textOnly) === false);
  check('bodyHasImages 容忍空 body / 缺 messages', api.bodyHasImages({}) === false && api.bodyHasImages(null) === false);

  const cands = [
    { channelId: 'a', protocol: 'openai' },
    { channelId: 'b', protocol: 'notion' },
    { channelId: 'c', protocol: 'workbuddy' },
    { channelId: 'd', protocol: 'openai' },
  ];
  const filtered = api.filterCandidatesForImages(cands, withImg);
  check('含图 → 只留 openai 协议渠道', filtered.length === 2 && filtered.every((c) => c.protocol === 'openai'),
    filtered.map((c) => c.channelId));
  check('纯文本 → 候选链原样不动（零行为变化）',
    api.filterCandidatesForImages(cands, textOnly) === cands);
  const noProto = api.filterCandidatesForImages([{ channelId: 'x' }], withImg);
  check('渠道未写 protocol 时按 openai 处理（配置默认值一致）', noProto.length === 1);
}

/* ═══════ 5. 原生 SDK 鉴权头（Gemini x-goog-api-key / Anthropic x-api-key） ═══════ */
function testAuthHeaders() {
  G('5. 原生 SDK 鉴权头（checkAuth）');
  const fn = extract('checkAuth');
  const mk = (NOAUTH, GATEWAY_KEY, ADMIN_KEY) => new Function('NOAUTH', 'GATEWAY_KEY', 'ADMIN_KEY', fn + '\nreturn checkAuth;')(NOAUTH, GATEWAY_KEY, ADMIN_KEY);
  const ck = mk(false, 'GW', 'AD');
  const req = (headers, url = '/gemini/v1beta/models/x:generateContent') => ({ headers, url });

  check('Bearer 网关密钥 → 放行', ck(req({ authorization: 'Bearer GW' }), 'gateway') === true);
  check('Gemini SDK 的 x-goog-api-key → 放行',
    ck(req({ 'x-goog-api-key': 'GW' }), 'gateway') === true);
  check('Anthropic SDK 的 x-api-key → 放行',
    ck(req({ 'x-api-key': 'GW' }), 'gateway') === true);
  check('?key= 查询参数（Gemini SDK 另一模式）→ 放行',
    ck(req({}, '/gemini/v1beta/models/x:generateContent?key=GW'), 'gateway') === true);
  check('错误的 x-goog-api-key → 拒绝（不无脑放行）',
    ck(req({ 'x-goog-api-key': 'NOPE' }), 'gateway') === false);
  check('★ 管理面不接受 x-api-key / x-goog-api-key（无提权）',
    ck(req({ 'x-api-key': 'AD' }), 'admin') === false && ck(req({ 'x-goog-api-key': 'AD' }), 'admin') === false);
  check('管理面 Bearer 正常', ck(req({ authorization: 'Bearer AD' }), 'admin') === true);
  check('NOAUTH=1 时全部放行（既有开发模式未变）',
    mk(true, 'GW', 'AD')(req({}), 'admin') === true);
}

/* ═══════ 6. 装配守卫：路由里真的接上了能力门 ═══════ */
function testWiring() {
  G('6. 装配守卫：三条客户端路由都接上了图片能力门');
  // 调用点写成「candidates = filterCandidatesForImages(candidates, …)」，定义行不带赋值，故按赋值形态计数
  const uses = (src.match(/candidates = filterCandidatesForImages\(candidates, /g) || []).length;
  check('openai / anthropic / gemini 三条路由各调用一次（共 3 处）', uses === 3, uses);
  // 1 处常量声明 + 3 处使用
  const msgs = (src.match(/NO_IMAGE_CHANNEL_MSG/g) || []).length;
  check('常量 1 处声明 + 3 处使用（不静默降级）', msgs === 4, msgs);
  check('能力门白名单目前只有 openai（新增可转图协议要同时改文档）',
    JSON.stringify(api.IMAGE_CAPABLE_PROTOCOLS) === '["openai"]', api.IMAGE_CAPABLE_PROTOCOLS);
  check('非流式 shim 同时提供 text() 与 json()（PT23 的回归防线）',
    /const shim = \{[\s\S]{0,240}?json: async \(\) => JSON\.parse\(text\)/.test(src));
}

/* ═══════ 7. 对照组：证明本测试抓得住"只认 text"的旧写法（防恒真） ═══════ */
function testControl() {
  G('7. 对照组（整改前的写法，必须被本测试抓住）');
  const old = (parts) => parts.filter((p) => p.text).map((p) => p.text).join('\n');   /* 旧实现：只看 text */
  const got = old([{ text: '看图' }, { inlineData: { mimeType: 'image/png', data: PNG } }]);
  check('旧写法把图片丢了（只剩文本）→ 本测试具备捕捉能力', got === '看图' && !got.includes(PNG));
}

testInline();
testVariants();
testBackCompat();
testImageGate();
testAuthHeaders();
testWiring();
testControl();

console.log('\n' + '─'.repeat(58));
console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
process.exit(fail ? 1 : 0);
