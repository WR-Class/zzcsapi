#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/usage-day-key.test.js — 账本的「天 / 小时」必须按北京时间切（v1.18.36，真起进程，零依赖）
 *
 * 现场（查「yu1 渠道 24 小时用了多少 token」时发现的）：账本的日桶与小时桶**对不上**——
 *   日键用 `new Date(ts).toISOString().slice(0,10)`（**UTC 日**），小时键用 `getHours()`（**本地小时**），
 *   同一个函数里两套钟：日界落在**北京时间早上 8 点**，凌晨 0~8 点的流量被算进前一天。
 *   `ipStatsBumpHour` 更是自相矛盾：注释写着"本地时区，跨天清零"，代码却是 UTC 日 + 本地小时。
 *
 * 处置：新增 `cnDayKey()` / `cnHour()`（固定 **+8**，**不依赖进程时区**），账本四处口径统一走它们：
 *   `byDay` 桶、per-IP 24 小时桶的日界与小时、`/admin/api/usage` 的 `hourly`。
 *   为什么不用 `getDate()/getHours()` 图省事：那取决于进程时区（compose 里设了 TZ=Asia/Shanghai，
 *   但裸跑 `node server.js` 的机器可能是 UTC），账本口径不该随部署环境漂。
 *
 * 覆盖：
 *   ① 真值表（现抠真源码）：北京 00:00 边界、跨月跨年、字符串 ts、`cnHour` 三态，
 *      以及**老写法对照**（同一点上 UTC 日与北京日差一天 —— 这正是修复点）；
 *   ② 真链路 ★：网关子进程 **TZ=UTC** 启动（若代码依赖进程时区，这里就会露馅）——
 *      账本 `byDay` 的桶键 = 该行 `ts` 的北京日；`hourly` 落在**北京小时**、**UTC 小时那格必须是 0**；
 *      per-IP 24 桶同理（`/admin/api/stats`）；
 *   ③ 结构守卫：`bumpUsageBucket(u.byDay, …)` 的 day 来自 `cnDayKey`、`ipStatsBumpHour` 不再混用
 *      UTC 日 + 本地小时、账本路径再无 `toISOString().slice(0,10)` 取日。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/usage-day-key.test.js     （退出码非 0 表示有回归）
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-daykey-e2e-'));
const GW_KEY = 'e2e-gw', AD_KEY = 'e2e-admin';
const USAGE = path.join(TMP, 'usage.json');

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
// 现抠真源码：两个纯函数 + 它们依赖的常量（不抄一份到用例里）
function extractDayHelpers() {
  const grab = (re, what) => { const m = SRC.match(re); if (!m) throw new Error('extract: 找不到 ' + what); return m[0]; };
  const src = [
    grab(/^const CN_OFFSET_MS = .*$/m, 'CN_OFFSET_MS'),
    grab(/^const cnDayKey = .*$/m, 'cnDayKey'),
    grab(/^const cnHour = .*$/m, 'cnHour'),
    'return { CN_OFFSET_MS, cnDayKey, cnHour };',
  ].join('\n');
  return new Function(src)();
}
const sliceFrom = (marker, len = 1200) => { const i = SRC.indexOf(marker); return i < 0 ? '' : SRC.slice(i, i + len); };

/* 北京时间某个时刻 → 对应的 epoch（用例里所有期望值都这样写，避免手算偏移出错） */
const bj = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h - 8, mi, s);   // 北京 = UTC+8

/* ── 假上游：一发正常文本流（带 usage 帧）── */
const SSE = [
  'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
  'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
  'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: {"id":"c","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
  'data: [DONE]',
  '',
].join('\n\n');
const upstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
    if (req.method === 'GET' && /models/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'up' }] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.end(SSE);
  });
});

(async () => {
  const { CN_OFFSET_MS, cnDayKey, cnHour } = extractDayHelpers();

  /* ══════════ 1. 真值表（现抠真源码） ══════════ */
  console.log('\n1. cnDayKey / cnHour（北京时间，固定 +8）');
  check('北京 10-04 23:59:59 → 2026-10-04', cnDayKey(bj(2026, 10, 4, 23, 59, 59)) === '2026-10-04', cnDayKey(bj(2026, 10, 4, 23, 59, 59)));
  check('★ 北京 10-05 00:00:00 → 2026-10-05（整点进新的一天）', cnDayKey(bj(2026, 10, 5, 0, 0, 0)) === '2026-10-05', cnDayKey(bj(2026, 10, 5, 0, 0, 0)));
  check('北京 10-04 00:00:00 → 2026-10-04（凌晨属于当天，不算前一天）', cnDayKey(bj(2026, 10, 4, 0, 0, 0)) === '2026-10-04', cnDayKey(bj(2026, 10, 4, 0, 0, 0)));
  check('北京 10-03 23:59:59 → 2026-10-03', cnDayKey(bj(2026, 10, 3, 23, 59, 59)) === '2026-10-03', cnDayKey(bj(2026, 10, 3, 23, 59, 59)));
  const oldWay = (ts) => new Date(ts).toISOString().slice(0, 10);
  check('★ 老写法在同一点上给 2026-10-04（UTC 日，差一天 —— 这就是修复点）', oldWay(bj(2026, 10, 5, 0, 0, 0)) === '2026-10-04', oldWay(bj(2026, 10, 5, 0, 0, 0)));
  check('跨月：北京 11-01 00:00 → 2026-11-01', cnDayKey(bj(2026, 11, 1, 0, 0, 0)) === '2026-11-01', cnDayKey(bj(2026, 11, 1, 0, 0, 0)));
  check('跨年：北京 2027-01-01 00:00 → 2027-01-01', cnDayKey(bj(2027, 1, 1, 0, 0, 0)) === '2027-01-01', cnDayKey(bj(2027, 1, 1, 0, 0, 0)));
  check('字符串 ts 也吃（账本里的 ts 可能来自 JSON 反序列化）', cnDayKey(String(bj(2026, 10, 5, 3, 0, 0))) === '2026-10-05');
  check('偏移常量就是 8 小时', CN_OFFSET_MS === 8 * 3600 * 1000, CN_OFFSET_MS);
  check('cnHour：北京 00:00 → 0', cnHour(bj(2026, 10, 5, 0, 0, 0)) === 0, cnHour(bj(2026, 10, 5, 0, 0, 0)));
  check('cnHour：北京 23:59 → 23', cnHour(bj(2026, 10, 4, 23, 59, 0)) === 23, cnHour(bj(2026, 10, 4, 23, 59, 0)));
  check('★ cnHour：北京 08:00 → 8（此刻 UTC 是 00:00，用 getHours() 会得 0）', cnHour(bj(2026, 10, 4, 8, 0, 0)) === 8 && new Date(bj(2026, 10, 4, 8, 0, 0)).getUTCHours() === 0);

  /* ══════════ 2. 真链路：子进程强制 TZ=UTC，账本仍按北京时间 ══════════ */
  console.log('\n2. 真链路（网关子进程 TZ=UTC；若口径依赖进程时区，这里就会露馅）');
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const port = await freePort();
  const cfg = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port, health: { intervalSec: 3600, timeoutMs: 3000 },
    channels: [{ id: 'oa', name: 'oa', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}`, apiKey: 'sk-oa', enabled: true, priority: 10, models: { 'm-day': 'up-day' } }],
  }));
  const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, TZ: 'UTC', ZZCSAPI_CONFIG: cfg, ZZCSAPI_USAGE: USAGE, GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
    stdio: 'ignore',
  });
  const admin = (p) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: 'Bearer ' + AD_KEY } }).then((r) => r.json());
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { } if (!up) await sleep(200); }
    check('网关启动（TZ=UTC）', up);
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY, 'User-Agent': 'e2e-daykey/1.0' },
      body: JSON.stringify({ model: 'm-day', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text();
    check('请求成功', r.status === 200, r.status);

    let rows = [];
    for (let i = 0; i < 45 && !rows.length; i++) { try { rows = (await admin('/admin/api/usage')).recent || []; } catch { } if (!rows.length) await sleep(200); }
    const row = rows.find((x) => x.model === 'm-day');
    check('账本有一行', !!row, rows.length);
    const ts = row ? row.ts : Date.now();
    const bjDay = cnDayKey(ts), utcDay = new Date(ts).toISOString().slice(0, 10);
    const bjHr = cnHour(ts), utcHr = new Date(ts).getUTCHours();
    console.log('    （本次运行：北京日 ' + bjDay + ' / UTC 日 ' + utcDay + (bjDay === utcDay ? '，两者相同 → 日桶那条不判别' : '，两者不同 → 日桶那条可判别') + '；北京 ' + bjHr + ' 点 / UTC ' + utcHr + ' 点，小时那两条恒可判别）');
    check('★ 账本 byDay 的桶键 = 该行 ts 的**北京日**', ((await admin('/admin/api/usage')).byDay || []).some((d) => d.day === bjDay), ((await admin('/admin/api/usage')).byDay || []).map((d) => d.day));
    check('★ byDay 里不含 UTC 日那个桶（口径只有一个）', bjDay === utcDay || !((await admin('/admin/api/usage')).byDay || []).some((d) => d.day === utcDay));

    const u2 = await admin('/admin/api/usage');
    const hr = (u2.hourly || [])[bjHr] || { requests: 0 };
    const hrUtc = (u2.hourly || [])[utcHr] || { requests: 0 };
    check('★ hourly 落在**北京小时**（' + bjHr + ' 点）', hr.requests >= 1, { bjHr, requests: hr.requests });
    check('★ hourly 的 **UTC 小时**那格必须是 0（' + utcHr + ' 点，此前会记到这里）', hrUtc.requests === 0, { utcHr, requests: hrUtc.requests });

    const st = await admin('/admin/api/stats');
    const me = (st.ips || []).find((x) => x.ip === '127.0.0.1' || x.ip === '::1' || /127\.0\.0\.1|::ffff:127/.test(x.ip));
    check('per-IP 统计里有本机这一条', !!me, (st.ips || []).map((x) => x.ip));
    check('★ per-IP 24 桶落在北京小时（此前 UTC 日 + 本地小时混用）', !!me && (me.buckets[bjHr] || 0) >= 1, me && { bjHr, v: me.buckets[bjHr] });
    check('★ per-IP 24 桶的 UTC 小时那格必须是 0', !!me && (me.buckets[utcHr] || 0) === 0, me && { utcHr, v: me.buckets[utcHr] });
    check('per-IP 24 桶是完整的 24 格、总数 ≥ 1（跨天清零的容器还在）', !!me && me.buckets.length === 24 && me.buckets.reduce((a, b) => a + b, 0) >= 1, me && me.buckets);
  } finally { gw.kill('SIGKILL'); }
  upstream.close();

  /* ══════════ 3. 结构性守卫 ══════════ */
  console.log('\n3. 结构性守卫（防回潮）');
  const rec = sliceFrom('function recordUsage(', 4200);
  check('账本 byDay 的 day 来自 cnDayKey（不再是 toISOString 取 UTC 日）', rec.includes('const day = cnDayKey(ts);') && !rec.includes('.toISOString().slice(0, 10)'));
  const ipFn = sliceFrom('function ipStatsBumpHour(', 400);
  check('ipStatsBumpHour 用 cnDayKey + cnHour（不再 UTC 日 + 本地小时混用）', ipFn.includes('cnDayKey(now)') && ipFn.includes('cnHour(now)') && !ipFn.includes('toISOString') && !ipFn.includes('getHours'));
  check('hourly 桶用 cnHour（不依赖进程时区）', sliceFrom('const hourly = Array.from({ length: 24 }', 300).includes('cnHour(r.ts)'));
  // 换成"正向唯一性"断言：全仓把 Date 变成日字符串的地方**只能有一处**，且必须是 cnDayKey 本身
  // （用带空格的 `.slice(0, 10)` 字面量，注释里引用的旧写法 `.slice(0,10)` 不带空格，不会误伤）
  const dayConv = SRC.split('\n').filter((ln) => ln.includes('.toISOString().slice(0, 10)'));
  check('★ 全仓「Date → 日字符串」的转换只有 cnDayKey 一处（账本口径唯一）', dayConv.length === 1 && dayConv[0].includes('const cnDayKey ='), dayConv.map((l) => l.trim().slice(0, 90)));

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;
  await sleep(250);
})();
