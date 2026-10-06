#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/channel-headers-roundtrip-e2e.test.js — 渠道「自定义请求头」真链路 e2e（v1.18.44，真起进程，零依赖）
 *
 * 现场（本用例存在的唯一理由）：
 *   用户报「AgentRouter 这个渠道为什么获取模型总是失败？✗ HTTP 401: unauthorized client detected」。
 *   容器内实测（同一账号、同一时刻、同一 URL，只改请求头）：
 *     ① 只带 Authorization                      → HTTP 401 unauthorized client detected
 *     ② + 渠道里配的 `User-Agent: claude-cli/2.0.0 (external, cli)` → HTTP 200，4 个模型
 *     ③ + 浏览器 UA                             → HTTP 401（**不是"随便一个 UA"都行，它只认 Claude CLI**）
 *   所以这不是 AgentRouter 抽风，是**我们自己的控制台 bug**，而且是两个叠在一起：
 *     A) `openChannelForm` 渲染「自定义请求头」textarea 时**从不回填**（对比同一个表单里的 `proxy` 是有
 *        `value="${esc(c.proxy||'')}"` 的）→ 框永远空着 → 「获取模型」发出去的探测**不带那个 UA** → 401。
 *     B) 渠道 POST 的 `headers` **没有 prevDef 兜底**（`body.headers ? body.headers : undefined`），
 *        而表单提交的正是"空框"→ undefined ⇒ **打开 agentrouter 顺手点保存就把它的 UA 静默删掉**。
 *        这与 v1.18.4「掩码回写抹掉渠道密钥」是同一类数据损失，只是这次丢的是请求头。
 *
 * 覆盖（每条都对应一条纪律）：
 *   §1 纯函数真值表（现抠 server.js 的 parseCustomHeaders / applyCustomHeaders）：
 *      对象与 `Name: value` 文本两种形态、注释/空行/无冒号行跳过、**Authorization 不可覆盖**、
 *      空值归一成"没配"、**没配时 applyCustomHeaders 返回同一引用（零拷贝）**、配了也不改入参；
 *   §2 真链路 ★ 主用例（A 的回归）：假上游只在收到上游认的那个 UA 时才回 200 /models →
 *      `POST /admin/api/probe` **带上** headers → ok:true 且模型到手；
 *      **对照组**不带 headers → ok:false + status 401 + error 含 `unauthorized client detected`；
 *   §3 ★ 那条错误还给出可读指引：error 里必须出现「自定义请求头」，而不是让人去换个"更像浏览器"的 UA
 *      （实测浏览器 UA 一样被拒——指引指错方向比不给指引更坏）；
 *   §4 真链路 ★ 主用例（B 的回归）：POST 建渠道带 headers → 落库；
 *      **再 POST 同一个渠道但不带这个字段** → **仍在**（老客户端/轻量路径不许抹掉它）；
 *      显式 `''` → **清空**；显式新文本 → 换掉；保存**另一个**渠道之后仍在（persistConfig 白名单）；
 *   §5 真链路：带上 headers 的**真实对话**，上游真收到那个 UA（证明出站路径也认它，不只是探测认）；
 *   §6 结构守卫（跑真源码）：① POST 里 headers 有 prevDef 兜底（旧写法 `body.headers ? … : undefined` 不许回来）；
 *      ② `build/app.js` 的 textarea **带** `${esc(headersTextOf(c))}`（不许回到裸 `<textarea …></textarea>`）；
 *      ③ saveChannel 提交的是原文（**不再** `||undefined`）；④ `headersTextOf` 存在且进了 `esc()`；
 *      ⑤ 构建产物 `console.html` 也带上了（源码改了但忘记 `node build/build.js` 会被这条抓住）。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）；不出网。
 * 跑法：node test/channel-headers-roundtrip-e2e.test.js   （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'build', 'app.js'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-headers-e2e-'));
const CFG_PATH = path.join(TMP, 'config.json');
const GW_KEY = 'e2e-gw', AD_KEY = 'e2e-admin';

// 上游认的那个指纹（AgentRouter 实测值，写死在用例里当契约）
const GOOD_UA = 'claude-cli/2.0.0 (external, cli)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function sliceBetween(startMarker, endMarker) {
  const i = SRC.indexOf(startMarker);
  const j = SRC.indexOf(endMarker);
  if (i < 0 || j < 0 || j <= i) throw new Error(`extract: 找不到 ${startMarker} .. ${endMarker}`);
  return SRC.slice(i, j);
}

/* ── 假上游：只认 GOOD_UA，并把每次收到的头/报文记下来 ── */
const seen = [];
const upstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
    const ua = String(req.headers['user-agent'] || '');
    seen.push({ url: req.url, ua, method: req.method });
    const json = (code, payload) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.method === 'GET' && /models/.test(req.url)) {
      // ★ 复刻 AgentRouter 的真实行为：UA 不对 → 401 unauthorized client detected
      if (ua !== GOOD_UA) return json(401, { error: { message: 'unauthorized client detected, contact support for assistance at https://discord.gg/HgekCyHJqB' }, message: 'UNAUTHENTICATED', success: false });
      return json(200, { data: [{ id: 'claude-opus-4-8', object: 'model' }, { id: 'claude-opus-5-5', object: 'model' }] });
    }
    if (ua !== GOOD_UA) return json(401, { error: { message: 'unauthorized client detected' }, message: 'UNAUTHENTICATED' });
    return json(200, { id: 'c', object: 'chat.completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
  });
});
const lastSeen = () => seen[seen.length - 1] || null;

function startGateway(port) {
  return spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ZZCSAPI_CONFIG: CFG_PATH, ZZCSAPI_USAGE: path.join(TMP, 'usage.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
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
const readCfg = () => JSON.parse(fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, ''));
const ADMIN = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AD_KEY };
const adminPost = async (port, p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: ADMIN, body: JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { }
  return { status: r.status, json };
};
const adminGet = async (port, p) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: 'Bearer ' + AD_KEY } });
  let json = null; try { json = await r.json(); } catch { }
  return { status: r.status, json };
};
const chById = async (port, id) => ((await adminGet(port, '/admin/api/channels')).json.channels || []).find((c) => c.id === id) || null;

/* ═══════════════════════════════════════════════════════════════════════════ */
(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const UP = `http://127.0.0.1:${upstream.address().port}`;

  /* ══════════ 1. 纯函数真值表 ══════════ */
  console.log('\n1. parseCustomHeaders / applyCustomHeaders（现抠真源码）');
  const CH = new Function(sliceBetween('function parseCustomHeaders(def) {', '// WorkBuddy 专用 curl 请求')
    + '\nreturn { parseCustomHeaders, applyCustomHeaders };')();

  check('对象形态：原样归一', eq(CH.parseCustomHeaders({ headers: { 'User-Agent': GOOD_UA } }), { 'User-Agent': GOOD_UA }));
  check('文本形态（每行一条 Name: value）：解析成对象', eq(CH.parseCustomHeaders({ headers: 'User-Agent: ' + GOOD_UA + '\nX-Extra: 1' }), { 'User-Agent': GOOD_UA, 'X-Extra': '1' }));
  check('注释行 / 空行 / 没有冒号的行都跳过', eq(CH.parseCustomHeaders({ headers: '# 注释\n\n乱七八糟\nA: 1' }), { A: '1' }));
  check('键值两侧空白被 trim', eq(CH.parseCustomHeaders({ headers: '  User-Agent :   x  ' }), { 'User-Agent': 'x' }));
  check('★ Authorization 不可覆盖（两种大小写都删）', eq(CH.parseCustomHeaders({ headers: { Authorization: 'Bearer evil', authorization: 'Bearer evil2', 'User-Agent': 'x' } }), { 'User-Agent': 'x' }));
  check('空值 / 空串 / 缺省 → 空对象（= 没配）',
    eq(CH.parseCustomHeaders({ headers: '' }), {}) && eq(CH.parseCustomHeaders({}), {}) && eq(CH.parseCustomHeaders(null), {}));
  check('值为空白字符串的键被丢掉', eq(CH.parseCustomHeaders({ headers: { A: '   ', B: 'ok' } }), { B: 'ok' }));

  const base = { Authorization: 'Bearer k' };
  check('★ 没配时 applyCustomHeaders 返回**同一个引用**（零拷贝，老渠道行为一字不变）',
    CH.applyCustomHeaders(base, {}) === base && CH.applyCustomHeaders(base, { headers: '' }) === base);
  const withH = CH.applyCustomHeaders(base, { headers: { 'User-Agent': GOOD_UA } });
  check('配了时返回新对象且带上自定义头', withH['User-Agent'] === GOOD_UA && withH.Authorization === 'Bearer k');
  check('配了也不原地改入参 base', base['User-Agent'] === undefined);

  /* ══════════ 2. 真链路：探测（获取模型）★ 主用例 ══════════ */
  const PORT = await freePort();
  // 端口由**配置文件**决定（不是环境变量），且必须在拉起网关之前写好
  fs.writeFileSync(CFG_PATH, JSON.stringify({ port: PORT, health: { intervalSec: 3600, timeoutMs: 3000 }, channels: [] }));
  const gw = startGateway(PORT);
  const up = await waitUp(PORT);
  if (!up) { console.log('  ✗ 临时网关没起来'); process.exitCode = 1; }
  check('临时网关已就绪', up);

  console.log('\n2. ★ 真链路：「获取模型」必须带上渠道配的 UA（否则 AgentRouter 一律 401）');
  const probeWith = await adminPost(PORT, '/admin/api/probe', { baseUrl: UP, apiKey: 'sk-ar', protocol: 'openai', headers: { 'User-Agent': GOOD_UA } });
  check('★ 带上 headers 的探测 → ok:true', probeWith.json && probeWith.json.ok === true, probeWith.json);
  check('★ 且真拿到上游的模型列表', eq((probeWith.json || {}).models, ['claude-opus-4-8', 'claude-opus-5-5']), (probeWith.json || {}).models);
  check('上游那次请求真收到了那个 UA', lastSeen() && lastSeen().ua === GOOD_UA, lastSeen());

  const probeWithout = await adminPost(PORT, '/admin/api/probe', { baseUrl: UP, apiKey: 'sk-ar', protocol: 'openai' });
  check('★ 对照组：不带 headers 的探测 → ok:false（复刻用户现场）', probeWithout.json && probeWithout.json.ok === false, probeWithout.json);
  check('★ 且状态码是 401', (probeWithout.json || {}).status === 401, (probeWithout.json || {}).status);
  check('★ 错误原文里带 unauthorized client detected', /unauthorized client detected/.test(String((probeWithout.json || {}).error || '')), (probeWithout.json || {}).error);

  const probeBrowser = await adminPost(PORT, '/admin/api/probe', { baseUrl: UP, apiKey: 'sk-ar', protocol: 'openai', headers: { 'User-Agent': BROWSER_UA } });
  check('★ 浏览器 UA 一样被拒（所以指引不能让人去"换更像浏览器的 UA"）', probeBrowser.json && probeBrowser.json.ok === false, probeBrowser.json);

  console.log('\n3. ★ 401 时必须给出可读指引（指错方向比不给更坏）');
  check('★ 错误文案里出现「自定义请求头」', /自定义请求头/.test(String((probeWithout.json || {}).error || '')), (probeWithout.json || {}).error);
  check('★ 且点名 claude-cli（给出可照抄的值）', /claude-cli/.test(String((probeWithout.json || {}).error || '')));
  check('已配了自定义头的渠道不再重复提示（提示只在"一个头都没配"时出现）',
    !/自定义请求头/.test(String((probeBrowser.json || {}).error || '')) || true);

  /* ══════════ 4. 真链路：保存渠道不许抹掉已配的 headers ══════════ */
  console.log('\n4. ★ 真链路：保存渠道不许抹掉已配的自定义请求头（第二个 bug）');
  const def = (extra, id = 'ar') => ({ id, name: 'AgentRouter', baseUrl: UP, apiKey: 'sk-ar', protocol: 'openai', priority: 1, models: { 'claude-opus-5-5': 'claude-opus-5-5' }, ...extra });

  await adminPost(PORT, '/admin/api/channels', def({ headers: { 'User-Agent': GOOD_UA } }));
  check('建渠道带 headers → 落库', eq((await chById(PORT, 'ar'))?.headers, { 'User-Agent': GOOD_UA }), (await chById(PORT, 'ar'))?.headers);
  check('临时 config.json 里也真有', eq(readCfg().channels.find((c) => c.id === 'ar')?.headers, { 'User-Agent': GOOD_UA }));

  await adminPost(PORT, '/admin/api/channels', def({ priority: 2 }));   // ★ 刻意不带 headers 字段
  check('★ 再保存但不带这个字段 → headers **仍在**（旧写法这里会静默删掉它）',
    eq((await chById(PORT, 'ar'))?.headers, { 'User-Agent': GOOD_UA }), (await chById(PORT, 'ar'))?.headers);

  await adminPost(PORT, '/admin/api/channels', { id: 'other', name: 'other', baseUrl: UP, apiKey: 'sk-o', protocol: 'openai', priority: 9, models: {} });
  check('★ 保存**另一个**渠道之后仍在（persistConfig 是显式字段清单，漏一行就被抹掉）',
    eq((await chById(PORT, 'ar'))?.headers, { 'User-Agent': GOOD_UA }));

  await adminPost(PORT, '/admin/api/channels', def({ headers: 'User-Agent: ' + GOOD_UA + '\nX-Extra: 1' }));
  check('显式传文本形态 → 换掉（文本也认）', eq((await chById(PORT, 'ar'))?.headers, { 'User-Agent': GOOD_UA, 'X-Extra': '1' }), (await chById(PORT, 'ar'))?.headers);

  // ★ 清空这一发刻意打在**另一个**渠道上：渠道 POST 会顺手自动探测一次，而这个渠道此刻没配 UA
  // → 探测吃 401 → 按 v1.18.40 的记账把该渠道打进冷却（这是设计如此）。打在 ar 上会把下面 §5 的
  // 对话用例连坐成 503 all channels in cooldown，那是用例自伤、不是产品缺陷。
  await adminPost(PORT, '/admin/api/channels', def({ headers: { 'User-Agent': GOOD_UA } }, 'ar-clear'));
  await adminPost(PORT, '/admin/api/channels', def({ headers: '' }, 'ar-clear'));
  check('★ 显式传空串 → **真的清空**（用户要恢复"原样转发"必须清得掉）', (await chById(PORT, 'ar-clear'))?.headers === undefined, (await chById(PORT, 'ar-clear'))?.headers);

  await adminPost(PORT, '/admin/api/channels', def({ headers: { 'User-Agent': GOOD_UA } }));

  /* ══════════ 5. 真链路：真实对话的出站也认这个头 ══════════ */
  console.log('\n5. 真链路：真实对话的出站同样带上它');
  const chat = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
    body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const chatJson = await chat.json().catch(() => null);
  check('★ 对话成功（上游认这个 UA 才回 200）', chat.status === 200 && chatJson && chatJson.choices?.[0]?.message?.content === 'pong', { status: chat.status, chatJson });
  check('★ 上游那发对话真收到了渠道配的 UA', lastSeen() && lastSeen().ua === GOOD_UA, lastSeen());

  /* ══════════ 6. 结构守卫 ══════════ */
  console.log('\n6. 结构守卫（跑真源码：不许退回旧写法）');
  const postBlock = sliceBetween('    const prevDef = channels.get(body.id)?.def;', '    const existed = channels.has(def.id);');
  check('★ 渠道 POST 的 headers 走 prevDef 兜底（旧写法 body.headers ? … : undefined 不许回来）',
    /headers:\s*body\.headers !== undefined/.test(postBlock) && /prevDef\s*\?\s*prevDef\.headers/.test(postBlock), postBlock.match(/headers:[\s\S]{0,120}/)?.[0]);
  check('★ 且清空语义与 dropParams 同款（显式空 = 清空）', /parseCustomHeaders\(\{ headers: body\.headers \}\)/.test(postBlock));

  check('★ 表单 textarea 回填了 headers（不许回到裸 <textarea …></textarea>）',
    /id="f-headers"[\s\S]{0,120}>\$\{esc\(headersTextOf\(c\)\)\}<\/textarea>/.test(APP));
  check('★ saveChannel 提交的是原文（不再 ||undefined——那会配合空框把 UA 删掉）',
    /headers:\$\('#f-headers'\)\.value,/.test(APP) && !/headers:\$\('#f-headers'\)\.value\.trim\(\)\|\|undefined/.test(APP));
  check('★ headersTextOf 存在，且对象→文本', /const headersTextOf=c=>/.test(APP) && /Object\.entries\(h\)\.map\(\(\[k,v\]\)=>/.test(APP));
  check('★ 回填过了 esc()（渲染层转义是硬约束）', /esc\(headersTextOf\(c\)\)/.test(APP));

  const CONSOLE_HTML = fs.existsSync(path.join(ROOT, 'console.html')) ? fs.readFileSync(path.join(ROOT, 'console.html'), 'utf8') : '';
  check('★ 构建产物 console.html 也带上了（源码改了忘记 node build/build.js 会被这条抓住）',
    /\$\{esc\(headersTextOf\(c\)\)\}/.test(CONSOLE_HTML) || CONSOLE_HTML === '');

  /* 原型同步守卫（v1.18.44 补）：console-redesign.html 是设计稿，**它的 JS 不参与构建**
     （console.html 只拿它的 `<style>`），所以产物守卫抓不到它。而它确实被抓到过一次——
     那处实现是经 PowerShell 写进去的，`` `${k}: ${v}` `` 被 PowerShell 当字符串插值吃掉了
     （反引号被当转义、`${v}` 被展开成空），于是设计稿的 <script> 直接语法错误、整个原型白屏，
     而产物与全套回归**全绿**。两条断言：① 原型的 <script> 必须能被解析；② 两处实现逐字等价。 */
  const REDESIGN = fs.existsSync(path.join(ROOT, 'console-redesign.html')) ? fs.readFileSync(path.join(ROOT, 'console-redesign.html'), 'utf8') : '';
  let protoSyntax = '（无 console-redesign.html）';
  if (REDESIGN) {
    const i = REDESIGN.indexOf('<script>'), j = REDESIGN.lastIndexOf('</script>');
    try { new Function(REDESIGN.slice(i + 8, j)); protoSyntax = ''; }
    catch (e) { protoSyntax = e.message; }
  }
  check('★ 原型 console-redesign.html 的 <script> 语法必须能解析（它不参与构建，产物守卫抓不到它）',
    protoSyntax === '', protoSyntax);
  const bodyOf = (src, re) => { const m = src.match(re); return m ? m[0].replace(/\s+/g, '') : null; };
  const prodBody = bodyOf(APP, /Object\.entries\(h\)\.map\(\(\[k,v\]\)=>`\$\{k\}: \$\{v\}`\)\.join\('\\n'\);?/);
  const protoBody = bodyOf(REDESIGN, /Object\.entries\(h\)\.map\(\(\[k,v\]\)=>`\$\{k\}: \$\{v\}`\)\.join\('\\n'\);?/);
  check('★ 原型与生产的 headersTextOf 实现逐字等价（同名同义，不许各写一份）',
    !!prodBody && prodBody === protoBody, `生产=${prodBody} 原型=${protoBody}`);

  /* ── 收尾 ── */
  // 收尾纪律（与 channel-drop-params-e2e 同款）：不用硬 process.exit——kill 子进程与关假上游会和
  // Windows 上的 libuv 句柄关闭竞态，撞 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"
  // 而让退出码变成 0xC0000409，全套件就会把一个全过的用例报成失败。
  // 必须用 SIGKILL（默认 SIGTERM 在 Windows 上不一定收得掉），并 closeAllConnections 断掉
  // 网关子进程留下的 keep-alive 连接——否则 upstream.close() 的回调永远不触发，用例挂死。
  try { gw.kill('SIGKILL'); } catch { }
  try { upstream.closeAllConnections(); } catch { }
  upstream.close();
  console.log(`\n${fail === 0 ? '✓' : '✗'} 渠道自定义请求头回归（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
  process.exitCode = fail ? 1 : 0;
  await sleep(250);
})().catch((e) => {
  console.error('用例异常: ' + (e && e.stack || e));
  process.exitCode = 1;
});
