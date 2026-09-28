#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/security-headers-e2e.test.js — 第一批安全加固（v1.18.3，真起进程，零依赖）
 *
 * 守两件事，各对应一份外部渗透测试报告里的发现（F-03 / F-05）：
 *   ① 渲染层统一转义：控制台里所有外部可控值（模型名、渠道名/ID、上游错误文案）都必须经过 esc()。
 *      这是「任何持有 GATEWAY_KEY 的调用方 → 调用日志 → 管理端打开页面即执行脚本」那条链的唯一出路。
 *   ② 安全响应头与 no-store：nosniff / 防 iframe 嵌套 / 不发 Referer；管理面与 /healthz 不被缓存。
 *      CSP 刻意未加（控制台是内联脚本 + MiSans CDN），因此这里也不假装它存在。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/security-headers-e2e.test.js      （退出码非 0 表示有回归）
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-sec-'));
const GW_KEY = 'e2e-gw-sec', AD_KEY = 'e2e-admin-sec';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 240) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

(async () => {
  /* ─────────────────────── 0. 装配守卫（源码级） ─────────────────────── */
  console.log('\n0. 装配守卫：转义是否真的统一、响应头是否覆盖每一个请求');

  const bare = [
    '${c.name}', '${c.id}', '${c.proto}', '${l.m}', '${l.id}', '${l.p}', '${m.name}',
    '${protoLabel[c.proto]}', '${protoLabel[l.p]}', '${o.note}', '${x.note}',
  ];
  // toast(...) 的调用点允许保留裸值：toast 自己会把文案 esc 一次（在调用点再转义会双重转义）
  const bareLines = APP.split('\n').filter((line) => !line.includes('toast('));
  const leftovers = bare.filter((b) => bareLines.some((line) => line.includes(b)));
  check('build/app.js 里已无「裸插值」的外部可控字段（toast 调用点除外，它内部转义）', leftovers.length === 0, leftovers);

  check('toast 的错误文案走 esc（上游/服务端错误串不再当 HTML 渲染）',
    /el\.innerHTML=svg\([^)]*\)\+'<span>'\+esc\(msg\)\+'<\/span>';/.test(APP));
  check('esc() 覆盖四个 HTML 敏感字符集（& < > " \'）',
    /replace\(\/\[&<>"'\]\/g/.test(APP) && /'&':'&amp;'/.test(APP) && /""':'&quot;'/.test(APP.replace(/'/g, '"')) === false);
  check('data-t 里的模型名用 JSON.stringify + esc（引号/反斜杠都进不去属性）',
    /data-t="\$\{esc\(JSON\.stringify\(\{model:l\.m/.test(APP));

  const handlerIdx = SRC.indexOf('const server = http.createServer(');
  const secIdx = SRC.indexOf('const SEC_HEADERS = [');
  check('SEC_HEADERS 定义在 createServer 之前', secIdx > 0 && handlerIdx > secIdx, { secIdx, handlerIdx });
  check('四个头齐全：nosniff / DENY / no-referrer / Permissions-Policy',
    /'X-Content-Type-Options', 'nosniff'/.test(SRC) && /'X-Frame-Options', 'DENY'/.test(SRC) &&
    /'Referrer-Policy', 'no-referrer'/.test(SRC) && /'Permissions-Policy'/.test(SRC));
  const setIdx = SRC.indexOf('for (const [k, v] of SEC_HEADERS) res.setHeader(k, v);');
  const firstBranch = SRC.indexOf("url.pathname === '/'", handlerIdx);
  check('响应头在**任何分支之前**统一设置（含 401/404 与所有 API 响应）',
    setIdx > handlerIdx && setIdx < firstBranch, { setIdx, firstBranch });
  check('管理面与 /healthz 加 no-store',
    /url\.pathname\.startsWith\('\/admin\/api\/'\) \|\| url\.pathname === '\/healthz'\) res\.setHeader\('Cache-Control', 'no-store'\)/.test(SRC));
  check('CSP 未被偷偷加上（要加就得配套改前端并做浏览器验证）', !/Content-Security-Policy/.test(SRC));

  /* ── 第二批（v1.18.4）的装配守卫：密钥默认不下发、原文按需取、失败限流 ── */
  check('两处「渠道列表」下发掩码，写 config.json 的那处仍保留原文（否则写盘会把密钥覆盖成掩码）',
    (SRC.match(/maskSecret\(ch\.def\.apiKey\)/g) || []).length === 2 && /apiKey: ch\.def\.apiKey,/.test(SRC));
  check('POST 落库不再无条件写 body.apiKey（留空 = 保持原密钥）',
    !/^\s*apiKey: body\.apiKey,$/m.test(SRC) && /prevDef \? \{ apiKey: prevDef\.apiKey \}/.test(SRC));
  check('/admin/api/config 不再交出 adminKey 原文，改给 keysInsecure 布尔',
    /keysInsecure:/.test(SRC) && !/adminKey: ADMIN_KEY \|\| '',/.test(SRC));
  check('两个按需揭示端点都在管理面里（逐条取名，不再一次给全部）',
    /\/\^\\\/admin\\\/api\\\/channels\\\/\[\^\/\]\+\\\/key\$/.test(SRC) && SRC.includes("'/admin/api/gateway-key'"));
  check('恒定时间比较：sha256 + timingSafeEqual，且不再有拿 === 比密钥的写法',
    /crypto\.timingSafeEqual\(/.test(SRC) && /createHash\('sha256'\)/.test(SRC) && !/=== need/.test(SRC) && !/m\[1\] === need/.test(SRC));
  check('9 处鉴权点全部改走 authGate，checkAuth 只被闸门调用（定义 + 调用 = 2 处）',
    (SRC.match(/!authGate\(req, res, '/g) || []).length === 9 && (SRC.match(/checkAuth\(req, /g) || []).length === 2);
  check('失败限流是窗口式（30 次/分钟）且成功后清零，不是永久锁定',
    /AUTH_FAIL_MAX = 30/.test(SRC) && /AUTH_FAIL_WINDOW_MS = 60000/.test(SRC) && /authOk\(kind\)/.test(SRC));
  check('编辑表单的「明文」按钮会现取原文（表单已不回填密钥，光切 input.type 点了看不到东西）',
    /async function toggleKeyField\(\)[\s\S]{0,500}chKeyLive\(modalChId\)/.test(APP));
  check('控制台不再拿 CFG.gatewayKey 当密钥直用，改为按需取（chKeyLive / gwKeyLive）',
    APP.includes('async function gwKeyLive(') && APP.includes('async function chKeyLive(') &&
    !/CFG&&CFG\.gatewayKey\)\|\|''\)\}\}/.test(APP) && !/maskKey\(chKey\(/.test(APP));

  /* ─────────────────────── 1. 真链路 ─────────────────────── */
  console.log('\n1. 真链路（临时网关，逐条看真实响应头）');
  const up = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-sec' }] }));
  });
  const PU = await freePort(), GW = await freePort();
  await new Promise((r) => up.listen(PU, '127.0.0.1', r));
  const cfgPath = path.join(TMP, 'sec.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 1 },
    channels: [{ id: 'mock-sec', name: 'A', protocol: 'openai', baseUrl: `http://127.0.0.1:${PU}/v1`, apiKey: 'sk-a', priority: 10, enabled: true, models: { 'mock-sec': 'mock-sec' } },
    // 第二把（长密钥）专门用来核对掩码形态：短密钥只该显示成 ••••，长密钥给"头4…尾4"
    { id: 'mock-long', name: 'B', protocol: 'openai', baseUrl: `http://127.0.0.1:${PU}/v1`, apiKey: 'sk-abcdefghijklmnop', priority: 5, enabled: false, models: { 'mock-long': 'mock-long' } }],
  }));

  const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
    stdio: 'ignore',
  });
  let up2 = false;
  for (let t = Date.now(); Date.now() - t < 20000;) {
    try { if ((await fetch(`http://127.0.0.1:${GW}/healthz`)).ok) { up2 = true; break; } } catch { }
    await sleep(200);
  }
  check('临时网关起来了', up2);

  try {
    const cases = [
      ['/console', {}, 200],
      ['/healthz', {}, 200],
      ['/admin/api/status', { Authorization: 'Bearer ' + AD_KEY }, 200],
      ['/admin/api/status', {}, 401],
      ['/metrics', { Authorization: 'Bearer ' + AD_KEY }, 200],
      ['/v1/models', { Authorization: 'Bearer ' + GW_KEY }, 200],
      ['/nope-not-exist', {}, 404],
    ];
    for (const [p, headers, want] of cases) {
      const r = await fetch(`http://127.0.0.1:${GW}${p}`, { headers });
      const h = r.headers;
      const okCode = r.status === want;
      const okHeads = h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') === 'DENY' && h.get('referrer-policy') === 'no-referrer' && !!h.get('permissions-policy');
      check(`${p} → ${r.status}（期望 ${want}）且三个安全头齐全`, okCode && okHeads,
        { status: r.status, nosniff: h.get('x-content-type-options'), xfo: h.get('x-frame-options'), ref: h.get('referrer-policy') });
      await r.text();
    }

    const hz = await fetch(`http://127.0.0.1:${GW}/healthz`);
    check('/healthz 带 no-store', hz.headers.get('cache-control') === 'no-store', hz.headers.get('cache-control'));
    await hz.text();
    const st = await fetch(`http://127.0.0.1:${GW}/admin/api/status`, { headers: { Authorization: 'Bearer ' + AD_KEY } });
    check('/admin/api/* 带 no-store（含密钥与否都不该留在任何缓存里）', st.headers.get('cache-control') === 'no-store', st.headers.get('cache-control'));
    const stText = await st.text();

    const cp = await fetch(`http://127.0.0.1:${GW}/console`);
    const html = await cp.text();
    check('/console 页面本身不含任何密钥明文（壳是零机密）', !html.includes(GW_KEY) && !html.includes(AD_KEY));
    check('页面的缓存策略仍是 no-store（不受新头影响）', /no-store/.test(cp.headers.get('cache-control') || ''));
    check('产物里能看到转义后的渲染（esc(l.m) / esc(c.name) 都在）', html.includes('esc(l.m)') && html.includes('esc(c.name)'));

    /* ─────────── 2. 第二批（v1.18.4）：密钥默认不下发 + 按需揭示 + 失败限流 ─────────── */
    console.log('\n2. 第二批：管理面默认只给掩码、原文按需单取、连续失败限流');
    const B = `http://127.0.0.1:${GW}`;
    const ADMIN = { Authorization: 'Bearer ' + AD_KEY };
    const st2 = JSON.parse(stText);
    const chOf = (j, id) => (j.channels || []).find((c) => c.id === (id || 'mock-sec')) || {};
    check('渠道列表里只剩掩码：两把密钥的原文都不在下发',
      chOf(st2).apiKey === '••••' && chOf(st2, 'mock-long').apiKey === 'sk-a…mnop', (st2.channels || []).map((c) => c.apiKey));
    check('掩码形态：长密钥给「头4…尾4」（看得出是哪把、取不到原文）',
      chOf(st2, 'mock-long').apiKey === 'sk-a…mnop', chOf(st2, 'mock-long').apiKey);
    check('短密钥（长度≤8）只显示成 ••••，不泄漏任何字符', chOf(st2).apiKey === '••••', chOf(st2).apiKey);
    check('同时给 apiKeySet 布尔，控制台据此判"配没配"', chOf(st2).apiKeySet === true);
    check('整个 /admin/api/status 正文里没有任何一把真密钥（网关 / 管理 / 两把上游）',
      !stText.includes(GW_KEY) && !stText.includes(AD_KEY) && !stText.includes('"sk-a"') && !stText.includes('sk-abcdefghijklmnop'));
    const chsText = await (await fetch(`${B}/admin/api/channels`, { headers: ADMIN })).text();
    check('GET /admin/api/channels 同样只给掩码 + apiKeySet',
      !chsText.includes('"sk-a"') && !chsText.includes(GW_KEY) && chsText.includes('apiKeySet'));
    const cfgText = await (await fetch(`${B}/admin/api/config`, { headers: ADMIN })).text();
    const cfg = JSON.parse(cfgText);
    check('GET /admin/api/config 不再交出 GATEWAY_KEY / ADMIN_KEY 原文',
      !cfgText.includes(GW_KEY) && !cfgText.includes(AD_KEY) && cfg.adminKey === undefined);
    check('config 保留 required 两个布尔，并新增 keysInsecure（默认密钥判断挪到服务端）',
      cfg.gatewayKeyRequired === true && cfg.adminKeyRequired === true && cfg.keysInsecure === false);
    check('config 仍给出 urls（接入信息卡不依赖端口写死）', !!(cfg.urls && cfg.urls.openai));

    const rv = await fetch(`${B}/admin/api/channels/mock-sec/key`, { headers: ADMIN });
    check('按需揭示单渠道密钥：带 admin 能拿到原文', rv.status === 200 && (await rv.json()).apiKey === 'sk-a');
    const rv401 = await fetch(`${B}/admin/api/channels/mock-sec/key`);
    check('按需揭示端点照样要 admin（不带密钥 401）', rv401.status === 401);
    await rv401.text();
    const rv404 = await fetch(`${B}/admin/api/channels/nope/key`, { headers: ADMIN });
    check('揭示不存在的渠道 → 404', rv404.status === 404);
    await rv404.text();
    const gk = await fetch(`${B}/admin/api/gateway-key`, { headers: ADMIN });
    check('按需揭示网关密钥：带 admin 能拿到原文', gk.status === 200 && (await gk.json()).gatewayKey === GW_KEY);

    /* 控制台"编辑表单留空"那条路：真发一次不带 apiKey 的 POST，原密钥必须被保住 */
    const keep = await fetch(`${B}/admin/api/channels`, {
      method: 'POST',
      headers: { ...ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'mock-sec', name: 'A', baseUrl: `http://127.0.0.1:${PU}/v1`, protocol: 'openai', enabled: true, models: { 'mock-sec': 'mock-sec' } }),
    });
    const keepBody = await keep.text();
    const after = await (await fetch(`${B}/admin/api/channels/mock-sec/key`, { headers: ADMIN })).json();
    check('POST 不带 apiKey（控制台编辑的常态）→ 原密钥保留，不被空串/掩码覆盖',
      keep.status === 200 && after.apiKey === 'sk-a', { status: keep.status, after: after.apiKey, body: keepBody.slice(0, 120) });
    const fresh = await fetch(`${B}/admin/api/channels`, {
      method: 'POST',
      headers: { ...ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'brand-new', baseUrl: 'http://127.0.0.1:1/v1', protocol: 'openai' }),
    });
    const freshText = await fresh.text();
    check('新建渠道仍必须带 apiKey（放宽只作用于"已存在的渠道"）',
      fresh.status === 400 && /apiKey is required/.test(freshText), { status: fresh.status, body: freshText.slice(0, 120) });

    /* 管理面失败限流：连打错密钥到阈值后转 429 + Retry-After；客户端面不受牵连 */
    let last = 0, saw429 = false, ra = '';
    for (let i = 0; i < 32; i++) {
      const r = await fetch(`${B}/admin/api/status`, { headers: { Authorization: 'Bearer wrong-key' } });
      last = r.status;
      if (r.status === 429) { saw429 = true; ra = r.headers.get('retry-after') || ''; }
      await r.text();
    }
    check('管理面连续失败到阈值后返回 429 + Retry-After（原来是无上限的 401）', saw429 && last === 429 && Number(ra) > 0, { last, ra });
    const gwStill = await fetch(`${B}/v1/models`, { headers: { Authorization: 'Bearer ' + GW_KEY } });
    check('限流只作用于刚被爆破的那一类：客户端面照常可用', gwStill.status === 200);
    await gwStill.text();
  } finally {
    try { gw.kill(); } catch { }
    // 假上游也要关掉：否则它监听的句柄会让本进程的事件循环一直不退出
    await new Promise((r) => up.close(() => r()));
    await sleep(300);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  // 关掉所有句柄后事件循环应当自然结束；再兜一次超时，避免 CI 上挂住
  const hang = setTimeout(() => { console.log('（提示：句柄未完全释放，强制结束）'); process.exit(fail ? 1 : 0); }, 3000);
  hang.unref();
  if (fail) process.exitCode = 1;
})().catch((e) => { console.log('✗ 用例自身抛错：' + e.stack); process.exitCode = 1; });
