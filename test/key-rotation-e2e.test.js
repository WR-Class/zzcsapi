#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/key-rotation-e2e.test.js — 控制台轮换密钥（v1.18.5，真起进程，零依赖）
 *
 * 为什么需要它：密钥原来只来自环境变量（.env → compose → 进程），容器内改不了 .env，
 * 于是"轮换"只能是手改文件 + 重开容器。现在控制台「密钥管理」页可以直接轮换，
 * 轮换结果写进 config.json 的 auth 段，并且**优先级高于环境变量**。
 *
 * 这份用例守四件事，每件都对应一种真实翻车：
 *   ① 优先级别搞反：config.auth 必须压过 .env，否则"重启就把轮换顶回去"（看起来改了、其实没生效）；
 *   ② 落库别被顺手抹掉：auth 必须在 persistConfig 白名单里，否则保存任意渠道都会把轮换结果清掉；
 *   ③ 立即生效 + 旧密钥立即失效：轮换后旧密钥马上 401、新密钥马上 200，管理面与客户端面各自独立；
 *   ④ 准入要有底线：太短 / 带空格 / 含 change-me / 两把相同一律 400，且**被拒绝的值绝不能生效**。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）；本用例里的密钥全是假值。
 * 跑法：node test/key-rotation-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-keys-'));
const ENV_GW = 'env-gateway-key-0123456789';
const ENV_AD = 'change-me-admin-0123456789';   // 故意含 change-me：用来验证 keysInsecure 能由真变假
const NEW_GW = 'rotated-gateway-key-abcdef';
const NEW_AD = 'Rotated-Admin-Key-1234';   // 管理密钥复杂度门槛（v1.18.5）：大小写+数字+特殊字符四样齐全

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
  console.log('\n0. 装配守卫（优先级链、白名单、端点落位、准入规则）');
  check('启动时先应用 config.auth 再补首启生成（applyManagedKeys 在 resolveGeneratedKeys 之前）',
    /applyManagedKeys\(\);\s*\nresolveGeneratedKeys\(\);/.test(SRC));
  check('config.auth 压过环境变量（不是反过来）',
    /function applyManagedKeys\(\)[\s\S]{0,220}GATEWAY_KEY = String\(a\.gatewayKey\)[\s\S]{0,80}ADMIN_KEY = String\(a\.adminKey\)/.test(SRC));
  check('来源判定齐全：console / env / generated / none',
    /function keySourceOf\(kind\)/.test(SRC) && ["'console'", "'env'", "'generated'", "'none'"].every((s) => SRC.includes(s)));
  check('persistConfig 白名单含 auth（否则保存渠道会把轮换结果抹掉）', /\n\s*auth: \(config && config\.auth\) \|\| undefined,/.test(SRC));
  check('四个密钥管理端点都在 handleAdminApi 内（因此都受 admin 鉴权）', (() => {
    const apiIdx = SRC.indexOf('function handleAdminApi(');
    const apiEnd = SRC.indexOf('\nfunction ', apiIdx + 10);
    const paths = ['/admin/api/keys', '/admin/api/keys/generate', '/admin/api/keys/reset', '/admin/api/admin-key'];
    return paths.every((p) => {
      const i = SRC.indexOf(`'${p}'`);
      return i > apiIdx && (apiEnd < 0 || i < apiEnd);
    });
  })());
  check('keysInsecure 收敛成一个函数（/admin/api/config 与 /admin/api/keys 共用同一判据）',
    (SRC.match(/keysInsecureNow\(\)/g) || []).length >= 2 && !/keysInsecure: \/change-me\/i/.test(SRC));
  check('轮换即清零失败计数（旧密钥的失败不该让新密钥继续吃 429）',
    /function rotateKeys\([\s\S]{0,900}resetAuthFailCounters\(\)/.test(SRC)
    && /function resetAuthFailCounters\(\)[\s\S]{0,200}AUTH_FAIL\.admin = \{ n: 0, until: 0 \}[\s\S]{0,120}AUTH_FAIL\.gateway = \{ n: 0, until: 0 \}/.test(SRC));
  check('轮换结果落库走 persistConfig（不是只改内存）', /function rotateKeys\([\s\S]{0,900}persistConfig\(\)/.test(SRC));
  check('生成用 crypto.randomInt 从四池字符里抽（48 位，四样字符齐全——管理密钥复杂度门槛对随机生成同样成立）',
    /function genKey\(\) \{[\s\S]{0,500}crypto\.randomInt/.test(SRC));
  check('NOAUTH 下 reset 不会凭空把鉴权打开',
    /function resetManagedKeys\(\)[\s\S]{0,400}if \(!NOAUTH\)/.test(SRC));

  /* ─────────────────── 1. 准入规则真值表 ─────────────────── */
  console.log('\n1. 准入规则（现抠 normNewKey 跑真值表）');
  try {
    const fnSrc = 'const KEY_MIN_LEN = 8, KEY_MAX_LEN = 128;\n' + extract('normNewKey');
    const norm = new Function(fnSrc + '\nreturn normNewKey;')();
    const bad = (v, other) => !!norm(v, '网关密钥', other).error;
    const badAdm = (v, other) => !!norm(v, '管理密钥', other, 'admin').error;
    check('太短 → 拒绝（7 位）', bad('a'.repeat(7)));
    check('8 位 → 通过（边界）', !bad('a'.repeat(8)));
    check('128 位 → 通过（上边界）；129 位 → 拒绝', !bad('a'.repeat(128)) && bad('a'.repeat(129)));
    check('带空格 → 拒绝（HTTP 头里会被截断，表现为时好时坏的 401）', bad('abc def ghij klmno'));
    check('含中文 → 拒绝', bad('网关密钥abcdefghijklm'));
    check('含制表符 → 拒绝', bad('abcdefghij\tklmnop'));
    check('含 change-me → 拒绝（示例默认串，体检会判不安全）', bad('my-change-me-key-123456'));
    check('与另一把相同 → 拒绝', bad('same-key-0123456789', 'same-key-0123456789'));
    check('首尾空白会被 trim 后再校验', norm('   abcdefghijklmnop   ', '网关密钥').key === 'abcdefghijklmnop');
    check('空串 → 拒绝', bad('') && bad(null) && bad(undefined));
    // 管理密钥复杂度门槛（v1.18.5）：大小写字母 + 数字 + 特殊字符四样齐全；网关密钥无此要求
    check('管理密钥：纯小写 → 拒绝', badAdm('abcdefgh'));
    check('管理密钥：缺大写 → 拒绝', badAdm('abcdefg1!'));
    check('管理密钥：缺小写 → 拒绝', badAdm('ABCDEFG1!'));
    check('管理密钥：缺数字 → 拒绝', badAdm('Abcdefg!'));
    check('管理密钥：缺特殊字符 → 拒绝', badAdm('Abcdefg1'));
    check('管理密钥：四样齐全 8 位 → 通过（边界）', !badAdm('Abcdef1!'));
    check('管理密钥：复杂度错误文案列出缺的类别', norm('abcdefgh', '管理密钥', null, 'admin').error.includes('大写字母'));
    check('网关密钥：纯小写 8 位 → 通过（无复杂度门槛）', !bad('abcdefgh'));
  } catch (e) {
    fail++; console.log('  ✗ 准入规则真值表跑不起来: ' + e.message);
  }

  /* ─────────────────── 2. 真链路 ─────────────────── */
  console.log('\n2. 真链路（临时网关，轮换 → 立即生效 → 重启仍生效 → 回退）');
  const GW = await freePort();
  const cfgPath = path.join(TMP, 'keys.json');
  const writeCfg = () => fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
    channels: [{ id: 'mock-kr', name: 'KR', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-kr', priority: 10, enabled: true, models: { 'mock-kr': 'mock-kr' } }],
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

  const jfetch = async (p, opts) => {
    const r = await fetch(`http://127.0.0.1:${GW}${p}`, opts);
    return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
  };
  const asAdmin = (key) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + key });
  const getKeys = (key) => jfetch('/admin/api/keys', { headers: asAdmin(key) });
  const postKeys = (body, key) => jfetch('/admin/api/keys', { method: 'POST', headers: asAdmin(key), body: JSON.stringify(body) });
  const genKeys = (body, key) => jfetch('/admin/api/keys/generate', { method: 'POST', headers: asAdmin(key), body: JSON.stringify(body) });
  const resetKeys = (key) => jfetch('/admin/api/keys/reset', { method: 'POST', headers: asAdmin(key), body: '{}' });
  const configView = (key) => jfetch('/admin/api/config', { headers: asAdmin(key) });
  const clientHit = async (key) => {
    const r = await fetch(`http://127.0.0.1:${GW}/v1/models`, { headers: { Authorization: 'Bearer ' + key } });
    await r.text();
    return r.status;
  };

  try {
    writeCfg();
    if (!await spawnGw('1')) throw new Error('临时网关未起来');

    /* ① 起始状态：来自环境变量 */
    const k0 = await getKeys(ENV_AD);
    check('GET /admin/api/keys 带 admin → 200', k0.status === 200, k0.status);
    check('两把密钥的来源都是 env', k0.body.gatewayKey.source === 'env' && k0.body.adminKey.source === 'env', { g: k0.body.gatewayKey, a: k0.body.adminKey });
    check('只给掩码：正文里不含任何一把真密钥',
      !JSON.stringify(k0.body).includes(ENV_GW) && !JSON.stringify(k0.body).includes(ENV_AD));
    check('掩码形态正确（头 4 … 尾 4）', k0.body.gatewayKey.masked === ENV_GW.slice(0, 4) + '…' + ENV_GW.slice(-4), k0.body.gatewayKey.masked);
    check('起始 keysInsecure=true（admin 密钥含 change-me）', k0.body.keysInsecure === true);
    check('不带密钥 → 401（这个页面对匿名不可见）', (await getKeys('nope-nope-nope-1234')).status === 401);

    /* ② 准入：被拒绝的值绝不能生效 */
    const rejects = [
      ['太短', { gatewayKey: 'short' }],
      ['带空格', { gatewayKey: 'has space in it 123' }],
      ['含 change-me', { gatewayKey: 'change-me-gateway-123' }],
      ['两把相同', { adminKey: ENV_GW }],
      ['管理密钥缺数字和特殊字符', { adminKey: 'abcdefgh' }],
      ['空报文', {}],
      ['未知字段', { gatewayKEy: NEW_GW }],
    ];
    for (const [label, body] of rejects) {
      const r = await postKeys(body, ENV_AD);
      check('拒绝 ' + label + ' → 400', r.status === 400 && !!r.body.error, { s: r.status, e: r.body && r.body.error });
    }
    const stillEnv = await getKeys(ENV_AD);
    check('被拒绝的值没有生效（来源仍是 env）', stillEnv.body.gatewayKey.source === 'env' && stillEnv.body.adminKey.source === 'env');
    check('被拒绝的值没有落库（config.json 里没有 auth）', JSON.parse(fs.readFileSync(cfgPath, 'utf8')).auth === undefined);
    check('客户端面此刻仍是环境变量那把密钥', (await clientHit(ENV_GW)) === 200);

    /* ③ 轮换网关密钥：立即生效、旧密钥立即失效 */
    const rot1 = await postKeys({ gatewayKey: NEW_GW }, ENV_AD);
    check('轮换网关密钥 → 200', rot1.status === 200, rot1.status);
    check('响应把新值回给调用方一次（控制台要拿它去更新自己）', rot1.body.newKeys && rot1.body.newKeys.gatewayKey === NEW_GW, rot1.body.newKeys);
    check('新来源 = console', rot1.body.gatewayKey.source === 'console', rot1.body.gatewayKey.source);
    check('管理密钥没被牵连（仍是 env）', rot1.body.adminKey.source === 'env');
    check('旧网关密钥立即 401（不设宽限期，这是明确选择）', (await clientHit(ENV_GW)) === 401);
    check('新网关密钥立即 200（不用重启）', (await clientHit(NEW_GW)) === 200);
    check('管理面仍用原 admin 密钥可进（两类密钥互不影响）', (await getKeys(ENV_AD)).status === 200);
    const disk1 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    check('落库：config.json 的 auth.gatewayKey = 新值', disk1.auth && disk1.auth.gatewayKey === NEW_GW);
    check('落库：auth.updatedAt 有值', !!(disk1.auth && disk1.auth.updatedAt));
    check('落库：渠道列表没被顺手抹掉', Array.isArray(disk1.channels) && disk1.channels.length === 1);

    /* ④ 轮换管理密钥：当前会话换钥匙、旧管理密钥立即失效 */
    const rot2 = await postKeys({ adminKey: NEW_AD }, ENV_AD);
    check('轮换管理密钥 → 200', rot2.status === 200, rot2.status);
    check('keysInsecure 由真变假（两把都不再含 change-me）', rot2.body.keysInsecure === false);
    check('旧管理密钥立即 401', (await getKeys(ENV_AD)).status === 401);
    check('新管理密钥立即 200', (await getKeys(NEW_AD)).status === 200);
    check('网关密钥仍是刚才轮换的那把（没被第二次请求顺手重置）', (await clientHit(NEW_GW)) === 200 && (await clientHit(ENV_GW)) === 401);
    check('/admin/api/config 的 keysInsecure 同步变假', (await configView(NEW_AD)).body.keysInsecure === false);
    const revealAd = await jfetch('/admin/api/admin-key', { headers: asAdmin(NEW_AD) });
    check('按需揭示管理密钥（与 /admin/api/gateway-key 对称）', revealAd.status === 200 && revealAd.body.adminKey === NEW_AD);
    check('揭示端点同样不外泄网关密钥', !JSON.stringify(revealAd.body).includes(NEW_GW));

    /* ⑤ 失败限流与轮换的交互：轮换清零计数 */
    for (let i = 0; i < 31; i++) await getKeys('wrong-key-' + i + '-0123456789');
    const blocked = await getKeys('wrong-key-after-threshold-01');
    check('连续失败到阈值 → 429 + Retry-After（v1.18.4 的限流仍有效）', blocked.status === 429 && !!blocked.headers.get('Retry-After'), { s: blocked.status, ra: blocked.headers.get('Retry-After') });
    const rot3 = await postKeys({ gatewayKey: NEW_GW }, NEW_AD);
    check('限流期间轮换请求本身被挡（429）——不给自己开后门', rot3.status === 429, rot3.status);

    /* ⑥ 重启：config.auth 必须压过环境变量 */
    await stopGw();
    if (!await spawnGw('2')) throw new Error('重启版网关未起来');
    check('重启后轮换过的网关密钥仍然有效（config.auth 压过 .env）', (await clientHit(NEW_GW)) === 200);
    check('重启后环境变量里那把旧密钥仍然无效', (await clientHit(ENV_GW)) === 401);
    const k2 = await getKeys(NEW_AD);
    check('重启后来源仍是 console（不是回落成 env）', k2.body.gatewayKey.source === 'console' && k2.body.adminKey.source === 'console', { g: k2.body.gatewayKey.source, a: k2.body.adminKey.source });
    check('重启后 updatedAt 还在（说明读的是落库的值）', !!k2.body.rotatedAt);
    check('重启后 keysInsecure 仍是 false', k2.body.keysInsecure === false);

    /* ⑦ 随机生成 + 回退 */
    const g1 = await genKeys({ target: 'gateway' }, NEW_AD);
    check('随机生成网关密钥 → 200', g1.status === 200, g1.status);
    const genGw = (g1.body.newKeys || {}).gatewayKey;
    check('生成的是 48 位可见 ASCII', /^[\x21-\x7e]{48}$/.test(genGw || ''), String(genGw).length);
    check('生成后立即生效、旧的一把立即失效', (await clientHit(genGw)) === 200 && (await clientHit(NEW_GW)) === 401);
    check('只生成网关密钥时管理密钥不动', (await getKeys(NEW_AD)).status === 200);
    const g2 = await genKeys({ target: 'admin' }, NEW_AD);
    const genAd = (g2.body.newKeys || {}).adminKey;
    check('单独生成管理密钥 → 200，且新值可用', g2.status === 200 && (await getKeys(genAd)).status === 200);
    check('生成的管理密钥自带复杂度（大小写+数字+特殊字符齐全）',
      /[a-z]/.test(genAd) && /[A-Z]/.test(genAd) && /[0-9]/.test(genAd) && /[^a-zA-Z0-9]/.test(genAd));
    const g3 = await genKeys({ target: 'both' }, genAd);
    const genBoth = g3.body.newKeys || {};
    check('一次生成两把 → 200，且两把都可用',
      g3.status === 200 && (await getKeys(genBoth.adminKey)).status === 200 && (await clientHit(genBoth.gatewayKey)) === 200);
    check('生成的两把不相同', !!genBoth.gatewayKey && genBoth.gatewayKey !== genBoth.adminKey);
    check('生成后旧的网关密钥立即失效', (await clientHit(genGw)) === 401);

    /* ⑧ 回退：丢掉控制台覆盖，回到「环境变量 → 首启生成」 */
    const rs = await resetKeys(genBoth.adminKey);
    check('回退到环境变量 → 200', rs.status === 200, rs.status);
    check('回退后来源变回 env', rs.body.gatewayKey.source === 'env' && rs.body.adminKey.source === 'env', { g: rs.body.gatewayKey.source, a: rs.body.adminKey.source });
    check('回退后环境变量那把网关密钥又可用', (await clientHit(ENV_GW)) === 200);
    check('回退后刚才生成的网关密钥失效', (await clientHit(genBoth.gatewayKey)) === 401);
    check('回退后 keysInsecure 又变回 true（env 的 admin 密钥含 change-me）', rs.body.keysInsecure === true);
    check('回退后 config.json 里不再有 auth 段', JSON.parse(fs.readFileSync(cfgPath, 'utf8')).auth === undefined);
    check('回退是管理密钥鉴权下的操作，仍然只认 admin', (await getKeys(ENV_GW)).status === 401);
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
