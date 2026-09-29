#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/admin-session-e2e.test.js — 管理面会话 cookie（v1.18.6，真起进程，零依赖）
 *
 * 为什么需要它（渗透第三批）：管理密钥原来常驻浏览器 localStorage（任何 XSS 都能读到这把
 * 永久主钥匙），?key= 又会把密钥写进浏览器历史。整改后浏览器改走「登录门交一次密钥 →
 * 换回 HttpOnly + SameSite=Strict 会话 cookie」；脚本/CI 仍用 Bearer 直连管理面。
 *
 * 这份用例守五件事，每件都对应一种真实翻车：
 *   ① 端点落位：/admin/api/session 必须在 authGate 之前（登录时手里还没有会话），
 *      且登录失败计入 admin 失败限流（瞎试密钥与瞎试接口同等对待）；
 *   ② 旗标一个不少：HttpOnly（JS 读不到）+ SameSite=Strict（顺带治 CSRF）+ Max-Age 12h +
 *      Path=/；刻意无 Secure（本网关设计上跑 http 本地/局域网，加了反而种不下去）；
 *   ③ 会话单独鉴权：管理面只带 cookie 就能进；Bearer 通道原样保留；管理面 ?key= 已拆
 *      （正确密钥走查询串也 401）、客户端面 ?key= 保留（Gemini SDK 另一模式）；
 *   ④ 换锁语义：轮换/重置管理密钥清空全部会话，但给发起轮换的那个响应补发新会话
 *      （控制台不会把自己踢回登录门）；退出登录只杀自己那枚 token；
 *   ⑤ 重启语义：会话表在内存，重启全部掉线（刻意接受的代价）——Bearer 仍活（config.auth 落库）。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）；密钥全是假值。
 * 跑法：node test/admin-session-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-sess-'));
const ENV_GW = 'e2e-gw-session-0123456789';
const ENV_AD = 'e2e-ad-session-0123456789';
const NEW_AD = 'Rotated-Session-Ad-1!';   // 管理密钥复杂度门槛：大小写+数字+特殊字符四样齐全

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

// 现抠某个函数（花括号配对），用于纯函数真值表
function extract(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到 ' + name);
  let depth = 0, started = false;
  for (let k = i; k < SRC.length; k++) {
    if (SRC[k] === '{') { depth++; started = true; }
    else if (SRC[k] === '}') { depth--; if (started && depth === 0) return SRC.slice(i, k + 1); }
  }
  throw new Error('花括号不配对 ' + name);
}

(async () => {
  /* ─────────────────── 0. 装配守卫（源码级） ─────────────────── */
  console.log('\n0. 装配守卫（会话表、端点落位、旗标、换锁语义、CSP）');
  check('会话常量齐：内存 Map + TTL 12 小时 + 上限 256 + cookie 名 zz_session',
    /const SESSIONS = new Map\(\)/.test(SRC) && /SESSION_TTL_MS = 12 \* 3600 \* 1000/.test(SRC) &&
    /SESSION_MAX = 256/.test(SRC) && /SESSION_COOKIE = 'zz_session'/.test(SRC));
  check('checkAuth：admin 会话分支在 Bearer 之前且成功计数清零',
    /if \(kind === 'admin' && sessionValid\(req\)\) \{ authOk\(kind\); return true; \}/.test(SRC));
  {
    const ca = extract('checkAuth');
    const notAdmin = ca.indexOf("if (kind !== 'admin')");
    const qk = ca.indexOf("searchParams.get('key')");
    check('★ checkAuth：?key= 只在 kind !== admin 块内（管理面已拆、客户端面保留）',
      notAdmin >= 0 && qk > notAdmin && ca.indexOf("searchParams.get('key')", qk + 1) < 0);
  }
  {
    // 用带 authGate 的那个 /admin/api/ 分支定位（前面还有一行 Cache-Control 同前缀，别撞错）
    const gateIdx = [...SRC.matchAll(/url\.pathname\.startsWith\('\/admin\/api\/'\)/g)]
      .map((m) => m.index).find((i) => SRC.slice(i, i + 160).includes("authGate(req, res, 'admin')"));
    const sessRoute = SRC.indexOf("url.pathname === '/admin/api/session'");
    check('★ 会话端点在 authGate 分支之前（登录时手里还没有会话）',
      sessRoute > 0 && gateIdx > 0 && sessRoute < gateIdx, { sessRoute, gateIdx });
  }
  check('登录计入 admin 失败限流：错密钥 authFail、对了 authOk、NOAUTH 放行',
    /const wait = authThrottle\('admin'\);/.test(SRC) &&
    /if \(!NOAUTH && !safeEqual\(key, ADMIN_KEY\)\) \{ authFail\('admin'\); return unauthorized\(res, 'admin'\); \}/.test(SRC) &&
    /authOk\('admin'\);\s*\n\s*res\.setHeader\('Set-Cookie', sessionCookieValue\(newSessionToken\(\)\)\)/.test(SRC));
  check('DELETE 退出：删自己的 token + 过期 cookie（Max-Age=0）+ 其余方法 405',
    /if \(req\.method === 'DELETE'\) \{[\s\S]{0,220}SESSIONS\.delete\(t\)[\s\S]{0,260}SameSite=Strict; Max-Age=0`/.test(SRC) &&
    /return sendJson\(res, 405, \{ error: 'method not allowed' \}\)/.test(SRC));
  check('★ 轮换管理密钥清空全部会话（换锁后旧会话不该继续开门）',
    /function rotateKeys\([\s\S]{0,900}if \(patch\.adminKey !== undefined\) clearSessions\(\);/.test(SRC));
  check('★ 回到环境变量值也清空全部会话（resetManagedKeys）',
    /function resetManagedKeys\(\)[\s\S]{0,600}clearSessions\(\);/.test(SRC));
  check('★ 轮换响应补发新会话：keys 路由给发起轮换的浏览器种新 cookie',
    /if \(patch\.adminKey !== undefined\) res\.setHeader\('Set-Cookie', sessionCookieValue\(newSessionToken\(\)\)\);/.test(SRC));
  check('周期清扫 10 分钟一次且 unref（不吊住进程事件循环）',
    /setInterval\(\(\) => \{[\s\S]{0,200}\}, 600000\)\.unref\(\)/.test(SRC));
  check('CSP 已进 SEC_HEADERS（逐字断言在 security-headers-e2e，这里守存在性）',
    /\['Content-Security-Policy', "default-src 'self'/.test(SRC));

  /* ─────────────────── 1. 纯函数真值表（现抠真实源码跑） ─────────────────── */
  console.log('\n1. 真值表（readSessionToken / sessionValid / sessionCookieValue / newSessionToken 逐出）');
  try {
    const rt = new Function('const SESSION_COOKIE="zz_session";\n' + extract('readSessionToken') + '\nreturn readSessionToken;')();
    check('无 cookie 头 → 空串', rt({ headers: {} }) === '');
    check('单枚 zz_session → 取到值', rt({ headers: { cookie: 'zz_session=abc' } }) === 'abc');
    check('混在多枚 cookie 里 → 认得出（前后都有别人）',
      rt({ headers: { cookie: 'other=x; zz_session=abc; y=z' } }) === 'abc');
    check('空值 → 空串（不是 undefined）', rt({ headers: { cookie: 'zz_session=' } }) === '');
    check('别人叫这个名（foo=zz_session）→ 不认', rt({ headers: { cookie: 'foo=zz_session' } }) === '');
    check('值里带等号 → 原样取回（indexOf 只劈第一刀）', rt({ headers: { cookie: 'zz_session=a=b' } }) === 'a=b');
    check('前后有空白 → trim 后认得', rt({ headers: { cookie: ' zz_session = tok123 ' } }) === 'tok123');
  } catch (e) { fail++; console.log('  ✗ readSessionToken 真值表跑不起来: ' + e.message); }

  try {
    const mk = new Function('SESSIONS', 'Date', 'const SESSION_COOKIE="zz_session";\n'
      + extract('readSessionToken') + '\n' + extract('sessionValid') + '\nreturn sessionValid;');
    const SESSIONS = new Map();
    const now = Date.now();
    const sv = mk(SESSIONS, Date);
    SESSIONS.set('alive', now + 60000);
    check('活 token → true', sv({ headers: { cookie: 'zz_session=alive' } }) === true);
    SESSIONS.set('dead', now - 1);
    const deadBefore = SESSIONS.size;
    check('过期 token → false', sv({ headers: { cookie: 'zz_session=dead' } }) === false);
    check('过期是懒删除（查一次就从表里消失）', SESSIONS.size === deadBefore - 1 && !SESSIONS.has('dead'));
    check('不存在的 token → false', sv({ headers: { cookie: 'zz_session=nope' } }) === false);
    check('没 cookie → false', sv({ headers: {} }) === false);
    check('重复查已删的过期 token 仍 false（不复活）', sv({ headers: { cookie: 'zz_session=dead' } }) === false);
  } catch (e) { fail++; console.log('  ✗ sessionValid 真值表跑不起来: ' + e.message); }

  try {
    const scv = new Function('const SESSION_TTL_MS=12*3600*1000; const SESSION_COOKIE="zz_session";\n'
      + extract('sessionCookieValue') + '\nreturn sessionCookieValue;')();
    const v = scv('tok'.repeat(5));
    check('cookie 串四旗标齐：HttpOnly / SameSite=Strict / Max-Age=43200 / Path=/',
      /HttpOnly/.test(v) && /SameSite=Strict/.test(v) && /Max-Age=43200/.test(v) && /Path=\//.test(v));
    check('★ 刻意不带 Secure（http 本地/局域网部署，加了反而种不下去）', !/Secure/i.test(v));
    check('键名与值原样拼接（zz_session=值）', v.startsWith('zz_session=toktoktoktoktok'));
  } catch (e) { fail++; console.log('  ✗ sessionCookieValue 真值表跑不起来: ' + e.message); }

  try {
    const mk2 = new Function('crypto', 'SESSIONS', 'const SESSION_TTL_MS=43200000; const SESSION_MAX=2;\n'
      + extract('newSessionToken') + '\nreturn newSessionToken;');
    const SESSIONS = new Map();
    const gen = mk2(require('crypto'), SESSIONS);
    const t1 = gen(), t2 = gen();
    check('token 是 64 位十六进制（32 字节随机量）且两枚互不相同', /^[0-9a-f]{64}$/.test(t1) && t1 !== t2);
    /* 场景 A：表满（2/2）但有过期可清 → 只清过期，一枚活会话都不动（不过度逐人） */
    SESSIONS.clear();
    SESSIONS.set('stale', Date.now() - 1);
    SESSIONS.set('alive1', Date.now() + 60000);
    const tA = gen();
    check('★ 表满时先清过期：stale 消失、alive1 原地不动（不过度逐人）',
      !SESSIONS.has('stale') && SESSIONS.has('alive1') && SESSIONS.has(tA) && SESSIONS.size === 2,
      [...SESSIONS.keys()]);
    /* 场景 B：表满且全是活的 → 逐一枚最旧的（插入序最前），表不超上限 */
    SESSIONS.clear();
    const a1 = gen(), a2 = gen();
    const a3 = gen();
    check('没有过期可清时：逐最旧那枚（a1 出局、a2/a3 都在），表恒不超上限',
      !SESSIONS.has(a1) && SESSIONS.has(a2) && SESSIONS.has(a3) && SESSIONS.size === 2,
      [...SESSIONS.keys()]);
  } catch (e) { fail++; console.log('  ✗ newSessionToken 逐出真值表跑不起来: ' + e.message); }

  /* ─────────────────── 2. 真链路（登录 → cookie 鉴权 → 退出 → 换锁 → 重启） ─────────────────── */
  console.log('\n2. 真链路（临时网关：登录换 cookie → 会话单独鉴权 → 退出 → 轮换换锁 → 重启掉线）');
  const GW = await freePort();
  const cfgPath = path.join(TMP, 'sess.json');
  const writeCfg = () => fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
    channels: [{ id: 'mock-sess', name: 'SS', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-ss', priority: 10, enabled: true, models: { 'mock-sess': 'mock-sess' } }],
  }, null, 2));

  let gwProc = null;
  const spawnGw = async (suffix) => {
    gwProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage' + suffix + '.json'), GATEWAY_KEY: ENV_GW, ADMIN_KEY: ENV_AD, ZZCSAPI_BIND: '127.0.0.1' },
      stdio: 'ignore',
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try { if ((await fetch(`http://127.0.0.1:${GW}/healthz`)).ok) return true; } catch { }
      await sleep(200);
    }
    return false;
  };
  const stopGw = () => new Promise((res) => {
    if (!gwProc || gwProc.exitCode !== null) return res();
    gwProc.once('exit', () => res());
    try { gwProc.kill(); } catch { }
    setTimeout(res, 1500);
  });

  const cookieOf = (token) => ({ 'Content-Type': 'application/json', Cookie: `zz_session=${token}` });
  const tokenFrom = (r) => {
    const sc = r.headers.get('set-cookie') || '';
    const m = sc.match(/zz_session=([0-9a-f]{64})/);
    return m ? m[1] : '';
  };
  const login = async (key) => {
    const r = await fetch(`http://127.0.0.1:${GW}/admin/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
    });
    return { status: r.status, headers: r.headers, setCookie: r.headers.get('set-cookie') || '', body: await r.json().catch(() => null) };
  };
  const logout = (token) => fetch(`http://127.0.0.1:${GW}/admin/api/session`, { method: 'DELETE', headers: { Cookie: `zz_session=${token}` } });
  const statusWith = (headers) => fetch(`http://127.0.0.1:${GW}/admin/api/status`, { headers });
  const rotateAdm = (token, newAdm) => fetch(`http://127.0.0.1:${GW}/admin/api/keys`, {
    method: 'POST', headers: cookieOf(token), body: JSON.stringify({ adminKey: newAdm }),
  });

  try {
    writeCfg();
    if (!await spawnGw('1')) throw new Error('临时网关未起来');

    /* ① 门口：无凭据 401；登录门在 authGate 之前（还没会话就能敲） */
    const anon = await statusWith({});
    check('无凭据 → 401（管理面对匿名不可见）', anon.status === 401, anon.status);
    await anon.text();
    const bad = await login('totally-wrong-key-0123456789');
    check('错密钥登录 → 401 且带错误文案（登录失败照常计入 admin 失败限流）',
      bad.status === 401 && !!(bad.body && bad.body.error), { s: bad.status, e: bad.body && bad.body.error });
    check('错密钥登录不下发 cookie', !tokenFrom(bad));

    /* ② 登录：换回会话 cookie */
    const ok1 = await login(ENV_AD);
    check('正确密钥登录 → 200', ok1.status === 200, ok1.status);
    check('响应带 expiresInSec=43200（12 小时，前端拿去提示会话时长）',
      !!(ok1.body && ok1.body.expiresInSec === 43200), ok1.body);
    check('★ Set-Cookie 旗标齐：HttpOnly / SameSite=Strict / Max-Age=43200 / Path=/',
      /HttpOnly/.test(ok1.setCookie) && /SameSite=Strict/.test(ok1.setCookie) &&
      /Max-Age=43200/.test(ok1.setCookie) && /Path=\//.test(ok1.setCookie), ok1.setCookie);
    check('★ 刻意无 Secure 旗标（http 本地/局域网部署是设计选择）', !/Secure/i.test(ok1.setCookie), ok1.setCookie);
    check('正文不回显任何密钥原文（密钥用完即弃）',
      !JSON.stringify(ok1.body || {}).includes(ENV_AD) && !JSON.stringify(ok1.body || {}).includes(ENV_GW));
    const token1 = tokenFrom(ok1);
    check('token 是 64 位十六进制', /^[0-9a-f]{64}$/.test(token1), token1.slice(0, 12));
    check('会话端点带 no-store（不进任何中间层缓存）', (ok1.headers.get('cache-control') || '') === 'no-store');

    /* ③ 会话单独鉴权：只带 cookie 就能进管理面 */
    const via1 = await statusWith({ Cookie: `zz_session=${token1}` });
    check('★ 只带会话 cookie（不带 Bearer）→ 管理面 200', via1.status === 200, via1.status);
    await via1.text();
    const bearerStill = await statusWith({ Authorization: 'Bearer ' + ENV_AD });
    check('★ Bearer 通道原样保留（脚本/CI 不受影响）', bearerStill.status === 200, bearerStill.status);
    await bearerStill.text();

    /* ④ ?key= 的两半：管理面拆、客户端面留 */
    const adUrl = await fetch(`http://127.0.0.1:${GW}/admin/api/status?key=${encodeURIComponent(ENV_AD)}`);
    check('★ 管理面 ?key= 已停用（正确管理密钥走查询串也 401）', adUrl.status === 401, adUrl.status);
    await adUrl.text();
    const gwUrl = await fetch(`http://127.0.0.1:${GW}/v1/models?key=${encodeURIComponent(ENV_GW)}`);
    check('★ 客户端面 ?key= 保留（Gemini SDK 另一鉴权模式）', gwUrl.status === 200, gwUrl.status);
    await gwUrl.text();

    /* ⑤ 多会话共存 + 退出只杀自己 */
    const ok2 = await login(ENV_AD);
    const token2 = tokenFrom(ok2);
    check('第二次登录给的是新 token（一登录一会话）', /^[0-9a-f]{64}$/.test(token2) && token2 !== token1);
    const both1 = await statusWith({ Cookie: `zz_session=${token1}` });
    await both1.text();
    check('两枚会话共存（token1 未被顶掉）', both1.status === 200, both1.status);
    const del = await logout(token1);
    const delCookie = del.headers.get('set-cookie') || '';
    check('退出登录 → 200 且 cookie 过期回写（Max-Age=0）',
      del.status === 200 && /zz_session=;/.test(delCookie) && /Max-Age=0/.test(delCookie), delCookie);
    await del.text();
    const gone1 = await statusWith({ Cookie: `zz_session=${token1}` });
    await gone1.text();
    check('★ 退出后旧 token → 401', gone1.status === 401, gone1.status);
    const still2 = await statusWith({ Cookie: `zz_session=${token2}` });
    await still2.text();
    check('★ 退出只杀自己那枚（token2 仍 200）', still2.status === 200, still2.status);
    const m405 = await fetch(`http://127.0.0.1:${GW}/admin/api/session`);
    check('GET /admin/api/session → 405（只有 POST 登录 / DELETE 退出）', m405.status === 405, m405.status);
    await m405.text();

    /* ⑥ CSP 真响应头（真值断言在 security-headers-e2e，这里证明真的随响应下发） */
    const cp = await fetch(`http://127.0.0.1:${GW}/console`);
    const cspHead = cp.headers.get('content-security-policy') || '';
    await cp.text();
    check('CSP 随 /console 真实下发且以 default-src self 开头', cspHead.startsWith("default-src 'self'"), cspHead.slice(0, 40));
    check('CSP 兜底在场：connect-src self（偷到 cookie 也发不出去）', /connect-src 'self'/.test(cspHead));

    /* ⑦ 换锁：cookie 轮换管理密钥 → 清全会话 + 给发起页补发新会话 */
    const ok3 = await login(ENV_AD);
    const token3 = tokenFrom(ok3);
    const rot = await rotateAdm(token3, NEW_AD);
    const rotCookie = rot.headers.get('set-cookie') || '';
    const token4 = rotCookie.match(/zz_session=([0-9a-f]{64})/);
    check('★ 用会话 cookie 就能轮换管理密钥（POST /admin/api/keys）→ 200', rot.status === 200, rot.status);
    check('★ 轮换响应补发新会话（token4 ≠ token3，发起页不会被踢回登录门）',
      !!token4 && token4[1] !== token3, rotCookie.slice(0, 30));
    const rotBody = await rot.json().catch(() => null);
    check('轮换响应正文照常只给掩码与新值（不因 cookie 鉴权而泄漏别的）',
      !JSON.stringify(rotBody || {}).includes(ENV_GW) || !!(rotBody && rotBody.newKeys && rotBody.newKeys.adminKey === NEW_AD));
    const dead3 = await statusWith({ Cookie: `zz_session=${token3}` });
    await dead3.text();
    check('★ 轮换后 token3 立即 401（全部旧会话已清空）', dead3.status === 401, dead3.status);
    const alive4 = await statusWith({ Cookie: `zz_session=${token4 ? token4[1] : ''}` });
    await alive4.text();
    check('★ 补发的 token4 立即 200（换锁不换发起页的钥匙）', alive4.status === 200, alive4.status);
    const oldBearer = await statusWith({ Authorization: 'Bearer ' + ENV_AD });
    await oldBearer.text();
    const newBearer = await statusWith({ Authorization: 'Bearer ' + NEW_AD });
    await newBearer.text();
    check('旧管理密钥 Bearer → 401、新管理密钥 Bearer → 200（与 v1.18.5 语义一致）',
      oldBearer.status === 401 && newBearer.status === 200, { old: oldBearer.status, new: newBearer.status });
    const gwStill2 = await fetch(`http://127.0.0.1:${GW}/v1/models?key=${encodeURIComponent(ENV_GW)}`);
    await gwStill2.text();
    check('网关密钥全程不受牵连（客户端面 ?key= 仍 200）', gwStill2.status === 200, gwStill2.status);

    /* ⑧ 重启：内存会话全部掉线，Bearer 因 config.auth 落库仍活 */
    await stopGw();
    if (!await spawnGw('2')) throw new Error('重启版网关未起来');
    const dead4 = await statusWith({ Cookie: `zz_session=${token4 ? token4[1] : ''}` });
    await dead4.text();
    check('★ 重启后所有会话掉线（内存表，刻意接受的代价——文档写明）', dead4.status === 401, dead4.status);
    const newBearer2 = await statusWith({ Authorization: 'Bearer ' + NEW_AD });
    await newBearer2.text();
    check('★ 重启后新管理密钥 Bearer 仍 200（config.auth 落库压过 env）', newBearer2.status === 200, newBearer2.status);
    const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    check('落库核对：config.auth.adminKey 就是轮换后的值（不是掩码）', !!(disk.auth && disk.auth.adminKey === NEW_AD));
    const again = await login(NEW_AD);
    check('重启后重新登录正常（拿新管理密钥换新会话）', again.status === 200 && /^[0-9a-f]{64}$/.test(tokenFrom(again)), again.status);
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopGw();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不 process.exit()：Windows 上撞到未关句柄会崩
})();
