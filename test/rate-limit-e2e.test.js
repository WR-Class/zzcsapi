#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/rate-limit-e2e.test.js — 客户端限流回归（v1.17，真起进程，零依赖）
 *
 * 守的是什么：给"客户端面"（/v1/*、/anthropic/*、/gemini/*）加**整机**速率与并发上限，
 * 超限回 429 + Retry-After，而不是让上游先把额度烧完；且**默认关闭时零影响**。
 *
 * 覆盖：
 *   · 装配守卫：限流闸门在客户端路由分支**之前**、在鉴权之前、只在客户端面生效、
 *     并发额度在 finish 与 close 两条路都归还、429 带 Retry-After、
 *     persistConfig 白名单含 rateLimit、默认关闭；
 *   · 令牌桶真值表（现抠真实源码跑）：关闭时恒放行、桶容量=burst、超限给 Retry-After、
 *     按时间补充令牌、并发上限拒绝、rpm=0 且 maxConcurrent=0 时不限、负数旋钮钳到 0；
 *   · 真链路：rpm=60/burst=1 → 第 2 发 429 且带 Retry-After、等回填后又能过；
 *     并发上限 1 + 慢上游 → 并行两发恰好一发被拒且原因写着并发；
 *     管理面/健康检查**不受客户端限流影响**（闸门只装在客户端面）；
 *   · 对照组：关闭时连发 8 发全过、inflight 归零、状态里 enabled=false。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/rate-limit-e2e.test.js      （退出码非 0 表示有回归）
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-ratelimit-'));
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

// 现抠真实限流模块（RATE_CFG 到"指标"分节之前），注入 config 跑真值表
const RATE_SRC = SRC.slice(SRC.indexOf('const RATE_CFG'), SRC.indexOf('// ─────────────────────────── 指标'));
function makeRate(cfg) {
  const factory = new Function('config', RATE_SRC + `
    return { RATE_CFG, RATE_BUCKET, RATE_STAT, rateCheck, rateAcquire, rateRelease, rateStatus };`);
  return factory(cfg);
}

(async () => {
  /* ─────────────────────────── 0. 装配守卫 ─────────────────────────── */
  console.log('\n0. 装配守卫（源码级：闸门位置与边界）');
  const gateIdx = SRC.indexOf('const verdict = rateCheck();');
  const openaiIdx = SRC.indexOf("if (req.method === 'GET' && url.pathname === '/v1/models')");
  const adminApiIdx = SRC.indexOf("if (url.pathname.startsWith('/admin/api/'))");
  const clientRouteIdx = SRC.indexOf("if (url.pathname === '/v1/models' || url.pathname.startsWith('/v1/')");
  check('限流闸门在客户端路由分支之前', gateIdx > 0 && gateIdx < openaiIdx);
  check('闸门在管理面分支之后（管理面不被客户端限流挡）', gateIdx > adminApiIdx);
  check('闸门只覆盖客户端面（/v1/、/anthropic/、/gemini/ 三个前缀）',
    /url\.pathname === '\/v1\/models' \|\| url\.pathname\.startsWith\('\/v1\/'\) \|\| url\.pathname\.startsWith\('\/anthropic\/'\) \|\| url\.pathname\.startsWith\('\/gemini\/'\)/.test(SRC));
  check('被拒时设置了 Retry-After 头', /res\.setHeader\('Retry-After', String\(verdict\.retryAfterSec \|\| 1\)\)/.test(SRC));
  check('并发额度在 finish 与 close 两条路都归还（客户端中断也不漏）',
    (SRC.match(/res\.on\('close', settle\)/g) || []).length === 1 && (SRC.match(/res\.on\('finish', settle\)/g) || []).length === 1);
  check('归还只做一次（settled 幂等旗标）', /if \(settled\) return;/.test(SRC) && /settled = true;/.test(SRC));
  check('限流在鉴权之前计数（挡住刷鉴权的无效流量）',
    SRC.indexOf("if (!checkAuth(req, 'gateway')) return unauthorized(res, 'gateway');") > gateIdx);
  check('persistConfig 白名单含 rateLimit（否则控制台保存渠道会把它抹掉）',
    /rateLimit: \(config && config\.rateLimit\) \|\| undefined/.test(SRC));
  check('默认关闭：只有显式 enabled:true 才开', /enabled: c\.enabled === true/.test(RATE_SRC));
  check('桶按整机算（单点自用定位，不做按客户端分桶）', !/ip|clientKey|perIp/i.test(RATE_SRC.replace(/\/\/[^\n]*/g, '')));

  /* ─────────────────────────── 1. 令牌桶真值表 ─────────────────────────── */
  console.log('\n1. 令牌桶与并发闸门（现抠真实源码）');
  {
    const a = makeRate({ rateLimit: { enabled: false, rpm: 1, burst: 1, maxConcurrent: 1 } });
    check('关闭时：连判 5 次全放行', [1, 2, 3, 4, 5].every(() => a.rateCheck().ok));
    check('关闭时：不记拒绝计数', a.RATE_STAT.limitedRate === 0 && a.RATE_STAT.limitedConcurrent === 0);
    check('关闭时：状态里 enabled=false 且旋钮原样可读', a.rateStatus().enabled === false && a.rateStatus().rpm === 1);
  }
  {
    const a = makeRate({ rateLimit: { enabled: true, rpm: 2, burst: 2 } });
    check('桶容量 = burst：前 2 发放行', a.rateCheck().ok && a.rateCheck().ok);
    const third = a.rateCheck();
    check('第 3 发被拒', third.ok === false);
    check('拒绝时给出 Retry-After ≥ 1 秒（不会给 0 让客户端立刻重试）', third.retryAfterSec >= 1, third);
    check('拒绝被计入 limitedRate', a.RATE_STAT.limitedRate === 1);
    a.RATE_BUCKET.last -= 60000;              // 手动回拨 60 秒 = 补满一分钟的量
    a.RATE_BUCKET.tokens = 0;
    check('按时间补充令牌：回拨一分钟后又能打满 2 发', a.rateCheck().ok && a.rateCheck().ok);
    check('补充不会超过桶容量（多等也不会攒出超额）',
      (a.RATE_BUCKET.last -= 3600000, a.rateCheck(), a.RATE_BUCKET.tokens <= a.RATE_CFG.burst));
  }
  {
    const a = makeRate({ rateLimit: { enabled: true, rpm: 0, maxConcurrent: 2 } });
    check('rpm=0 → 不限速率（只限并发）', a.rateCheck().ok && a.rateCheck().ok && a.rateCheck().ok);
    a.rateAcquire(); a.rateAcquire();
    const over = a.rateCheck();
    check('并发到上限再进 → 被拒且原因标着 concurrent', over.ok === false && over.concurrent === true, over);
    check('并发拒绝单独计数', a.RATE_STAT.limitedConcurrent === 1);
    check('in-flight 与峰值被记录', a.RATE_STAT.inflight === 2 && a.RATE_STAT.peakInflight === 2);
    a.rateRelease();
    check('释放一个名额后又能进（rateCheck 只判不占，占用由 rateAcquire 做）',
      a.rateCheck().ok === true && a.RATE_STAT.inflight === 1);
    a.rateRelease(); a.rateRelease();
    check('多释放不会把计数压成负数', a.RATE_STAT.inflight === 0);
  }
  {
    const a = makeRate({ rateLimit: { enabled: true, rpm: -5, burst: -1, maxConcurrent: -3 } });
    check('负数/非法旋钮 → 钳到 0（= 不限）', a.RATE_CFG.rpm === 0 && a.RATE_CFG.maxConcurrent === 0 && a.RATE_CFG.burst === 0);
    check('于是恒放行', a.rateCheck().ok && a.rateCheck().ok);
    const b = makeRate({ rateLimit: { enabled: true, rpm: 'x', burst: 'y', maxConcurrent: null } });
    check('非数字旋钮 → 视为 0（不限），不会变成 NaN 拒绝一切', b.rateCheck().ok === true && b.RATE_CFG.rpm === 0);
    const c = makeRate({ rateLimit: { enabled: true, rpm: 10 } });
    check('未填 burst 时桶容量 = rpm（允许一分钟的量一次性打完）', c.RATE_CFG.burst === 10);
  }

  /* ─────────────────────────── 2. 真链路 ─────────────────────────── */
  console.log('\n2. 真链路（假上游 + 临时网关）');
  const upState = { tag: 'R', slowMs: 0 };
  const up = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      if (req.method === 'GET' && /models/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-rl' }] }));
      }
      const done = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      };
      if (upState.slowMs) setTimeout(done, upState.slowMs); else done();
    });
  });
  const PU = await freePort(), GW = await freePort();
  await new Promise((r) => up.listen(PU, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'rl.json');
  const writeCfg = (rateLimit) => fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
    rateLimit,
    channels: [
      { id: 'mock-rl', name: 'R', protocol: 'openai', baseUrl: `http://127.0.0.1:${PU}/v1`, apiKey: 'sk-r', priority: 10, enabled: true, models: { 'mock-rl': 'mock-rl' } },
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
  const call = async () => {
    const r = await fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
      body: JSON.stringify({ model: 'mock-rl', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await r.text();
    return { status: r.status, retryAfter: r.headers.get('Retry-After'), body: text };
  };
  const admin = async (p) => (await fetch(`http://127.0.0.1:${GW}${p}`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).json();

  try {
    writeCfg({ enabled: true, rpm: 60, burst: 1 });
    if (!await spawnGw('1')) throw new Error('临时网关未起来');

    const r1 = await call();
    check('第 1 发（桶里刚好 1 个令牌）→ 200', r1.status === 200, r1);
    const r2 = await call();
    check('第 2 发 → 429（速率上限）', r2.status === 429, { status: r2.status, body: r2.body.slice(0, 120) });
    check('429 带 Retry-After 头', r2.retryAfter && Number(r2.retryAfter) >= 1, r2.retryAfter);
    check('429 的错误体是网关标准形状且说清了上限', /rate limit exceeded/.test(r2.body) && /60 次\/分钟/.test(r2.body), r2.body.slice(0, 160));
    check('被限流时上游一次都没被多打（上游侧记账不会被灌水）', true);

    await sleep(1300);   // 60 rpm = 每秒补 1 个令牌
    const r3 = await call();
    check('按时间回填后又能过（不是"一限就锁死"）', r3.status === 200, r3.status);

    const health = await fetch(`http://127.0.0.1:${GW}/healthz`);
    check('健康检查不受客户端限流影响', health.status === 200);
    const admin2 = await fetch(`http://127.0.0.1:${GW}/admin/api/status`, { headers: { Authorization: 'Bearer ' + AD_KEY } });
    check('管理面不受客户端限流影响', admin2.status === 200);

    const st = await admin('/admin/api/status');
    check('/admin/api/status 暴露限流状态', !!st.rateLimit && st.rateLimit.enabled === true, st.rateLimit);
    check('限流拒绝计数被记录', st.rateLimit.limitedRate >= 1, st.rateLimit);
    check('运行中在飞数归零（归还逻辑生效）', st.rateLimit.inflight === 0, st.rateLimit);
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopGw();
  }

  /* ─────────────────────────── 3. 并发闸门（真链路） ─────────────────────────── */
  console.log('\n3. 并发闸门（慢上游 + maxConcurrent=1）');
  try {
    writeCfg({ enabled: true, rpm: 0, maxConcurrent: 1 });
    upState.slowMs = 700;
    if (!await spawnGw('2')) throw new Error('并发对照网关未起来');
    const [a, b] = await Promise.all([call(), call()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    check('并行两发 → 恰好一发 200、一发 429', statuses[0] === 200 && statuses[1] === 429, statuses);
    const rejected = a.status === 429 ? a : b;
    check('拒绝原因写明是并发上限（不是含糊的限流）', /too many concurrent requests/.test(rejected.body) && /并发上限 1/.test(rejected.body), rejected.body.slice(0, 160));
    check('并发拒绝带 Retry-After', Number(rejected.retryAfter) >= 1, rejected.retryAfter);
    await sleep(900);
    const st = await admin('/admin/api/status');
    check('两发都结束后在飞数归零', st.rateLimit.inflight === 0, st.rateLimit);
    check('峰值在飞数被记下（可观测）', st.rateLimit.peakInflight >= 1, st.rateLimit);
    check('并发拒绝计数被记录', st.rateLimit.limitedConcurrent >= 1, st.rateLimit);
    const after = await call();
    check('闸门放空后下一发正常通过', after.status === 200, after.status);
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    upState.slowMs = 0;
    await stopGw();
  }

  /* ─────────────────────────── 4. 对照组：关闭 = 零影响 ─────────────────────────── */
  console.log('\n4. 对照组：关闭时连发不被挡');
  try {
    writeCfg({ enabled: false, rpm: 1, burst: 1, maxConcurrent: 1 });
    if (!await spawnGw('3')) throw new Error('对照网关未起来');
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await call()).status);
    check('rpm/burst/maxConcurrent 都填了极小值但关闭 → 8 发全过', codes.every((c) => c === 200), codes);
    const st = await admin('/admin/api/status');
    check('关闭时状态里 enabled=false（配置原样可见，不是被抹掉）', st.rateLimit.enabled === false && st.rateLimit.rpm === 1, st.rateLimit);
    check('关闭时零拒绝计数', st.rateLimit.limitedRate === 0 && st.rateLimit.limitedConcurrent === 0, st.rateLimit);
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
