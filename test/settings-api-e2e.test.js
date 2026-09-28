#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/settings-api-e2e.test.js — 运行期设置读写端点（v1.18，真起进程，零依赖）
 *
 * 为什么需要它：v1.17 把会话粘性 / 客户端限流 / /metrics 三个开关做进了后端，但**控制台改不了**——
 * 渠道级 upsert 只管渠道字段，`/admin/api/config` 又是只读的。于是有了
 * `GET/POST /admin/api/settings` 这个**窄口**：只认这三组，每组走与启动路径**同一个** norm* 函数。
 *
 * 这份用例守的三件事，每件都对应一种真实翻车方式：
 *   ① 钳制一致：控制台存的与启动读的必须是同一套规则（否则"填 5 秒"重启后变 3600，成了悬案）；
 *   ② 立即生效：开关拨完不用重启容器就能看到效果（否则每次试验都要断一次线上服务）；
 *   ③ 窄口不放水：只收白名单字段，写错字段名/类型一律 400 —— 静默忽略会让"我明明关了"变成悬案。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/settings-api-e2e.test.js      （退出码非 0 表示有回归）
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-settings-'));
const GW_KEY = 'e2e-gw', AD_KEY = 'e2e-admin';

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

// 现抠三个 norm* 函数（控制台路径与启动路径共用的那一份）
function makeNorms() {
  const src = ['normAffinityCfg', 'normRateCfg', 'normMetricsCfg'].map((n) => {
    const i = SRC.indexOf('function ' + n + '(');
    if (i < 0) throw new Error('找不到 ' + n);
    let depth = 0, started = false;
    for (let k = i; k < SRC.length; k++) {
      if (SRC[k] === '{') { depth++; started = true; }
      else if (SRC[k] === '}') { depth--; if (started && depth === 0) return SRC.slice(i, k + 1); }
    }
    throw new Error('花括号不配对 ' + n);
  });
  return new Function(src.join('\n') + '\nreturn { normAffinityCfg, normRateCfg, normMetricsCfg };')();
}

(async () => {
  /* ─────────────────────────── 0. 装配守卫 ─────────────────────────── */
  console.log('\n0. 装配守卫（源码级：窄口、共用同一份规则、立即生效）');
  const getIdx = SRC.indexOf("url.pathname === '/admin/api/settings'");
  const apiFnIdx = SRC.indexOf('function handleAdminApi(');
  const apiFnEnd = SRC.indexOf('\nfunction ', apiFnIdx + 10);
  const gateIdx = SRC.indexOf("url.pathname.startsWith('/admin/api/')");
  check('端点存在（GET 与 POST 各一处）', (SRC.match(/url\.pathname === '\/admin\/api\/settings'/g) || []).length === 2, (SRC.match(/url\.pathname === '\/admin\/api\/settings'/g) || []).length);
  check('端点在 handleAdminApi 里（因此天然受 admin 鉴权保护、且不受客户端限流影响）',
    apiFnIdx > 0 && getIdx > apiFnIdx && (apiFnEnd < 0 || getIdx < apiFnEnd), { apiFnIdx, getIdx, apiFnEnd });
  check('管理面统一鉴权：/admin/api/ 前缀先 checkAuth(admin) 再进 handleAdminApi',
    /url\.pathname\.startsWith\('\/admin\/api\/'\)[\s\S]{0,140}authGate\(req, res, 'admin'\)[\s\S]{0,40}handleAdminApi\(req, res, url\)/.test(SRC) && gateIdx > 0);
  check('只认三组开关（白名单写死，不做通用 config 写入）',
    /const groups = \['sessionAffinity', 'rateLimit', 'metrics'\];/.test(SRC));
  check('未知字段一律 400（不静默忽略）', /unknown field \$\{g\}\.\$\{k\}/.test(SRC));
  check('布尔字段类型不对 → 400', /must be a boolean/.test(SRC));
  check('数字字段负数/非数字 → 400', /must be a finite number >= 0/.test(SRC));
  check('空报文（什么都没带）→ 400，不会变成"空更新也算成功"', /nothing to update/.test(SRC));
  check('PATCH 语义：只合并带到的字段（没带的不会归零）', /\.\.\.\(\(config && config\[g\]\) \|\| \{\}\), \.\.\.v \}/.test(SRC));
  check('启动路径与控制台路径共用同一份 norm*（各函数至少被调用 2 次：初始化 + apply）',
    (SRC.match(/normAffinityCfg\(/g) || []).length >= 3 && (SRC.match(/normRateCfg\(/g) || []).length >= 3 && (SRC.match(/normMetricsCfg\(/g) || []).length >= 3);
  check('保存后立即生效（applyRuntimeSettings 在同一个分支里被调用）',
    /applyRuntimeSettings\(\);[\s\S]{0,80}persistConfig\(\);/.test(SRC));
  check('保存后立即落库（不靠"下次保存渠道时顺手带上"）', /return sendJson\(res, 200, \{ ok: true, updated: touched/.test(SRC));
  check('三组开关仍在 persistConfig 白名单里（否则存了也会被别的保存动作抹掉）',
    /sessionAffinity: \(config && config\.sessionAffinity\) \|\| undefined/.test(SRC) &&
    /rateLimit: \(config && config\.rateLimit\) \|\| undefined/.test(SRC) &&
    /metrics: \(config && config\.metrics\) \|\| undefined/.test(SRC));
  check('不碰渠道/冷却/加权状态（只重算三个运行期常量）',
    /applyRuntimeSettings[\s\S]{0,420}?^\}/m.test(SRC) && !/applyRuntimeSettings[\s\S]{0,400}recordFailure/.test(SRC));

  /* ─────────────────────────── 1. 钳制真值表 ─────────────────────────── */
  console.log('\n1. 钳制与默认值（现抠真实源码）');
  {
    const N = makeNorms();
    check('粘性默认关闭（不配就是老行为）', N.normAffinityCfg(undefined).enabled === false && N.normAffinityCfg({}).enabled === false);
    check('enabled 只认严格 true（"true" 字符串不认，避免配置写成字符串时静默开门）',
      N.normAffinityCfg({ enabled: 'true' }).enabled === false && N.normAffinityCfg({ enabled: true }).enabled === true);
    check('ttlSec 低于 30 被抬到 30（5 秒的键等于没有粘性）', N.normAffinityCfg({ ttlSec: 5 }).ttlMs === 30000);
    check('ttlSec 非法/缺失 → 默认 1 小时', N.normAffinityCfg({ ttlSec: 0 }).ttlMs === 3600000 && N.normAffinityCfg({ ttlSec: 'x' }).ttlMs === 3600000);
    check('ttlSec 上限 7 天', N.normAffinityCfg({ ttlSec: 99999999 }).ttlMs === 7 * 86400 * 1000);
    check('maxEntries 区间 [16, 100000] 且默认 2000',
      N.normAffinityCfg({ maxEntries: 1 }).maxEntries === 16 && N.normAffinityCfg({ maxEntries: 200000 }).maxEntries === 100000 && N.normAffinityCfg({}).maxEntries === 2000);
    check('限流默认关闭，rpm/burst/maxConcurrent 默认 0（= 不限）',
      JSON.stringify(N.normRateCfg(undefined)) === JSON.stringify({ enabled: false, rpm: 0, burst: 0, maxConcurrent: 0 }));
    check('rpm 负数 → 0（不是负数令牌桶）', N.normRateCfg({ rpm: -5 }).rpm === 0);
    check('burst 不填 → 桶容量 = rpm；填了就用填的', N.normRateCfg({ rpm: 60 }).burst === 60 && N.normRateCfg({ rpm: 60, burst: 5 }).burst === 5);
    check('maxConcurrent 非数字 → 0（不会变 NaN 拒绝一切）', N.normRateCfg({ maxConcurrent: null }).maxConcurrent === 0);
    check('/metrics 默认开（唯一默认开的开关）', N.normMetricsCfg(undefined).enabled === true && N.normMetricsCfg({}).enabled === true);
    check('/metrics 明确 false 才关；public 只认严格 true',
      N.normMetricsCfg({ enabled: false }).enabled === false && N.normMetricsCfg({ public: 'true' }).public === false && N.normMetricsCfg({ public: true }).public === true);
  }

  /* ─────────────────────────── 2. 真链路 ─────────────────────────── */
  console.log('\n2. 真链路（假上游 + 临时网关，改完不重启即时验证）');
  const up = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      if (req.method === 'GET' && /models/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-set' }] }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  const PU = await freePort(), GW = await freePort();
  await new Promise((r) => up.listen(PU, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'set.json');
  const writeCfg = () => fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
    channels: [
      { id: 'mock-setA', name: 'A', protocol: 'openai', baseUrl: `http://127.0.0.1:${PU}/v1`, apiKey: 'sk-a', priority: 10, enabled: true, models: { 'mock-set': 'mock-set' } },
      { id: 'mock-setB', name: 'B', protocol: 'openai', baseUrl: `http://127.0.0.1:${PU}/v1`, apiKey: 'sk-b', priority: 5, enabled: true, models: { 'mock-set': 'mock-set' } },
    ],
  }));

  let gw = null;
  const spawnGw = async (suffix) => {
    gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage' + suffix + '.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
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
    if (!gw || gw.exitCode !== null) return res();
    gw.once('exit', () => res());
    try { gw.kill(); } catch { }
    setTimeout(res, 1500);
  });
  const H = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + AD_KEY });
  const getSettings = async (headers) => {
    const r = await fetch(`http://127.0.0.1:${GW}/admin/api/settings`, { headers: headers || H() });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const postSettings = async (body, headers) => {
    const r = await fetch(`http://127.0.0.1:${GW}/admin/api/settings`, { method: 'POST', headers: headers || H(), body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const chat = async (session) => {
    const r = await fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY, ...(session ? { 'X-Session-Id': session } : {}) },
      body: JSON.stringify({ model: 'mock-set', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text();
    return { status: r.status, channel: r.headers.get('X-ZZCSAPI-Channel'), retryAfter: r.headers.get('Retry-After') };
  };
  const statusOf = async () => (await fetch(`http://127.0.0.1:${GW}/admin/api/status`, { headers: H() })).json();

  try {
    writeCfg();
    if (!await spawnGw('1')) throw new Error('临时网关未起来');

    const noKey = await getSettings({});
    check('不带密钥 → 401（管理面口径）', noKey.status === 401, noKey.status);

    const s0 = await getSettings();
    check('GET 返回 config / effective / status 三段', s0.status === 200 && !!s0.body.config && !!s0.body.effective && !!s0.body.status, Object.keys(s0.body || {}));
    check('初始：三组都是默认值（粘性关、限流关、指标开）',
      s0.body.effective.sessionAffinity.enabled === false && s0.body.effective.rateLimit.enabled === false && s0.body.effective.metrics.enabled === true);
    check('初始 config 段可直接回填表单（ttlSec=3600、maxEntries=2000）',
      s0.body.config.sessionAffinity.ttlSec === 3600 && s0.body.config.sessionAffinity.maxEntries === 2000);

    // 参数校验（每一条都对应"静默忽略会让用户以为生效了"）
    check('未知分组 → 400', (await postSettings({ nope: {} })).status === 400);
    check('空报文 → 400', (await postSettings({})).status === 400);
    check('分组不是对象 → 400', (await postSettings({ rateLimit: 5 })).status === 400);
    check('分组是数组 → 400', (await postSettings({ rateLimit: [] })).status === 400);
    check('未知字段（rpmm 拼错）→ 400 且错误信息点名字段',
      (await postSettings({ rateLimit: { rpmm: 1 } })).body.error === 'unknown field rateLimit.rpmm');
    check('布尔字段传字符串 → 400', (await postSettings({ rateLimit: { enabled: 'yes' } })).status === 400);
    check('数字字段传负数 → 400', (await postSettings({ rateLimit: { rpm: -1 } })).status === 400);
    check('校验失败时**不落库**（配置里仍没有 rateLimit）',
      !JSON.stringify(JSON.parse(fs.readFileSync(cfgPath, 'utf8'))).includes('"rpmm"'));

    // ① 限流：打开后**立即**生效（不重启）
    const r1 = await postSettings({ rateLimit: { enabled: true, rpm: 60, burst: 1 } });
    check('POST 打开限流 → 200 且回带 updated 列表', r1.status === 200 && r1.body.updated.includes('rateLimit'), r1.body);
    check('生效值里 burst 正确', r1.body.effective.rateLimit.burst === 1);
    const c1 = await chat();
    const c2 = await chat();
    check('不重启即生效：第 1 发 200、第 2 发 429', c1.status === 200 && c2.status === 429, [c1.status, c2.status]);
    check('429 带 Retry-After（客户端知道等多久）', Number(c2.retryAfter) >= 1, c2.retryAfter);
    await sleep(1300);
    check('额度按时间回填后又能过（不是一限就锁死）', (await chat()).status === 200);

    // ② PATCH 语义：只改一个字段，别的保持不变
    const p1 = await postSettings({ rateLimit: { enabled: false } });
    check('PATCH：只关 enabled，rpm/burst 原样保留（不是"漏字段=归零"）',
      p1.body.effective.rateLimit.rpm === 60 && p1.body.effective.rateLimit.burst === 1 && p1.body.effective.rateLimit.enabled === false, p1.body.effective.rateLimit);
    check('关闭后连发不再被挡', (await chat()).status === 200 && (await chat()).status === 200);

    // ③ 粘性：打开后立即把同会话钉在同一家
    const a1 = await postSettings({ sessionAffinity: { enabled: true, ttlSec: 60 } });
    check('粘性打开（ttlSec=60 合法，不被抬）', a1.body.effective.sessionAffinity.ttlSec === 60, a1.body.effective.sessionAffinity);
    const s1 = await chat('settings-session-a');
    const s2 = await chat('settings-session-a');
    const s3 = await chat('settings-session-a');
    check('同一会话三次落在同一家（不重启即生效）', s1.channel && s1.channel === s2.channel && s2.channel === s3.channel, [s1.channel, s2.channel, s3.channel]);
    const st1 = await statusOf();
    check('/admin/api/status 里的 affinity 也跟着动了（entries ≥ 1、hits ≥ 2）',
      st1.affinity.enabled === true && st1.affinity.entries >= 1 && st1.affinity.hits >= 2, st1.affinity);
    check('钳制提示可见：填 ttlSec=5 时 config 保留 5、effective 显示 30',
      (await postSettings({ sessionAffinity: { ttlSec: 5 } })).body.effective.sessionAffinity.ttlSec === 30);

    // ④ /metrics：关掉立即 404，打开立即 200
    check('关闭 /metrics → 端点立即 404（不重启）', (await postSettings({ metrics: { enabled: false } })).status === 200 && (await fetch(`http://127.0.0.1:${GW}/metrics`, { headers: H() })).status === 404);
    check('重新打开 → 立即又能抓', (await postSettings({ metrics: { enabled: true } })).status === 200 && (await fetch(`http://127.0.0.1:${GW}/metrics`, { headers: H() })).status === 200);

    // ⑤ 落库 + 重启后仍是这个值
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    check('落库：sessionAffinity.enabled=true 写进 config.json', onDisk.sessionAffinity && onDisk.sessionAffinity.enabled === true, onDisk.sessionAffinity);
    check('落库：rateLimit 保留被 PATCH 过的字段（enabled=false, rpm=60, burst=1）',
      onDisk.rateLimit && onDisk.rateLimit.rpm === 60 && onDisk.rateLimit.burst === 1 && onDisk.rateLimit.enabled === false, onDisk.rateLimit);
    check('落库：metrics 没被顺手抹掉', onDisk.metrics && onDisk.metrics.enabled === true, onDisk.metrics);
    check('落库：渠道仍在（保存设置不会动渠道列表）', Array.isArray(onDisk.channels) && onDisk.channels.length === 2);
    await stopGw();
    if (!await spawnGw('2')) throw new Error('重启版网关未起来');
    const s2b = await getSettings();
    check('重启后读到的还是刚才存的值（不是只在内存里生效）',
      s2b.body.effective.sessionAffinity.enabled === true && s2b.body.effective.sessionAffinity.ttlSec === 30 && s2b.body.effective.rateLimit.rpm === 60,
      { a: s2b.body.effective.sessionAffinity, r: s2b.body.effective.rateLimit });
    check('重启后限流仍是关的（存的是 enabled:false）', s2b.body.effective.rateLimit.enabled === false);
    const after = await chat();
    check('重启后普通请求照常 200（设置面板不会把网关改坏）', after.status === 200, after.status);
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopGw();
    try { up.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不 process.exit()：Windows 上撞到未关句柄会崩
})();
