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
    channels: [{ id: 'mock-sec', name: 'A', protocol: 'openai', baseUrl: `http://127.0.0.1:${PU}/v1`, apiKey: 'sk-a', priority: 10, enabled: true, models: { 'mock-sec': 'mock-sec' } }],
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
    check('管理面返回的渠道数据里确实带明文 apiKey —— 这是第二批要改的事实，本批只保证渲染不执行它',
      stText.includes('apiKey'));
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
