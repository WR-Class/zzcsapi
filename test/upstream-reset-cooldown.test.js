#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/upstream-reset-cooldown.test.js — 「冷却贴着上游真实 reset」回归（零依赖，纯函数）
 *
 * 背景（v1.18.95，思路抄自 magpie 的 creditBackoff）：
 *   熔断冷却此前只有三种依据——`Retry-After` 头、或自己的指数曲线。
 *   实测我们库里的 429 **大多不带 Retry-After**，却把"什么时候恢复"写在正文里：
 *     · OpenAI 系 `"resets_in_seconds": 37` / `"resets_at": "2026-…Z"`
 *     · 各家中继 `"retry_after": 120`、`"msg":"… will reset at 2026-09-28 10:00:39 UTC+8"`
 *     · 自定义头 `x-ratelimit-reset: <unix 秒>`
 *   这些正文本就在手里（recordFailure 的 msg 就是 `HTTP 429: {…body…}`），却一个字都没用上。
 *   代价是双向的：**要么额度早恢复了还在空等**（用户体验成"这渠道怎么一直是红的"），
 *   **要么提早去撞墙**（每次撞都再记一次失败，streak 越滚越高，冷却反而更长——死锁）。
 *
 * 本轮契约 = 一条四层优先级链（见 server.js cooldownMsFor 的注释）：
 *   ① `Retry-After` 头（上游最明确的意图）
 *   ② 响应体/自定义头里的 reset 时刻（本次新增 resetMsFromBody）
 *   ③ 自己的指数曲线（原有行为，一条都不许改）
 *   ④ 全部过 `hardMaxMs` 硬上限（坏上游没法用一个大数字把我们钉住一天）
 *
 * ★ 为什么这里要用「现抠 server.js 的真函数」而不是把逻辑抄一遍：
 *   抄一遍就等于有了第二份真值——改了 server.js 忘了改这里，测试照样绿，
 *   而它守的正是"冷却该多长"这种**错了也很难看出来**的东西。
 *   所以本文件用括号配对把 parseLooseStamp / resetMsFromBody / cooldownMsFor 抠出来，
 *   与 server.js 现跑的是同一份代码。
 *
 * 跑法：node test/upstream-reset-cooldown.test.js   （退出码非 0 = 有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '\n      ' + JSON.stringify(extra) : '')); }
};

/* ── 从 server.js 现抠真实实现（括号配对；抠不到就当场失败，不静默跳过）─────────
   抠不出来通常意味着函数改名了 / 被内联了 —— 那时这条测试要么改抠法、要么删掉，
   但**绝不能**退化成"抠不到就跳过"，那等于把守卫变成一个不会红的摆设。 */
function grabFn(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('server.js 里找不到函数 ' + name + '（改名了？请同步本脚本）');
  let depth = 0;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    const c = SRC[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(i, k + 1); }
  }
  throw new Error('函数 ' + name + ' 的花括号没配平（抠不出来）');
}

const RESET_TEXT_RE_LINE = (() => {
  const at = SRC.indexOf('var RESET_TEXT_RE');
  if (at < 0) throw new Error('server.js 里找不到 var RESET_TEXT_RE（改名了？请同步本脚本）');
  return SRC.slice(at, SRC.indexOf('\n', at));
})();

/* 真实的 COOLDOWN 值（与 server.js 的默认值一致），保证钳制行为按真实口径验 */
const COOLDOWN = {
  transientBaseMs: 5_000, transientMaxMs: 600_000,
  hardBaseMs: 300_000, hardMaxMs: 6 * 3600_000,
  rateLimitBaseMs: 60_000,
};

const effFailStreak = (ch) => Math.max(Number(ch.consecutiveFail) || 0, Number(ch.probeFail) || 0);
const FN_CODE = [
  RESET_TEXT_RE_LINE,
  grabFn('parseLooseStamp'),
  grabFn('resetMsFromBody'),
  grabFn('cooldownMsFor'),
  'return { parseLooseStamp, resetMsFromBody, cooldownMsFor };',
].join('\n');
const { parseLooseStamp, resetMsFromBody, cooldownMsFor } =
  new Function('COOLDOWN', 'effFailStreak', FN_CODE)(COOLDOWN, effFailStreak);

const NOW = Date.now();
const H = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
const stampNoTz = (ms) => iso(ms).slice(0, 19).replace('T', ' ');
const secs = (ms) => Math.round(ms / 1000);
/* 时间比较留 3 秒容差：解析与断言之间时钟会走，但"贴没贴上游"这件事本身是数量级的 */
const near = (got, want) => (want === 0 ? got === 0 : Math.abs(got - want) <= Math.max(3000, want * 0.002));

console.log('  现抠 server.js 的真函数：parseLooseStamp / resetMsFromBody / cooldownMsFor\n');

/* ══ §1 该解析出来的（贴上游）══════════════════════════════════════════════ */
console.log('  ── §1 响应体里的 reset 时刻必须解析出来 ──');
{
  const cases = [
    ['resets_in_seconds（OpenAI 系，秒）', 'HTTP 429: {"resets_in_seconds":37}', 37_000],
    ['resets_in_seconds（大数，如 1 小时）', 'HTTP 429: {"resets_in_seconds":3600}', 3_600_000],
    ['resets_in_ms（毫秒字段，不能当秒）', 'HTTP 429: {"resets_in_ms":90000}', 90_000],
    ['retry_after（部分中继用这个键）', 'HTTP 429: {"retry_after":120}', 120_000],
    ['resets_at（ISO 绝对时刻）', 'HTTP 429: {"resets_at":"' + iso(NOW + H) + '"}', H],
    ['reset_time / next_reset 同义键', 'HTTP 429: {"next_reset":"' + iso(NOW + 2 * H) + '"}', 2 * H],
    ['自由文本 reset at … UTC+8（workbuddy 写法）',
      'HTTP 429: {"msg":"will reset at ' + stampNoTz(NOW + 10 * H) + ' UTC+8"}', 2 * H],
    ['自由文本 reset at … UTC-5', 'HTTP 429: {"msg":"reset at ' + stampNoTz(NOW + H) + ' UTC-5"}', 6 * H],
    ['自由文本不带时区（按 UTC 算）', 'HTTP 429: {"msg":"reset at ' + stampNoTz(NOW + H) + '"}', H],
  ];
  for (const [label, body, want] of cases) {
    const got = resetMsFromBody(body, null, NOW);
    check(label + ' → ' + secs(want) + 's', near(got, want), { got: secs(got), want: secs(want) });
  }
}

/* ══ §2 绝不许解析出来的（假阳性 = 冷却乱跳，比不解析更糟）════════════════════ */
console.log('\n  ── §2 不含 reset 信息的失败，必须返回 0（不许瞎猜）──');
{
  /* 前四条是**线上真实出现过**的失败文案（2026-11 从 /admin/api/usage 的 recent 里取的），
     它们里面没有任何"什么时候恢复"的信息，一个数字都不该抠出来。 */
  const cases = [
    ['真实：免费模型限流（无 reset 信息）',
      'HTTP 429: {"error":{"message":"Too many requests for this free model (request_id: chatcmpl-84f63d9ed)","type":"rate_limit_exceeded_error"}}'],
    ['真实：积分余额不足', 'HTTP 429: {"error":{"message":"积分余额不足，请充值后重试","code":"insufficient_points"}}'],
    ['真实：TLS 握手前断连', 'Client network socket disconnected before secure TLS connection was established'],
    ['真实：上游首字节超时', 'first byte timeout: 上游 57s 未回响应头（挂起/排队）'],
    ['真实：模型不存在（400，不是限流）', 'HTTP 400: {"error":{"message":"Model id has no provider supported"}}'],
    ['过期时刻（上游报文陈旧，不能当有效意图）', 'HTTP 429: {"resets_at":"2000-01-01T00:00:00Z"}'],
    ['空正文', ''],
    ['纯 HTML 错误页', 'HTTP 502: <html><head><title>502 Bad Gateway</title></head></html>'],
  ];
  for (const [label, body] of cases) {
    const got = resetMsFromBody(body, null, NOW);
    check(label + ' → 0', got === 0, { got: secs(got) });
  }
}

/* ══ §3 自定义头 x-ratelimit-reset（Unix 秒）════════════════════════════════ */
console.log('\n  ── §3 自定义头里的 reset（Unix 秒）──');
{
  const mk = (v) => ({ get: (k) => (k === 'x-ratelimit-reset' ? String(v) : null) });
  const got = resetMsFromBody('HTTP 429: {}', mk(Math.floor((NOW + 300_000) / 1000)), NOW);
  check('x-ratelimit-reset 秒级时间戳 → 300s', near(got, 300_000), { got: secs(got) });
  const gotMs = resetMsFromBody('HTTP 429: {}', mk(NOW + 600_000), NOW);
  check('x-ratelimit-reset 毫秒级时间戳 → 600s', near(gotMs, 600_000), { got: secs(gotMs) });
}

/* ══ §4 优先级链：头 > 体 > 曲线，且全部过 hardMax 硬上限 ═════════════════════ */
console.log('\n  ── §4 cooldownMsFor 的四层优先级链 ──');
{
  const ch = { consecutiveFail: 1 };
  const cd = (retryAfterMs, body) => cooldownMsFor(ch, 'rate_limit', retryAfterMs, body);

  /* ① 基准：什么信息都没有 → 原有曲线（rate_limit 起步 60s）。**这条必须与改动前一致。** */
  const base = cd(undefined, 'HTTP 429: {"error":"too many requests"}');
  check('无任何信息 → 走曲线（rate_limit 起步 60s）', base === COOLDOWN.rateLimitBaseMs, { base: secs(base) });

  /* ② Retry-After 头最优先 */
  check('Retry-After 头 120s → 120s', cd(120_000, 'HTTP 429: {}') === 120_000);
  check('头与体都有 → 头赢（体不参与）', cd(120_000, 'HTTP 429: {"resets_in_seconds":9999}') === 120_000);

  /* ③ 没有头时，体里的 reset 顶上来 */
  check('体 resets_in_seconds=1800 → 1800s', near(cd(undefined, 'HTTP 429: {"resets_in_seconds":1800}'), 1_800_000));
  check('体 resets_at 2h 后 → 7200s', near(cd(undefined, 'HTTP 429: {"resets_at":"' + iso(NOW + 2 * H) + '"}'), 2 * H));

  /* ④ 硬上限：上游说 99 小时也不许超过 hardMaxMs（6 小时） */
  const capped = cd(undefined, 'HTTP 429: {"resets_in_seconds":356400}');
  check('上游说 99h → 被 hardMaxMs 钳到 6h（坏上游钉不住我们）', capped === COOLDOWN.hardMaxMs, { capped: secs(capped) });
  const cappedHdr = cd(999 * H, 'HTTP 429: {}');
  check('Retry-After 头说 999h → 同样钳到 6h', cappedHdr === COOLDOWN.hardMaxMs, { cappedHdr: secs(cappedHdr) });

  /* ⑤ 解析失败必须**退回原曲线**，不是变成 0 或 NaN（否则渠道永不解冻或立刻解冻） */
  const fallback = cd(undefined, 'HTTP 429: {"error":"too many requests"}');
  check('体里没有 reset 信息 → 退回原曲线（不是 0 / 不是 NaN）',
    fallback === COOLDOWN.rateLimitBaseMs && Number.isFinite(fallback), { fallback: secs(fallback) });
  const expired = cd(undefined, 'HTTP 429: {"resets_at":"2000-01-01T00:00:00Z"}');
  check('体里是过期时刻 → 也退回原曲线', expired === COOLDOWN.rateLimitBaseMs, { expired: secs(expired) });
}

/* ══ §5 一条都不许改：原有曲线与三种失败分类的口径 ══════════════════════════ */
console.log('\n  ── §5 现有行为回归（本次改动的边界：只加一层，不改旧口径）──');
{
  /* 曲线 base * 2^(n-1)：这条公式是 v1.10 定的，本次改动**不许碰**。
     逐格验算 n=1..4 三种分类，任何一格变了都是回归。 */
  const mk = (n) => ({ consecutiveFail: n });
  const t = (kind, n) => cooldownMsFor(mk(n), kind, undefined, '');
  const rows = [
    ['transient  n=1 → 5s',   t('transient', 1),  5_000],
    ['transient  n=2 → 10s',  t('transient', 2),  10_000],
    ['transient  n=3 → 20s',  t('transient', 3),  20_000],
    ['rate_limit n=1 → 60s',  t('rate_limit', 1), 60_000],
    ['rate_limit n=2 → 120s', t('rate_limit', 2), 120_000],
    ['credential n=1 → 300s', t('credential', 1), 300_000],
    ['credential n=2 → 600s', t('credential', 2), 600_000],
  ];
  for (const [label, got, want] of rows) check(label, got === want, { got: secs(got), want: secs(want) });

  /* 各自封顶：transient 封顶 transientMaxMs(10min)、credential 封顶 hardMaxMs(6h) */
  check('transient 封顶 10 分钟（n=20 也只到 transientMaxMs）',
    t('transient', 20) === COOLDOWN.transientMaxMs, { got: secs(t('transient', 20)) });
  check('credential 封顶 6 小时',
    t('credential', 20) === COOLDOWN.hardMaxMs, { got: secs(t('credential', 20)) });
}

/* ══ §6 接线守卫：recordFailure 真的把正文交给了冷却计算 ═════════════════════ */
console.log('\n  ── §6 接线（源码扫描：别让这层写了却没人调）──');
{
  /* 纯函数测得再好，只要 recordFailure 没把 bodyText 传下去，线上就一点效果都没有。
     这条守的正是"接上了"——它抓的是"加了函数忘了接线"这种最容易犯的错。 */
  check('recordFailure 调用 cooldownMsFor 时传了第 4 个实参（响应体）',
    /cooldownMsFor\(ch,\s*k,\s*o\.retryAfterMs,\s*o\.bodyText\s*!=\s*null\s*\?\s*o\.bodyText\s*:\s*msg,\s*o\.headers\)/.test(SRC));
  check('recordFailure 把 msg（含响应体原文）作为默认 bodyText',
    /o\.bodyText\s*!=\s*null\s*\?\s*o\.bodyText\s*:\s*msg/.test(SRC));
  check('cooldownMsFor 的签名带 bodyText / headers 两个形参',
    /function cooldownMsFor\(ch,\s*kind,\s*retryAfterMs,\s*bodyText,\s*headers\)/.test(SRC));
  check('resetMsFromBody 在 cooldownMsFor 里真被调用',
    /resetMsFromBody\(bodyText, headers\)/.test(SRC));
  check('parse 出来的时长与 Retry-After 收进同一处钳制（冷却时长只有一个真源）',
    /const told = Number\.isFinite\(ra\) && ra > 0 \? ra : resetMsFromBody\(bodyText, headers\);/.test(SRC)
    && /if \(told > 0\) return Math\.min\(COOLDOWN\.hardMaxMs, Math\.max\(1000, told\)\);/.test(SRC));
}

console.log('\n' + '─'.repeat(58));
console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
process.exitCode = fail ? 1 : 0;
