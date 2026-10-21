#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/route-header-budget-e2e.test.js — 路由决策头 + 重试预算回归（v1.18.88，真起进程，零依赖）
 *
 * 守的是什么：两个**只能靠真跑才看得见**的东西。
 *   ① `X-ZZCSAPI-Route` —— 回答"为什么是这家"。它的价值全在**如实**：把 fallback 说成 priority、
 *      把"预算耗尽"说成"渠道全挂"，比不设这个头更糟（会把人引到错误的方向去查上游）。
 *      而且它必须活过**流式**那条路（`setHeader` 之后 `writeHead(status, {...})` 不会清掉它）——
 *      这正是最容易写错、也最容易被"只测非流式"漏掉的地方。
 *   ② 重试预算 —— `perChannel × maxModelFallbacks` 的真实上界是**相乘**的（40 家 × 6 次 = 240 发上游）。
 *      预算命中时必须 502 + `error.budget` 明细，而不是伪装成"渠道全部失败"。
 *
 * 覆盖：
 *   · 源码守卫：setHeader 而非 writeHead（否则流式/直出路径会丢头）、三条出口都设头、
 *     预算先判后加（保证第一家至少能试）、命中只记一次、命中即跳出外层循环；
 *   · routeHeaderValue 真值表（现抠源码）：非 ASCII → '?'、分号 → 逗号（否则一个 id 变两个键）、缺字段给默认；
 *   · 真链路：成功 → pick=priority + attempt=1；**流式成功也带这个头**；
 *     预算耗尽 → 502 + pick=exhausted + error.budget.hit=attempts + attempts[] 不被灌满；
 *     预算不限（0）+ 多家全 500 → 502 + pick=all-failed + attempt=渠道数；
 *     全在冷却 → 503 + pick=all-cooldown。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）；不出网。
 * 跑法：node test/route-header-budget-e2e.test.js      （退出码非 0 表示有回归）
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-route-'));
const GW_KEY = 'route-gw-key-123456', AD_KEY = 'route-admin-key-123456';

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

// 现抠 routeHeaderValue（头的取值规则）——这是"一个 id 变两个键"/"非 ASCII 头直接 500"的唯一防线
// ★ 仓库源码是 CRLF：找块尾必须按 '\r\n}\r\n' 找，按 '\n}\n' 会得到 end=-1、抽出空函数
function makeRouteHeaderFn() {
  const start = SRC.indexOf('function routeHeaderValue(o) {');
  const end = SRC.indexOf('\r\n}\r\n', start) + 4;
  return new Function(SRC.slice(start, end) + '\nreturn routeHeaderValue;')();
}
// 现抠 RETRY_BUDGET 的钳制逻辑（0 = 不限、越界钳回、非法落默认）
function makeBudgetFn() {
  const start = SRC.indexOf('const RETRY_BUDGET = (() => {');
  const end = SRC.indexOf('\r\n})();', start) + 7;
  const src = SRC.slice(start, end).replace('const RETRY_BUDGET =', 'const R =');
  return new Function('RETRIES', src + '\nreturn R;');
}

(async () => {
  /* ─────────────────────────── 0. 源码守卫 ─────────────────────────── */
  console.log('\n0. 源码守卫（装配位置）');
  const setIdx = SRC.indexOf('function setRouteHeader(res, o) {');
  const loopIdx = SRC.indexOf('for (let attempt = 0; ; attempt++) {');
  const callInLoop = SRC.indexOf('setRouteHeader(res, {', loopIdx);
  const call502 = SRC.indexOf("pick: budgetExhausted ? 'exhausted' : 'all-failed'");
  const call503 = SRC.indexOf("pick: 'all-cooldown'");
  check('setRouteHeader 用 setHeader（不是 writeHead）——否则 10 处 writeHead 全得改，且必漏',
    /res\.setHeader\('X-ZZCSAPI-Route', routeHeaderValue\(o\)\)/.test(SRC));
  check('响应已提交时设头会抛，必须吞掉（响应本身比这个头重要）',
    /if \(!res \|\| res\.headersSent \|\| res\.writableEnded\) return;/.test(SRC.slice(setIdx, setIdx + 400)));
  check('每次上游尝试前都刷新头（最后一次刷进去的就是产生响应的那发）', callInLoop > loopIdx);
  check('502 出口设头（exhausted / all-failed）', call502 > 0);
  check('503 出口设头（all-cooldown）', call503 > 0);
  check('预算先判后加（budgetAttempts 从 0 起、0 时恒 false ⇒ 第一家必能试，不会一进门就 502）',
    /if \(budgetHit\(\)\) \{/.test(SRC) && SRC.indexOf('if (budgetHit()) {') < SRC.indexOf('budgetAttempts++;'));
  check('命中只记一次（budgetExhausted 一旦有值就不再改，否则次数/耗时两个计数会互相污染）',
    /if \(!budgetExhausted && budgetAttempts > 0\) \{/.test(SRC));
  check('命中后跳出**外层**候选循环（否则剩下每家各推一条废话，把 attempts 灌满）',
    /if \(budgetExhausted\) break;/.test(SRC));
  check('粘性是否真动了链首，按"链首换人"判（不是"表里有这个会话"）',
    /const affinityHoisted = !!\(candidates\[0\] && candidates\[0\]\.channelId !== headBeforeAffinity\);/.test(SRC));
  check('预算默认宽到正常请求够不着（32 次 / 10 分钟）',
    /attempts: pick\(RETRIES\.budgetAttempts, 1, 500, 32\)/.test(SRC) && /ms: pick\(RETRIES\.budgetMs, 1000, 3_600_000, 600_000\)/.test(SRC));

  /* ─────────────────────────── 1. 取值真值表 ─────────────────────────── */
  console.log('\n1. routeHeaderValue 真值表（现抠源码）');
  {
    const rh = makeRouteHeaderFn();
    check('正常值原样输出', rh({ ch: 'ch-a', pick: 'priority', pos: '1/3', attempt: 1, skipped: 0 }) === 'ch=ch-a; pick=priority; pos=1/3; attempt=1; skipped=0',
      rh({ ch: 'ch-a', pick: 'priority', pos: '1/3', attempt: 1, skipped: 0 }));
    check('非 ASCII 一律替换成 ?（HTTP 头只允许 latin-1，中文头会让整个响应 500）',
      rh({ ch: '渠道甲', pick: 'priority', pos: '1/1' }) === 'ch=???; pick=priority; pos=1/1',
      rh({ ch: '渠道甲', pick: 'priority', pos: '1/1' }));
    check('分号替换成逗号（否则一个渠道 id 能把头拆成两个键）',
      rh({ ch: 'a;b', pick: 'priority', pos: '1/1' }).includes('ch=a,b'),
      rh({ ch: 'a;b', pick: 'priority', pos: '1/1' }));
    check('缺字段给默认值（ch=- / pick=priority / pos=?），不出现 undefined',
      rh({}) === 'ch=-; pick=priority; pos=?', rh({}));
    check('attempt/skipped 不传就不出现（不是硬塞 0 冒充事实）',
      !rh({ ch: 'x', pick: 'weighted', pos: '2/5' }).includes('attempt='),
      rh({ ch: 'x', pick: 'weighted', pos: '2/5' }));
    check('取值里绝不含换行/回车（头注入）',
      !/[\r\n]/.test(rh({ ch: 'a\r\nX-Evil: 1', pick: 'priority', pos: '1/1' })),
      rh({ ch: 'a\r\nX-Evil: 1', pick: 'priority', pos: '1/1' }));
  }

  console.log('\n2. RETRY_BUDGET 钳制（现抠源码）');
  {
    const mk = makeBudgetFn();
    check('缺省 → 32 次 / 600000ms', JSON.stringify(mk({})) === JSON.stringify({ attempts: 32, ms: 600000 }), mk({}));
    check('0 = 显式不限（老配置零行为变化）', JSON.stringify(mk({ budgetAttempts: 0, budgetMs: 0 })) === JSON.stringify({ attempts: 0, ms: 0 }), mk({ budgetAttempts: 0, budgetMs: 0 }));
    check('越界钳回上限（500 / 1h）', mk({ budgetAttempts: 9999, budgetMs: 9e9 }).attempts === 500 && mk({ budgetAttempts: 9999, budgetMs: 9e9 }).ms === 3600000, mk({ budgetAttempts: 9999, budgetMs: 9e9 }));
    check('太小钳到下限（1 次 / 1s）', mk({ budgetAttempts: -5, budgetMs: 3 }).attempts === 1 && mk({ budgetAttempts: -5, budgetMs: 3 }).ms === 1000, mk({ budgetAttempts: -5, budgetMs: 3 }));
    check('非数字落默认（不因为配置写成字符串就把预算关掉）', mk({ budgetAttempts: 'abc' }).attempts === 32, mk({ budgetAttempts: 'abc' }));
  }

  /* ─────────────────────────── 2. 真链路 ─────────────────────────── */
  console.log('\n3. 真链路（假上游 + 临时网关）');
  // 假上游：/v1/models → 200；chat 模型名含 good → 200（含 SSE）；否则 500（可重试失败）
  const up = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      const b = Buffer.concat(cs).toString('utf8');
      if (req.method === 'GET' && /models/.test(req.url || '')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'good' }, { id: 'm1' }] }));
      }
      if (/"model"\s*:\s*"[^"]*good/i.test(b)) {
        if (/"stream"\s*:\s*true/.test(b)) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'po' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ng' }, finish_reason: 'stop' }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'good', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fake upstream always 500' } }));
    });
  });
  const PUP = await freePort();
  await new Promise((r) => up.listen(PUP, '127.0.0.1', r));

  let gw = null, GW = 0;
  const mkCfg = (retries, chans) => {
    const p = path.join(TMP, 'cfg-' + Math.random().toString(36).slice(2, 8) + '.json');
    fs.writeFileSync(p, JSON.stringify({
      port: GW, health: { intervalSec: 3600, timeoutMs: 2000 }, retries,
      channels: chans.map((c) => ({ protocol: 'openai', baseUrl: `http://127.0.0.1:${PUP}/v1`, apiKey: 'sk-x', enabled: true, ...c })),
    }));
    return p;
  };
  const spawnGw = async (cfgPath) => {
    gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'u-' + Math.random().toString(36).slice(2, 8) + '.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
      stdio: 'ignore',
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try { if ((await fetch(`http://127.0.0.1:${GW}/healthz`)).ok) return true; } catch { }
      await sleep(150);
    }
    return false;
  };
  const stopGw = () => new Promise((res) => {
    if (!gw || gw.exitCode !== null) return res();
    gw.once('exit', () => res());
    try { gw.kill(); } catch { }
    setTimeout(res, 1500);
  });
  const chat = async (model, extra) => {
    const r = await fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...(extra || {}) }),
    });
    const text = await r.text();
    return { status: r.status, route: r.headers.get('x-zzcsapi-route'), channel: r.headers.get('x-zzcsapi-channel'), text };
  };
  const parseRoute = (h) => {
    const o = {};
    String(h || '').split(';').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) o[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); });
    return o;
  };

  try {
    /* ── 3a. 成功路径 + 流式路径 ── */
    GW = await freePort();
    if (!await spawnGw(mkCfg({ perChannel: 1, maxModelFallbacks: 99, budgetAttempts: 2 }, [
      { id: 'rh-good', name: 'good', priority: 1, models: { good: 'good' } },
      { id: 'rh-b1', name: 'b1', priority: 10, models: { m1: 'm' } },
      { id: 'rh-b2', name: 'b2', priority: 11, models: { m1: 'm' } },
      { id: 'rh-b3', name: 'b3', priority: 12, models: { m1: 'm' } },
    ]))) throw new Error('网关未起来');

    const ok = await chat('good');
    const ro = parseRoute(ok.route);
    check('成功：200', ok.status === 200, ok.status);
    check('成功：pick=priority（没有加权/粘性/游标参与时，如实说是优先级）', ro.pick === 'priority', ok.route);
    check('成功：ch 就是真用的那家，与 X-ZZCSAPI-Channel 一致（身份仍以旧头为准）',
      ro.ch === 'rh-good' && ok.channel === 'rh-good', [ok.route, ok.channel]);
    check('成功：pos=1/1 且 attempt=1（这一发是第 1 次上游尝试）', ro.pos === '1/1' && ro.attempt === '1', ok.route);
    check('成功：skipped=0（没有冷却跳过）', ro.skipped === '0', ok.route);
    check('头是纯 ASCII（否则 Node 会在 setHeader 时抛）', /^[\x20-\x7E]*$/.test(ok.route || ''), ok.route);

    const st = await chat('good', { stream: true });
    const rst = parseRoute(st.route);
    check('流式成功：200 且正文是 SSE', st.status === 200 && /data: /.test(st.text), [st.status, st.text.slice(0, 80)]);
    check('★ 流式路径也带路由头（setHeader 早于 writeHead，所以不会被 headers 对象清掉）',
      st.route && rst.ch === 'rh-good' && rst.pick === 'priority', st.route);

    /* ── 3b. 预算耗尽 ── */
    const ex = await chat('m1');
    const rx = parseRoute(ex.route);
    let body = {};
    try { body = JSON.parse(ex.text); } catch { }
    check('预算耗尽：502（不是 200，也不是 503）', ex.status === 502, ex.status);
    check('预算耗尽：pick=exhausted（如实说是预算先到，不是"渠道全挂"）', rx.pick === 'exhausted', ex.route);
    check('预算耗尽：attempt=2（budgetAttempts=2，perChannel=1 让它第 2 次就撞上限）', rx.attempt === '2', ex.route);
    check('预算耗尽：error.budget 有明细（hit/attemptsUsed/attemptsMax）',
      body.error && body.error.budget && body.error.budget.hit === 'attempts' && body.error.budget.attemptsUsed === 2 && body.error.budget.attemptsMax === 2,
      body.error && body.error.budget);
    check('预算耗尽：错误文案点名 retries.budgetAttempts（用户照着改配置就能改）',
      /budgetAttempts/.test((body.error && body.error.message) || ''), body.error && body.error.message);
    check('预算耗尽：attempts[] 不被灌满（≤ 3 条：2 发失败 + 至多 1 条预算说明，而不是 4 家各一条）',
      Array.isArray(body.error && body.error.attempts) && body.error.attempts.length <= 3,
      body.error && body.error.attempts && body.error.attempts.length);

    await stopGw();

    /* ── 3c. 预算不限 + 多家全 500 → all-failed ── */
    GW = await freePort();
    if (!await spawnGw(mkCfg({ perChannel: 0, maxModelFallbacks: 99, budgetAttempts: 0 }, [
      { id: 'af-1', name: 'a1', priority: 1, models: { m1: 'm' } },
      { id: 'af-2', name: 'a2', priority: 2, models: { m1: 'm' } },
      { id: 'af-3', name: 'a3', priority: 3, models: { m1: 'm' } },
    ]))) throw new Error('网关(2) 未起来');

    const af = await chat('m1');
    const ra = parseRoute(af.route);
    let b2 = {};
    try { b2 = JSON.parse(af.text); } catch { }
    check('全部失败：502', af.status === 502, af.status);
    check('全部失败：pick=all-failed（与 exhausted 必须分得开）', ra.pick === 'all-failed', af.route);
    check('全部失败：三家都试过了（attempt=3）', ra.attempt === '3', af.route);
    check('全部失败：没有 error.budget（预算没参与，不许编一个出来）', !(b2.error && b2.error.budget), b2.error && b2.error.budget);
    check('全部失败：attempts[] 每家一条（3 条）', Array.isArray(b2.error && b2.error.attempts) && b2.error.attempts.length === 3, b2.error && b2.error.attempts && b2.error.attempts.length);

    /* ── 3d. 全在冷却 → all-cooldown ── */
    const again = await chat('m1');
    const rc = parseRoute(again.route);
    let b3 = {};
    try { b3 = JSON.parse(again.text); } catch { }
    check('冷却后重发：503', again.status === 503, again.status);
    check('冷却后重发：pick=all-cooldown', rc.pick === 'all-cooldown', again.route);
    check('冷却后重发：attempt=0 且 skipped=3（一个都没试，如实说）',
      rc.attempt === '0' && rc.skipped === '3', again.route);
    check('冷却后重发：error.cooldown 有每家恢复时间', Array.isArray(b3.error && b3.error.cooldown) && b3.error.cooldown.length === 3,
      b3.error && b3.error.cooldown && b3.error.cooldown.length);
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopGw();
    await new Promise((r) => up.close(r));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log((fail === 0 ? '✓ 全部通过' : '✗ 有失败') + `（${pass + fail} 项断言：通过 ${pass} · 失败 ${fail}）`);
  console.log(`══════ 通过 ${pass} · 失败 ${fail} ══════`);
  process.exit(fail === 0 ? 0 : 1);
})();
