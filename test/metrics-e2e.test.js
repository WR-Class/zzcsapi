#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/metrics-e2e.test.js — /metrics 指标端点回归（v1.17，真起进程，零依赖）
 *
 * 守的是什么：把"现在到底什么情况"暴露成 Prometheus 文本格式——格式必须真的能被 Prometheus
 * 解析（否则接上去就是一条永远 fail 的抓取目标），计数必须真的动，凭据绝不许出现在正文里。
 *
 * 覆盖：
 *   · 装配守卫：/metrics 在客户端面分支之前、默认要 admin key、metrics.public 才放开匿名、
 *     enabled:false → 404、渠道记账收口在 recordUsage 一处（不会和 usage 分叉）、
 *     persistConfig 白名单含 metrics、renderMetrics 只读不写；
 *   · 标签转义真值表（现抠 metricLabel）：引号/反斜杠/换行必须转义，否则一行脏标签能让整个抓取失败；
 *   · 真链路：带 admin key 200 + Content-Type 正确；不带 key 401；public:true 时匿名 200；
 *     发真流量后 requests_total / channel_requests_total / channel_tokens_total 都在动；
 *     失败的渠道进 ok="false"；渠道状态 gauge 各档之和 = 渠道总数；uptime/rss 是正数；
 *   · 安全：正文里**绝不出现** GATEWAY_KEY / ADMIN_KEY；
 *   · 格式：每条数据行都符合 `name{labels} value`，每个指标都有 HELP/TYPE。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/metrics-e2e.test.js      （退出码非 0 表示有回归）
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-metrics-'));
const GW_KEY = 'e2e-gw-key-123456', AD_KEY = 'e2e-admin-key-123456';

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

// 现抠 metricLabel（标签转义）——一行脏标签就能让 Prometheus 整个抓取失败，必须当场证明它转义了
function makeLabelFn() {
  const start = SRC.indexOf('const metricLabel =');
  const end = SRC.indexOf('\n', SRC.indexOf('.replace(/\\n/g, ', start));
  const src = SRC.slice(start, end);
  return new Function(src + '\n return metricLabel;')();
}

(async () => {
  /* ─────────────────────────── 0. 装配守卫 ─────────────────────────── */
  console.log('\n0. 装配守卫（源码级）');
  const metricsIdx = SRC.indexOf("if (req.method === 'GET' && url.pathname === '/metrics')");
  const clientIdx = SRC.indexOf("if (url.pathname === '/v1/models' || url.pathname.startsWith('/v1/')");
  const adminIdx = SRC.indexOf("if (url.pathname.startsWith('/admin/api/'))");
  check('/metrics 分支存在', metricsIdx > 0);
  check('/metrics 在客户端面分支之前（不会被限流/鉴权链路改写）', metricsIdx < clientIdx);
  check('/metrics 在管理面分支之后（复用同一套 admin 鉴权）', metricsIdx > adminIdx);
  check('默认要 admin key，只有 metrics.public 才匿名', /if \(!METRICS_CFG\.public && !authGate\(req, res, 'admin'\)\) return;/.test(SRC));
  check('metrics.enabled === false 时端点整体下线（404）', /if \(!METRICS_CFG\.enabled\) return sendJson\(res, 404/.test(SRC));
  check('Content-Type 是 Prometheus 文本联盟格式（text/plain; version=0.0.4）', /'Content-Type': 'text\/plain; version=0\.0\.4; charset=utf-8'/.test(SRC));
  check('渠道记账**只**在 recordUsage 一处收口（不会和 usage 统计分叉）',
    (SRC.match(/metricChannel\(/g) || []).length === 2 && /metricChannel\(channelId, \{ ok: ok !== false, kind, inputTokens: inTok, outputTokens: outTok, latencyMs \}\);/.test(SRC));
  check('请求计数在响应收尾处（finish/close）各记一次', /metricRequest\(route, res\.statusCode \|\| 0\);/.test(SRC));
  check('persistConfig 白名单含 metrics（否则控制台保存渠道会把它抹掉）',
    /metrics: \(config && config\.metrics\) \|\| undefined/.test(SRC));
  check('renderMetrics 是纯读函数（不含写文件/改配置）',
    !/writeFileSync|persistConfig|recordFailure/.test(SRC.slice(SRC.indexOf('function renderMetrics()'), SRC.indexOf('function renderMetrics()') + 3200)));
  check('渠道状态 gauge 覆盖五档（ok/down/cooldown/probation/disabled）',
    /states = \{ ok: 0, down: 0, cooldown: 0, probation: 0, disabled: 0 \}/.test(SRC));

  /* ─────────────────────────── 1. 标签转义真值表 ─────────────────────────── */
  console.log('\n1. 标签转义（现抠真实源码）');
  {
    const esc = makeLabelFn();
    check('普通值原样', esc('mock-ch') === 'mock-ch');
    check('双引号被转义（否则标签提前闭合）', esc('a"b') === 'a\\"b', esc('a"b'));
    check('反斜杠被转义（且先于引号处理，不会双重转义引号）', esc('a\\b') === 'a\\\\b' && esc('a\\"b') === 'a\\\\\\"b', esc('a\\"b'));
    check('换行被转义成 \\n（Prometheus 文本格式不允许裸换行）', esc('a\nb') === 'a\\nb', esc('a\nb'));
    check('中文/emoji 原样透传（不误伤 UTF-8）', esc('渠道-甲') === '渠道-甲');
  }

  /* ─────────────────────────── 2. 真链路 ─────────────────────────── */
  console.log('\n2. 真链路（假上游 ×1 好 + ×1 坏 + 临时网关）');
  const mkUp = (ok) => http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      if (req.method === 'GET' && /models/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-mx' }] }));
      }
      if (!ok) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":"mock bad"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    });
  });
  const upOk = mkUp(true), upBad = mkUp(false);
  const POK = await freePort(), PBAD = await freePort(), GW = await freePort();
  await new Promise((r) => upOk.listen(POK, '127.0.0.1', r));
  await new Promise((r) => upBad.listen(PBAD, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'mx.json');
  const writeCfg = (metrics) => fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
    // 粘性打开：本用例要让 zzcsapi_affinity_entries 这条 gauge 真的动起来（默认关闭时它恒为 0）
    sessionAffinity: { enabled: true, ttlSec: 3600 },
    ...(metrics ? { metrics } : {}),
    channels: [
      { id: 'mock-mxBad', name: 'Bad', protocol: 'openai', baseUrl: `http://127.0.0.1:${PBAD}/v1`, apiKey: 'sk-bad', priority: 10, enabled: true, models: { 'mock-mx': 'mock-mx' } },
      { id: 'mock-mxGood', name: 'Good', protocol: 'openai', baseUrl: `http://127.0.0.1:${POK}/v1`, apiKey: 'sk-good', priority: 5, enabled: true, models: { 'mock-mx': 'mock-mx' } },
      { id: 'mock-mxOff', name: 'Off', protocol: 'openai', baseUrl: `http://127.0.0.1:${POK}/v1`, apiKey: 'sk-off', priority: 1, enabled: false, models: { 'mock-mx-off': 'mock-mx-off' } },
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
  const chat = async () => {
    const r = await fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY, 'X-Session-Id': 'metrics-session-1' },
      body: JSON.stringify({ model: 'mock-mx', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text();
    return r.status;
  };
  const getMetrics = async (headers) => {
    const r = await fetch(`http://127.0.0.1:${GW}/metrics`, { headers: headers || {} });
    return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
  };
  const val = (text, name, labels) => {
    const re = new RegExp('^' + name + (labels ? '\\{' + labels.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\}' : '') + ' (-?[0-9.eE+]+)$', 'm');
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };

  try {
    writeCfg(undefined);   // 不写 metrics 段 = 用默认（开、要 admin key）
    if (!await spawnGw('1')) throw new Error('临时网关未起来');

    const noKey = await getMetrics();
    check('不带密钥 → 401（默认不公开）', noKey.status === 401, noKey.status);
    const badKey = await getMetrics({ Authorization: 'Bearer wrong-key' });
    check('密钥错误 → 401', badKey.status === 401, badKey.status);

    const auth = { Authorization: 'Bearer ' + AD_KEY };
    const m0 = await getMetrics(auth);
    check('带 admin key → 200', m0.status === 200, m0.status);
    check('Content-Type 是 Prometheus 文本格式', /text\/plain; version=0\.0\.4/.test(m0.type || ''), m0.type);
    check('正文里**绝不出现** GATEWAY_KEY', !m0.text.includes(GW_KEY));
    check('正文里**绝不出现** ADMIN_KEY', !m0.text.includes(AD_KEY));

    // 格式合法性：每条数据行 = name{标签}+ 空格 数字；每个指标必须同时有 HELP 与 TYPE
    const lines = m0.text.split('\n').filter((l) => l.length);
    const data = lines.filter((l) => !l.startsWith('#'));
    const badLines = data.filter((l) => !/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?([0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?|NaN|\+Inf|-Inf)$/.test(l));
    check('所有数据行都符合 Prometheus 文本格式', badLines.length === 0, badLines.slice(0, 3));
    const names = new Set(data.map((l) => l.split(/[ {]/)[0]));
    const helps = new Set(lines.filter((l) => l.startsWith('# HELP ')).map((l) => l.split(' ')[2]));
    const types = new Set(lines.filter((l) => l.startsWith('# TYPE ')).map((l) => l.split(' ')[2]));
    check('每个指标都有 HELP', [...names].every((n) => helps.has(n)), [...names].filter((n) => !helps.has(n)));
    check('每个指标都有 TYPE', [...names].every((n) => types.has(n)), [...names].filter((n) => !types.has(n)));
    check('空载时请求计数为 0 / 不存在（不是编出来的数字）', (val(m0.text, 'zzcsapi_requests_total', 'route="/v1/chat/completions",status="200"') || 0) === 0);
    check('uptime 存在且非负（刚起来的进程就是 0 秒，不编数字）',
      val(m0.text, 'zzcsapi_uptime_seconds') !== null && val(m0.text, 'zzcsapi_uptime_seconds') >= 0, val(m0.text, 'zzcsapi_uptime_seconds'));
    check('RSS 是正数', (val(m0.text, 'zzcsapi_process_resident_memory_bytes') || 0) > 0);
    check('渠道状态 gauge：三档之和 = 渠道总数 3',
      ['ok', 'down', 'cooldown', 'probation', 'disabled'].reduce((a, s) => a + (val(m0.text, 'zzcsapi_channels', `state="${s}"`) || 0), 0) === 3,
      m0.text.split('\n').filter((l) => l.startsWith('zzcsapi_channels')));
    check('停用渠道被单独计成 disabled=1', val(m0.text, 'zzcsapi_channels', 'state="disabled"') === 1);
    check('会话粘性 gauge 与事件计数都在', val(m0.text, 'zzcsapi_affinity_entries') === 0 && val(m0.text, 'zzcsapi_affinity_events_total', 'event="hits"') !== null);
    check('限流事件计数都在（含 released=0 的零值，不是缺行）',
      ['rate_rejected', 'concurrent_rejected', 'released'].every((e) => val(m0.text, 'zzcsapi_rate_limit_events_total', `event="${e}"`) !== null));
    check('thinking 回放 gauge 与六个事件计数都在（v1.18.8，默认关也是零值行不是缺行）',
      val(m0.text, 'zzcsapi_thinking_replay_entries') === 0 &&
      ['learned', 'hits', 'misses', 'evicted', 'expired', 'stale'].every((e) => val(m0.text, 'zzcsapi_thinking_replay_events_total', `event="${e}"`) !== null));

    // 真流量：第 1 家 503 → 兜底到第 2 家成功；粘性开启后第 2 发直接落第 2 家
    const s1 = await chat();
    const s2 = await chat();
    check('两发都拿到 200（兜底链生效）', s1 === 200 && s2 === 200, [s1, s2]);
    await sleep(150);

    const m1 = await getMetrics(auth);
    check('requests_total 随真流量增长（route+状态码维度）',
      (val(m1.text, 'zzcsapi_requests_total', 'route="/v1/chat/completions",status="200"') || 0) >= 2,
      m1.text.split('\n').filter((l) => l.startsWith('zzcsapi_requests_total')));
    check('失败渠道进 ok="false"', (val(m1.text, 'zzcsapi_channel_requests_total', 'channel="mock-mxBad",ok="false"') || 0) >= 1,
      m1.text.split('\n').filter((l) => l.includes('mock-mxBad')));
    check('成功渠道进 ok="true"', (val(m1.text, 'zzcsapi_channel_requests_total', 'channel="mock-mxGood",ok="true"') || 0) >= 2);
    check('真实 usage 的 token 被计入（7/3 × 2 发）',
      val(m1.text, 'zzcsapi_channel_tokens_total', 'channel="mock-mxGood",direction="in"') === 14 &&
      val(m1.text, 'zzcsapi_channel_tokens_total', 'channel="mock-mxGood",direction="out"') === 6,
      m1.text.split('\n').filter((l) => l.startsWith('zzcsapi_channel_tokens_total')));
    check('耗时 sum/count 都在动（count ≥ 2 且 sum > 0）',
      (val(m1.text, 'zzcsapi_channel_latency_ms_count', 'channel="mock-mxGood"') || 0) >= 2 &&
      (val(m1.text, 'zzcsapi_channel_latency_ms_sum', 'channel="mock-mxGood"') || 0) > 0);
    check('会话粘性 gauge 随请求增长（表里 1 条会话）', val(m1.text, 'zzcsapi_affinity_entries') === 1, val(m1.text, 'zzcsapi_affinity_entries'));

    // 401 也进 requests_total（否则"被挡掉的流量"在监控里是隐形的）
    await fetch(`http://127.0.0.1:${GW}/v1/models`);
    await sleep(120);
    const m2 = await getMetrics(auth);
    check('401 的请求也进 requests_total（被挡的流量在监控里看得见）',
      (val(m2.text, 'zzcsapi_requests_total', 'route="/v1/models",status="401"') || 0) >= 1,
      m2.text.split('\n').filter((l) => l.includes('/v1/models')));
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopGw();
  }

  /* ─────────────────────────── 3. metrics.public 与关闭 ─────────────────────────── */
  console.log('\n3. metrics.public:true（匿名可抓）与 metrics.enabled:false（整体下线）');
  try {
    writeCfg({ public: true });
    if (!await spawnGw('2')) throw new Error('public 网关未起来');
    const anon = await getMetrics();
    check('public:true → 不带密钥也能抓（200）', anon.status === 200, anon.status);
    check('public 时正文里仍然没有密钥', !anon.text.includes(GW_KEY) && !anon.text.includes(AD_KEY));
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopGw();
  }
  try {
    writeCfg({ enabled: false });
    if (!await spawnGw('3')) throw new Error('关闭版网关未起来');
    const off = await getMetrics({ Authorization: 'Bearer ' + AD_KEY });
    check('enabled:false → 404（即使带对了 admin key 也拿不到）', off.status === 404, off.status);
    const st = await (await fetch(`http://127.0.0.1:${GW}/admin/api/status`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).json();
    check('状态里能看到 metrics 开关现值（配置没被抹掉）', st.metrics && st.metrics.enabled === false, st.metrics);
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopGw();
    try { upOk.close(); upBad.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不 process.exit()：Windows 上撞到未关句柄会崩
})();
