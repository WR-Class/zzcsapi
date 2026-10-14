#!/usr/bin/env node
/* 重试链路前进性回归（node test/retry-chain-progress.test.js，零依赖）
 *
 * 守的是什么（v1.18.62）——三件事，每一件都有它自己的反例：
 *
 *  ① **客户端断开即停链**：不再做"没人等的工"。
 *     现场：客户端 120s 超时后重发，而**旧的那条链还在继续换家**；最多 6 条链同时跑，
 *     每条都从第 1 家开始 —— 排在前面的坏家被反复吸住，排在后面的好家要 8×65s≈520s 才轮到。
 *  ② **候选游标**：同报文（自动重试）从上次停下的**下一家**继续；报文变了（用户新一轮）归零。
 *     现场：首字超时的冷却只有 **5 秒**，而重试间隔 **≥120 秒** —— 冷却早过期，
 *     于是 5 次重试全砸在同一家上，一家都没前进。
 *  ③ **失败行记真实的入参规模与耗时**：此前写死 `inputTokens: 0, latencyMs: 0`，
 *     账本里失败行永远是 `in=0 out=0`，"那发到底多大、等了多久"完全看不见。
 *
 * ①② 用**真 HTTP 链路**验（假上游 + 真网关 + 主动断开）；③ 用源码守卫 + 真值表验。
 *
 * ⚠ 本用例**刻意不假设候选顺序**：本项目用加权轮询，第一家并不固定。
 *   所以它断言的是"**是不是换了另一家**"，而不是"第几家是 slowA"。
 *   （第一版就是假设了顺序，结果 5 条断言全废——那是测试的错，不是产品的错。）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-cursor-'));

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
function extract(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(SRC);
  if (!m) throw new Error('找不到函数: ' + name);
  let i = SRC.indexOf('{', m.index), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return SRC.slice(m.index, i);
}
function extractDecl(decl) {
  const m = new RegExp('^(?:const|let)\\s+' + decl + '\\s*=.*$', 'm').exec(SRC);
  if (!m) throw new Error('找不到声明: ' + decl);
  return m[0];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

function startGateway(cfgPath, port) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_NOAUTH: '1',
      ZZCSAPI_BIND: '127.0.0.1', ZZCSAPI_DUMP_BODIES: '', ZZCSAPI_CONTEXT_DIET: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  p.stdout.on('data', (b) => String(b).split('\n').forEach((l) => l && lines.push(l)));
  p.stderr.on('data', (b) => String(b).split('\n').forEach((l) => l && lines.push('[err] ' + l)));
  return { proc: p, lines };
}
async function waitUp(port, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return true; } catch { /* 还没起 */ }
    await sleep(120);
  }
  return false;
}

/* ── 纯决策函数：这一发该从第几家开始 ── */
console.log('\n1. 游标决策真值表（纯函数）');
{
  /* ★ 装配兜底：把 envNonNegInt 一起抠进来——CHAIN_CURSOR_TTL_MS 要调它，漏了就是 ReferenceError。
     上一轮（首字死线）已经因为同一个疏漏炸过一次，所以这里把它放进同一个表达式。 */
  const code = [extract('envNonNegInt'), extractDecl('CHAIN_CURSOR_TTL_MS'), extract('cursorStartFor')].join('\n');
  check('能从源码抠出 envNonNegInt + CHAIN_CURSOR_TTL_MS + cursorStartFor（抠不到下面几条会全炸）',
    /function envNonNegInt/.test(code) && /CHAIN_CURSOR_TTL_MS/.test(code) && /function cursorStartFor/.test(code));
  const cursorStartFor = new Function(code + '\nreturn cursorStartFor;')();
  const TTL = 15 * 60_000;
  const now = 1_000_000_000;
  const prev = (h, chId, ageMs) => ({ bodyHash: h, lastChannelId: chId, at: now - ageMs });
  const ids = ['a', 'b', 'c', 'd'];

  check('没有历史 → 第 1 家', cursorStartFor(null, 'H', now, ids) === 0);
  check('★ 同报文且在有效期内 → 从上一发停下的那家**之后**继续', cursorStartFor(prev('H', 'b', 1000), 'H', now, ids) === 2);
  check('★ 报文变了（用户新一轮）→ 归零', cursorStartFor(prev('H', 'b', 1000), 'H2', now, ids) === 0);
  check('★ 过期 → 归零', cursorStartFor(prev('H', 'b', TTL + 1), 'H', now, ids) === 0);
  check('恰好到期即归零（边界）', cursorStartFor(prev('H', 'b', TTL), 'H', now, ids) === 0);
  check('★ 上一发那家**不在**这一轮的候选里（被冷却裁掉）→ 归零，不硬跳',
    cursorStartFor(prev('H', 'zz', 1000), 'H', now, ids) === 0);
  check('★ 与候选表顺序无关：同一家在不同排布下都定位到"它的下一家"',
    cursorStartFor(prev('H', 'b', 1000), 'H', now, ['a', 'b', 'c', 'd']) === 2
    && cursorStartFor(prev('H', 'b', 1000), 'H', now, ['d', 'c', 'b', 'a']) === 3);
  check('停在末位 → 回绕到第 1 家（不空转）', cursorStartFor(prev('H', 'd', 1000), 'H', now, ids) === 0);
  check('空候选表 / 没有报文哈希（无会话历史）→ 归零',
    cursorStartFor(prev('H', 'b', 1000), 'H', now, []) === 0
    && cursorStartFor(prev('H', 'b', 1000), null, now, ids) === 0);
}

console.log('\n2. 装配守卫：三件事真的接上了');
{
  check('★ 用 AsyncLocalStorage 而不是模块级变量（并发下后者会把 A 的耗时记到 B 的失败行）',
    /const \{ AsyncLocalStorage \} = require\('async_hooks'\)/.test(SRC) && /const reqScope = new AsyncLocalStorage\(\)/.test(SRC));
  check('dispatchRequest 在请求作用域里跑内层（run 包住 dispatchRequestInner）',
    /return reqScope\.run\(scope, \(\) => dispatchRequestInner\(opts\)\)/.test(SRC));
  check('★ 失败行读作用域：有作用域写真实值，没有留 0（0 只表示"本就没有"，不冒充测到的值）',
    /const sc = reqScope\.getStore\(\)/.test(SRC)
    && /inputTokens: sc && Number\.isFinite\(sc\.inputTokens\) \? sc\.inputTokens : 0/.test(SRC)
    && /latencyMs: sc \? Math\.max\(0, Date\.now\(\) - sc\.startedAt\) : 0/.test(SRC));
  check('失败行不再写死 `inputTokens: 0, outputTokens: 0, ... latencyMs: 0`',
    !/kind: 'error', inputTokens: 0, outputTokens: 0, ok: false, latencyMs: 0/.test(SRC));
  check('★ 断开标志挂在 res 的 close 上，且**每次尝试之前**先查',
    /res\.on\('close', \(\) => \{ clientGone\.v = true; \}\)/.test(SRC)
    && /if \(clientGone\.v\) \{/.test(SRC));
  check('★ 候选循环按 `(startAt + k) % maxCand` 走（游标起点 + 回绕）',
    /const i = \(startAt \+ k\) % maxCand;/.test(SRC));
  check('游标只前移、不除名：记的是「最后试过的那一家的 id」（不是序号——序号会被加权轮询重排打乱）',
    /chainCursors\.set\(curKey, \{ bodyHash: curHash, lastChannelId, at: Date\.now\(\) \}\)/.test(SRC)
    && !/chainCursors[\s\S]{0,200}candidates\.splice/.test(SRC));
  check('游标表有上限（超过就淘汰最旧的键），不会无限增长',
    /while \(chainCursors\.size > CHAIN_CURSOR_MAX\)/.test(SRC));
  check('每渠道上限默认 90s（用户选定）', /envNonNegInt\('ZZCSAPI_FIRST_BYTE_MAX_MS', 90_000,/.test(SRC));
}

console.log('\n3. 真链路：断开 → 停链；同报文重试 → 换一家（③+④ 的现场复现）');
(async () => {
  const upPort = await freePort();
  const gwPort = await freePort();
  let hitOrder = [];                       // 按时间记下"哪一家被碰了"，不假设谁排第一

  // 两个上游行为**完全一致**（400ms 后回 500）：这样"先碰哪家"只由网关决定，用例不做任何顺序假设
  const upstream = http.createServer((req, res) => {
    // ★ 探测打的是 /models，不是对话 —— 必须放行。第一版对它也回 500，于是**启动探测把两家一起
    //   打进冷却**，后面两发全被"全部候选都在冷却"挡掉、hitOrder 全空（看起来像游标没生效）。
    if (!/chat\/completions/.test(String(req.url || ''))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }));
      req.resume();
      return;
    }
    const who = String(req.headers.authorization || '').includes('sk-a') ? 'A' : 'B';
    hitOrder.push(who);
    req.on('data', () => {});
    req.on('end', () => setTimeout(() => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom-' + who } }));
    }, 400));
  });
  await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: gwPort, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
    // ★ 冷却压到最小值（1000ms，`cooldownMsFor` 的下界）：默认 5s 会盖住用例的节奏，
    //   让"两家都在冷却"把请求 2/3 全挡掉（第一版就是这样，看起来像游标没生效）。
    //   压到 1s 后，每一发之间留够 2.2s，两家就都是**可用**的——此时"从哪家开始"只由游标决定。
    cooldown: { transientBaseMs: 1000 },
    channels: [
      { id: 'upA', name: 'upA', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-a', enabled: true, priority: 10, models: { mock: 'mock' } },
      { id: 'upB', name: 'upB', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-b', enabled: true, priority: 20, models: { mock: 'mock' } },
    ],
  }));
  const gw = startGateway(cfgPath, gwPort);
  const body1 = { model: 'mock', messages: [{ role: 'user', content: 'same body' }], stream: false };
  const send = (body, abortAfterMs) => {
    const ctrl = new AbortController();
    const p = fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
    }).catch(() => null);
    if (abortAfterMs) setTimeout(() => ctrl.abort(), abortAfterMs);
    return p;
  };

  try {
    check('网关启动', await waitUp(gwPort), gw.lines.slice(-2));

    /* 第一发：客户端在第一个上游还没失败时就断开 */
    hitOrder = [];
    await send(body1, 150);
    await sleep(2200);                     // 等上游的 500 回来 + 让它从 1s 冷却里恢复（见 config 注释）

    check('★ 断开前确实发起过（否则下面那条可能只是"从来没跑起来"）', hitOrder.length === 1, { hitOrder });
    const firstCh = hitOrder[0];
    check('★ 客户端断开后**不再**换到另一家（没人等的工不做）', hitOrder.length === 1, { hitOrder });
    check('日志里记下了"客户端已断开，在第 N/M 次尝试前停止"',
      gw.lines.some((l) => /客户端已断开，在第 \d+\/\d+ 次尝试前停止/.test(l)), gw.lines.filter((l) => /chain/.test(l)).slice(-2));

    /* 第二发：**逐字节相同的报文**（模拟客户端自动重试）→ 游标应把它送到另一家 */
    hitOrder = [];
    const r2 = await send(body1, 0);
    await sleep(2200);
    check('第二发不是"全部候选都在冷却"（否则下面那条会因为错误的原因而通过）',
      r2 && r2.status !== 503, r2 && r2.status);
    check('★ 同报文重试**从下一家开始**：先被碰的不是上一发那一家',
      hitOrder.length > 0 && hitOrder[0] !== firstCh, { hitOrder, firstCh });
    check('日志里记下了"同报文续试：从第 N/M 家（X）开始"，且 X 不是上一发那一家',
      gw.lines.some((l) => /同报文续试：从第 \d+\/\d+ 家（[^）]+）开始/.test(l) && !new RegExp('（' + firstCh + '）开始').test(l)),
      gw.lines.filter((l) => /cursor/.test(l)).slice(-2));

    /* 控制组：报文变了（用户新一轮）→ 必须归零。
       ★ 这里刻意**不看是"哪一家"被碰**（候选表被加权轮询重排，顺序本来就不固定），
         而是看网关自己有没有走"续试"那条路——顺序无关的证据在日志里。 */
    const cursorLogsBefore = gw.lines.filter((l) => /同报文续试/.test(l)).length;
    hitOrder = [];
    await send({ model: 'mock', messages: body1.messages.concat([{ role: 'assistant', content: 'x' }, { role: 'user', content: 'new turn' }]), stream: false }, 150);
    await sleep(2200);
    const cursorLogsAfter = gw.lines.filter((l) => /同报文续试/.test(l)).length;
    check('★ 控制组：报文变了 → 归零（没有新增"同报文续试"，从第 1 家重来）',
      cursorLogsAfter === cursorLogsBefore && hitOrder.length === 1, { cursorLogsBefore, cursorLogsAfter, hitOrder });
  } finally {
    if (fail) {                             // 只在失败时打网关日志，避免正常跑也刷屏
      console.log('\n  ── 网关日志（诊断用，最后 18 行）──');
      gw.lines.slice(-18).forEach((l) => console.log('    ' + l));
    }
    try { gw.proc.kill('SIGKILL'); } catch { /* 已退出 */ }
    try { upstream.close(); } catch { /* 已关 */ }
  }

  console.log('\n' + '─'.repeat(58));
  if (fail === 0) console.log(`✓ 全部通过（${pass} 项断言）`);
  else { console.log(`✗ ${pass} 通过 / ${fail} 失败`); process.exitCode = 1; }
})();
