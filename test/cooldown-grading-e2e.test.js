#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/cooldown-grading-e2e.test.js — 「熔断冷却分级 + 探测半愈合」端到端回归
 *                                                          （真起进程，零依赖）
 *
 * 背景：旧版熔断只有一条公式 `min(60s, 1000 * 2^fail)`，而且在 server.js 里**复制了 11 份**
 * （每加一条出站分支就再抄一遍，还各自长出 300s / 3600s 的手写特例）。两个真实问题：
 *
 *   ① 类型不分：网络抖一下（下一分钟可能就好）和 401/余额耗尽（一分钟内绝不可能自愈）用同一条曲线，
 *      于是坏 key 的渠道每分钟都被真流量撞一次；
 *   ② **探测一成功就满血复活**：健康探测打的是 /models，它证明"列表拉得回来"，证明不了"对话能成"。
 *      旧的探测成功路径把 consecutiveFail 和 cooldownUntil 一起清零、状态回 ok —— 一个"能列模型但
 *      对话必失败"的渠道于是永远循环：撞一次 → 被探测救活 → 回链首 → 再撞一次。用户感觉到的
 *      "退避太快恢复"主要来自这里，而不是 2 秒的起步值。
 *
 * 本轮的契约（见 server.js 的 COOLDOWN / cooldownMsFor / failureKindFromStatus / healAfterProbe）：
 *   · 曲线 base * 2^(n-1)：瞬时 5s 起（封顶 10 分钟）；凭证/额度 5 分钟起（封顶 6 小时）；
 *     限流 1 分钟起（封顶 10 分钟），上游给了 Retry-After 就听它的；
 *   · 失败分类只在一处判：failureKindFromStatus（401/402/403 → 凭证，429 → 限流，其余瞬时）；
 *   · 探测成功**只半愈合**：失败计数减半、冷却放开、进观察期 probation（排健康渠道之后、不进权重池）；
 *     要一次真实对话成功才彻底清零。唯一例外是"探测本身就是真实对话"的渠道（workbuddy 的 chat 探针）。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/cooldown-grading-e2e.test.js   （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-cd-e2e-'));
const GW_KEY = 'cd-gw', AD_KEY = 'cd-admin';

/* 测试用的冷却参数：全部取允许范围内的最小值，跑得快且每一步都能验算
   （真实的默认值见 docs/scheduling.md「熔断冷却」：5s / 10min、5min / 6h、1min） */
const CD = { transientBaseMs: 1000, transientMaxMs: 4000, hardBaseMs: 10000, hardMaxMs: 60000, rateLimitBaseMs: 2000 };

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

/* 假上游：mode = 'ok' | { status, retryAfter? } | 'empty-models'
   chat 与 /models 的记账分开：健康探测打的是 /models，混在一起会污染"这家被撞了几次"的判读。 */
function makeUpstream(state) {
  return http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      if (req.method === 'GET' && /models/.test(req.url)) {
        state.probes++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: state.mode === 'empty-models' ? [] : [{ id: 'cd-model' }] }));
      }
      state.chat++;
      const m = state.mode;
      if (m && m !== 'ok' && m !== 'empty-models') {
        const h = { 'Content-Type': 'application/json' };
        if (m.retryAfter) h['Retry-After'] = String(m.retryAfter);
        res.writeHead(m.status, h);
        return res.end(JSON.stringify({ error: { message: `upstream ${state.tag} says ${m.status}` } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: `ok-${state.tag}` } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
  });
}

(async () => {
  const UA = { tag: 'A', mode: 'ok', chat: 0, probes: 0 };
  const UB = { tag: 'B', mode: 'ok', chat: 0, probes: 0 };
  const upA = makeUpstream(UA), upB = makeUpstream(UB);
  const PA = await freePort(), PB = await freePort(), GW = await freePort();
  await new Promise((r) => upA.listen(PA, '127.0.0.1', r));
  await new Promise((r) => upB.listen(PB, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'cd.json');
  const writeCfg = () => {
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: GW,
      health: { intervalSec: 3600, timeoutMs: 3000 },   // 关掉周期探测：本用例用 /admin/recheck 手动触发
      retries: { perChannel: 0, maxModelFallbacks: 99 }, // 关掉同渠道重试：一次请求 = 一次失败，好算账
      cooldown: CD,
      channels: [
        // A 有效优先级更高 → 什么都不发生时它必须首发（这是后面验证"观察期把它挤下去"的对照）
        { id: 'cd-a', name: 'A', protocol: 'openai', baseUrl: `http://127.0.0.1:${PA}/v1`, apiKey: 'sk-a', priority: 30, enabled: true, models: { 'cd-model': 'cd-model' } },
        { id: 'cd-b', name: 'B', protocol: 'openai', baseUrl: `http://127.0.0.1:${PB}/v1`, apiKey: 'sk-b', priority: 20, enabled: true, models: { 'cd-model': 'cd-model' } },
      ],
    }));
  };
  const reset = () => { UA.mode = 'ok'; UA.chat = 0; UA.probes = 0; UB.mode = 'ok'; UB.chat = 0; UB.probes = 0; };

  let gw = null, usageN = 0;
  const restart = async () => {
    writeCfg();
    await stopChild(gw);
    gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, `usage-${++usageN}.json`), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
      stdio: 'ignore',
    });
    if (!await waitUp()) throw new Error('临时网关未起来');
  };
  function stopChild(cp) {
    return new Promise((res) => {
      if (!cp || cp.exitCode !== null || cp.signalCode !== null) return res();
      cp.once('exit', () => res());
      try { cp.kill(); } catch { }
      setTimeout(res, 1500);
    });
  }
  const waitUp = async (ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if ((await fetch(`http://127.0.0.1:${GW}/healthz`)).ok) return true; } catch { }
      await sleep(200);
    }
    return false;
  };
  const call = async () => {
    const r = await fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
      body: JSON.stringify({ model: 'cd-model', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await r.text();
    return { status: r.status, ch: r.headers.get('X-ZZCSAPI-Channel'), text };
  };
  const admin = async (p, init) => {
    const r = await fetch(`http://127.0.0.1:${GW}${p}`, { ...init, headers: { Authorization: 'Bearer ' + AD_KEY, ...((init && init.headers) || {}) } });
    let j = null; try { j = await r.json(); } catch { }
    return { status: r.status, j };
  };
  const chan = async (id) => (await admin('/admin/api/status')).j.channels.find((c) => c.id === id);
  const cooldownLeft = (c) => (c.cooldownUntil || 0) - Date.now();
  const near = (v, want, tol = 0.35) => Math.abs(v - want) <= Math.max(300, want * tol);

  try {
    console.log('\n0. 判据单测：从 server.js 现抠冷却曲线 / 分类 / Retry-After / 半愈合 + 装配守卫');
    {
      const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
      const grabFn = (needle) => {
        const at = src.indexOf(needle);
        if (at < 0) throw new Error('server.js 里找不到 ' + needle);
        let depth = 0, end = -1;
        for (let k = src.indexOf('{', at); k < src.length; k++) {
          if (src[k] === '{') depth++;
          else if (src[k] === '}') { depth--; if (!depth) { end = k + 1; break; } }
        }
        return src.slice(at, end);
      };
      const F = (name) => new Function('COOLDOWN', grabFn('function ' + name) + `;return ${name};`)(CD);

      const cooldownMsFor = F('cooldownMsFor');
      const kindOf = F('failureKindFromStatus');
      const retryAfter = F('retryAfterMsFromHeaders');

      console.log('   （曲线：临时配置瞬时 1s 起 / 4s 封顶，凭证 10s 起 / 60s 封顶，限流 2s 起）');
      check('★ 瞬时：第一次失败 = 起步值本人（不是 2 倍，也不是 2^n 的老写法）',
        cooldownMsFor({ consecutiveFail: 1 }, 'transient') === 1000);
      check('★ 瞬时：按 2^(n-1) 增长', cooldownMsFor({ consecutiveFail: 2 }, 'transient') === 2000
        && cooldownMsFor({ consecutiveFail: 3 }, 'transient') === 4000);
      check('★ 瞬时：封顶生效（n=6 也是 4s）', cooldownMsFor({ consecutiveFail: 6 }, 'transient') === 4000);
      check('★ 凭证类：起步就是分钟级（10s），不是秒级——坏 key 一分钟内不会自愈',
        cooldownMsFor({ consecutiveFail: 1 }, 'credential') === 10000);
      check('★ 凭证类：封顶独立且更高（60s）', cooldownMsFor({ consecutiveFail: 9 }, 'credential') === 60000);
      check('★ 限流：起步 2s，封顶跟着瞬时上限（4s）',
        cooldownMsFor({ consecutiveFail: 1 }, 'rate_limit') === 2000 && cooldownMsFor({ consecutiveFail: 9 }, 'rate_limit') === 4000);
      check('kind 缺省 / 认不出的值 → 按瞬时处理（宁可多给机会）',
        cooldownMsFor({ consecutiveFail: 1 }) === 1000 && cooldownMsFor({ consecutiveFail: 1 }, '??') === 1000);

      check('★ 分类：401/402/403 = 凭证，429 = 限流，5xx/无状态码 = 瞬时',
        kindOf(401) === 'credential' && kindOf(402) === 'credential' && kindOf(403) === 'credential'
        && kindOf(429) === 'rate_limit' && kindOf(500) === 'transient' && kindOf(503) === 'transient' && kindOf(0) === 'transient');
      check('★ 分类：拿不到状态码时按文案兜底（登录失效/额度/限流）',
        kindOf(0, 'genspark: session 失效（not login）') === 'credential'
        && kindOf(0, 'workspace credits exhausted') === 'credential'
        && kindOf(0, 'too many requests') === 'rate_limit');
      check('分类：普通网络错误不许被误判成凭证类（否则会白等几分钟）',
        kindOf(0, 'fetch failed: ECONNRESET') === 'transient' && kindOf(0, 'socket hang up') === 'transient');

      check('★ Retry-After：秒数写法能解析', retryAfter({ get: (k) => (k === 'retry-after' ? '7' : null) }) === 7000);
      check('★ Retry-After：HTTP 日期写法能解析', (() => {
        const v = retryAfter({ get: () => new Date(Date.now() + 30000).toUTCString() });
        return v > 25000 && v <= 30000;
      })());
      check('Retry-After：没有该头 / 垃圾值 → undefined（让曲线说话）',
        retryAfter({ get: () => null }) === undefined && retryAfter({ get: () => 'soon' }) === undefined && retryAfter(null) === undefined);
      check('★ Retry-After 受硬上限约束（坏上游没法用一个大数字把渠道钉一整天）',
        cooldownMsFor({ consecutiveFail: 1 }, 'rate_limit', 30 * 86400_000) === 60000);

      const heal = F('healAfterProbe');
      {
        const a = { consecutiveFail: 0, cooldownUntil: 123, lastError: 'x', status: 'ok' };
        heal(a, true);
        check('半愈合：本来没欠账 → 探测说了算（回 ok、清错误、放开冷却）',
          a.consecutiveFail === 0 && a.status === 'ok' && !a.cooldownUntil && !a.lastError && !a.probation);
      }
      {
        const a = { consecutiveFail: 4, cooldownUntil: 123, lastError: 'HTTP 500', status: 'down' };
        heal(a, true);
        check('★ 半愈合：欠着账时**减半**（4 → 2）、进观察期、冷却放开、错误证据保留',
          a.consecutiveFail === 2 && a.probation === true && a.cooldownUntil === 0 && a.lastError === 'HTTP 500' && a.status === 'degraded');
      }
      {
        const a = { consecutiveFail: 1, cooldownUntil: 1, lastError: 'HTTP 500', status: 'down' };
        heal(a, true);
        check('★ 半愈合：欠 1 笔时不会减成 0（探测成功不等于账还完了）',
          a.consecutiveFail === 1 && a.probation === true);
      }
      {
        const a = { consecutiveFail: 3, cooldownUntil: 1, lastError: 'x', status: 'ok' };
        heal(a, true, true);
        check('★ 例外：探测本身就是真实对话（workbuddy）→ 可以满血（清零、出观察期、回 ok）',
          a.consecutiveFail === 0 && !a.probation && a.status === 'ok' && !a.lastError);
      }
      {
        const a = { consecutiveFail: 3, cooldownUntil: 1, lastError: 'x', status: 'degraded' };
        heal(a, false);
        check('探测失败 → down 且不进观察期（欠账保留）',
          a.status === 'down' && !a.probation && a.consecutiveFail === 1);
      }

      console.log('   · 装配守卫');
      check('★ 旧的那条 11 份复制公式已彻底消失（改退避策略只需改一处）',
        (src.match(/Math\.pow\(2, ch\.consecutiveFail\)/g) || []).length === 0);
      check('★ 冷却时长只有一处实现（recordFailure 里不许自己算）',
        (src.match(/function cooldownMsFor\(/g) || []).length === 1
        && (src.match(/Math\.min\(COOLDOWN\./g) || []).length === 1);
      check('★ 失败记账只有一处入口', (src.match(/function recordFailure\(/g) || []).length === 1);
      check('★ 探测成功路径不许再自己清零失败计数（必须走 healAfterProbe）',
        !/const agents = await notionAgent\.listAgents[\s\S]{0,700}?consecutiveFail = 0/.test(src));
      check('★ 排序分层用 probation，不再拿 status=\'degraded\' 当信号（那会误降级"列表为空但别名可用"的渠道）',
        /c\.probation \? 1 : 0/.test(src) && !/c\.status === 'degraded' \? 1 : 0/.test(src));
      check('★ 观察期不进加权池（否则"探测救活就抢链首"会从后门回来）',
        /Number\(c\.weight\) > 0[\s\S]{0,160}?!c\.probation/.test(src));
      check('观察期在真实成功路径上会被清掉（否则渠道永远排人后面）',
        (src.match(/ch\.probation = false;/g) || []).length >= 12, (src.match(/ch\.probation = false;/g) || []).length);

      const healthyLine = (src.match(/const healthy = \(c\) =>[^\n]*/) || [''])[0];
      // 抠出来的是 `const healthy = (c) => …;`：去掉声明头与行尾分号，才能当表达式用
      const healthyExpr = healthyLine.replace(/^const healthy = /, '').replace(/;\s*$/, '');
      const healthyOf = new Function('c', 'return (' + healthyExpr + ')(c);');
      const now = Date.now();
      check('★ 分层取值：冷却中 3 > down 2 > 观察期 1 > 健康 0',
        healthyOf({ cooldownUntil: now + 5000, status: 'ok' }) === 3
        && healthyOf({ cooldownUntil: 0, status: 'down' }) === 2
        && healthyOf({ cooldownUntil: 0, status: 'degraded', probation: true }) === 1
        && healthyOf({ cooldownUntil: 0, status: 'ok' }) === 0
        && healthyOf({ cooldownUntil: 0, status: 'degraded' }) === 0);
    }

    console.log('\n1. 真机：上游 5xx → 冷却按"瞬时"起步值给（不是老的 2 秒）');
    reset(); UA.mode = { status: 500 }; await restart();
    let r = await call();
    check('客户端拿到 200（兜底到 B）', r.status === 200 && r.ch === 'cd-b', { status: r.status, ch: r.ch });
    let ca = await chan('cd-a');
    check('★ A 的冷却 ≈ 1000ms（transientBaseMs），不是 2s/5s 之类的魔法数',
      near(cooldownLeft(ca), 1000), { left: cooldownLeft(ca), consecutiveFail: ca.consecutiveFail });
    check('★ A 的连败计数 = 1（perChannel 关掉后，一次请求就是一次失败）', ca.consecutiveFail === 1, ca.consecutiveFail);
    check('A 还没被打成 down（阈值仍是 3 次）', ca.status !== 'down', ca.status);

    console.log('\n2. 真机：连续 3 次 5xx → 冷却按 2^(n-1) 涨到"瞬时上限"，状态变 down');
    await sleep(1200); await call();            // 冷却过期后 A 会被再试 → 第 2 次失败
    await sleep(2300); await call();            // → 第 3 次失败
    ca = await chan('cd-a');
    check('★ 连败计数 = 3', ca.consecutiveFail === 3, ca.consecutiveFail);
    check('★ 冷却涨到瞬时上限 ≈ 4000ms（transientMaxMs，不是老的 60s 固定）',
      near(cooldownLeft(ca), 4000), { left: cooldownLeft(ca) });
    check('★ 连续失败 3 次 → 状态 down（排到候选链末尾）', ca.status === 'down', ca.status);

    console.log('\n3. 真机：401（凭证类）→ 起步就是分钟级，和 5xx 完全不同的耐心');
    reset(); UA.mode = { status: 401 }; await restart();
    await call();
    ca = await chan('cd-a');
    check('★ A 的冷却 ≈ 10000ms（hardBaseMs），而不是瞬时类的 1s',
      near(cooldownLeft(ca), 10000), { left: cooldownLeft(ca) });
    check('凭证类第一次失败：状态还没到 down（阈值不变，只是冷却更长）', ca.status !== 'down', ca.status);

    console.log('\n4. ★ 真机：429 + Retry-After: 7 → 听上游的，而不是我们自己的限流起步值');
    reset(); UA.mode = { status: 429, retryAfter: 7 }; await restart();
    await call();
    ca = await chan('cd-a');
    check('★ A 的冷却 ≈ 7000ms（Retry-After 覆盖 rateLimitBaseMs=2000）',
      near(cooldownLeft(ca), 7000), { left: cooldownLeft(ca) });

    console.log('\n5. 真机：429 没有 Retry-After → 回到限流起步值');
    reset(); UA.mode = { status: 429 }; await restart();
    await call();
    ca = await chan('cd-a');
    check('★ A 的冷却 ≈ 2000ms（rateLimitBaseMs）', near(cooldownLeft(ca), 2000), { left: cooldownLeft(ca) });

    console.log('\n6. ★★ 真机：探测成功只"半愈合" —— 计数减半、进观察期、不再抢链首');
    reset(); UA.mode = { status: 500 }; await restart();
    await call(); await sleep(1200); await call();
    ca = await chan('cd-a');
    check('前置：A 已经欠了 2 笔失败', ca.consecutiveFail === 2, ca.consecutiveFail);
    UA.mode = 'ok';                                   // 上游"看起来"修好了（/models 能过）
    const rc = await admin('/admin/recheck', { method: 'POST' });
    check('手动触发全量探测：/admin/recheck 正常返回', rc.status === 200 && rc.j.ok === true, rc.status);
    ca = await chan('cd-a');
    check('★ 探测成功 → 失败计数**减半**（2 → 1），不是清零', ca.consecutiveFail === 1, ca.consecutiveFail);
    check('★ 状态进观察期而是不 ok（探测证明不了"对话能成"）', ca.probation === true, ca.probation);
    check('★ 冷却被放开（否则凭证类 6 小时冷却会把"已经换好 key"的渠道也钉住）', !(ca.cooldownUntil > Date.now()), ca.cooldownUntil);
    check('★ 上次为什么被罚仍然看得到（半愈合不该擦掉证据）', /500/.test(String(ca.lastError || '')), ca.lastError);
    r = await call();
    check('★★ 观察期期间：首发让给健康渠道 B（A 的有效优先级更高也抢不回来）',
      r.status === 200 && r.ch === 'cd-b', { ch: r.ch, status: r.status });
    check('A 没被摘掉：作为兜底仍然可用（B 挂的时候还能顶上）', r.status === 200);

    console.log('\n7. ★ 真机：一次真实对话成功 → 观察期结束、彻底恢复首发');
    UA.chat = 0; UB.chat = 0;
    UB.mode = { status: 500 };
    await call();                                     // B 挂 → 兜底到 A → 真实成功
    const ua = UA, ub = UB;
    ca = await chan('cd-a');
    check('前置：这一发确实兜到了 A（A 真的被用过）', ua.chat >= 1, { aChat: ua.chat, bChat: ub.chat });
    check('★ 真实成功 → 失败计数彻底清零', ca.consecutiveFail === 0, ca.consecutiveFail);
    check('★ 真实成功 → 出观察期', !ca.probation, ca.probation);
    UB.mode = 'ok'; UA.chat = 0; UB.chat = 0;
    await sleep(150);                                  // 等 A 的冷却若还有
    r = await call();
    check('★★ 恢复后 A 重新回到首发（观察期只维持到下一次真实成功）', r.ch === 'cd-a', { ch: r.ch });

    console.log('\n8. ★ 回归：探测拉回**空模型列表** ≠ 观察期（这两个状态别再混用）');
    reset(); UA.mode = 'empty-models'; await restart();
    await admin('/admin/recheck', { method: 'POST' });
    ca = await chan('cd-a');
    check('空模型列表 → status 是 degraded（老语义：这家没报出任何模型）', ca.status === 'degraded', ca.status);
    check('★ 但它没有欠账 → 不进观察期（拿 status===\'degraded\' 当观察期信号会把它误降级）',
      !ca.probation && ca.consecutiveFail === 0, { probation: ca.probation, consecutiveFail: ca.consecutiveFail });
    r = await call();
    check('★ 它照旧按优先级首发（别名仍然可用，不该被无端降级）', r.status === 200 && r.ch === 'cd-a', { ch: r.ch, status: r.status });
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopChild(gw);
    try { upA.close(); upB.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不 process.exit()：见 stopChild 注释
})();
