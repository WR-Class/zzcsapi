#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/weighted-rr.test.js — 真正的加权轮询（SWRR）单元回归（零依赖）
 *
 * 从 server.js 现抠真实实现跑断言（不复制粘贴逻辑，改坏了这里就会红）：
 *   SWRR_CUR / SWRR_HITS / SWRR_TOTAL / pickWeighted / applyWeightedPick / countWeightedHit / weightedStats
 *
 * 语义约定（要改先改这里）：
 *   · `priority`/`effPriority` = 候选链**顺序**（谁先试、谁兜底）；
 *   · `weight` = 同组内**按比例分流**（真正的加权轮询）—— 池子的门槛是候选对象的 `weight > 0`，
 *     而那个字段来自 `effWeight(ch)`：关闭自动权重时 = 手工 weight（缺省 0 = 不进池，老配置零影响）；
 *     开启后每家都是 `(手工 weight ‖ 1) × h > 0` ⇒ **全都进池**（详见 docs/scheduling.md「自动权重」）。
 *   · 选中者被提到候选链第一位，其余保持原有顺序作兜底。
 *   · ★ v1.18.76：**「选中」与「记账」是两步** —— `applyWeightedPick` 只在赢家身上打标
 *     （`weightedPicked = true`），`countWeightedHit` 才记一笔命中。拆开之前，一次真实客户端请求
 *     会调 `channelsServing` **9 次**（把各协议候选拼成一条链），于是**只有单条渠道的兜底协议
 *     （workbuddy / opencode）每请求白得 1 次命中**、份额恒 ~1/3 —— 而它一次都没被派发过
 *     （控制台「权重 / 分流」列那个 33.7% 就是这么来的）。
 *
 * 跑法：node test/weighted-rr.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/* ── 从源码抽函数（大括号配对；沿用其它测试的抽法）── */
function extract(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(|function\\s*\\*\\s*' + name + '\\s*\\(');
  const m = re.exec(SRC);
  if (!m) throw new Error('找不到函数: ' + name);
  const start = m.index;
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return SRC.slice(start, i);
}
/* ── 抽顶层 const/let 声明（SWRR_* 状态）── */
function extractDecl(decl) {
  const m = new RegExp('^(?:const|let)\\s+' + decl + '\\s*=.*$', 'm').exec(SRC);
  if (!m) throw new Error('找不到声明: ' + decl);
  return m[0];
}

const code = [
  extractDecl('SWRR_CUR'), extractDecl('SWRR_HITS'), extractDecl('SWRR_TOTAL'),
  extract('pickWeighted'), extract('applyWeightedPick'), extract('countWeightedHit'), extract('weightedStats'),
].join('\n');
const { pickWeighted, applyWeightedPick, countWeightedHit, weightedStats, SWRR_CUR, SWRR_HITS } =
  new Function(code + '\nreturn { pickWeighted, applyWeightedPick, countWeightedHit, weightedStats, SWRR_CUR, SWRR_HITS };')();

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra) : '')); }
};
const reset = () => { SWRR_CUR.clear(); SWRR_HITS.clear(); };
// 造候选：weight 缺省 = 0（模拟老配置）
const cand = (id, weight, extra = {}) => ({ channelId: id, upstream: id, priority: extra.priority ?? 0, weight, status: extra.status || 'ok', cooldownUntil: extra.cooldownUntil || 0, latencyMs: 10, consecutiveFail: 0, protocol: 'openai', kind: 'explicit' });
// 按 weight 比例跑 n 次，返回各渠道命中次数
const run = (list, n) => {
  const hits = {};
  for (let i = 0; i < n; i++) {
    const l = list.map((c) => ({ ...c }));
    applyWeightedPick(l);
    hits[l[0].channelId] = (hits[l[0].channelId] || 0) + 1;
  }
  return hits;
};

console.log('\n1. 没填 weight（老配置）→ 行为必须逐字节不变');
reset();
{
  let list = [cand('a', 0, { priority: 10 }), cand('b', 0, { priority: 5 }), cand('c', 0, { priority: 1 })];
  check('pickWeighted 返回 -1（池为空）', pickWeighted(list.map((c) => ({ ...c }))) === -1);
  const before = list.map((c) => c.channelId).join(',');
  applyWeightedPick(list);
  check('候选顺序原样不动（老排序结果就是最终结果）', list.map((c) => c.channelId).join(',') === before, list.map((c) => c.channelId));
  const hits = run(list, 30);
  check('★ 对照：老行为永远是第一个渠道吃满（100/0）', hits.a === 30 && !hits.b && !hits.c, hits);
  check('没有 weight 时不写任何统计', weightedStats().total === 0, weightedStats());
}

console.log('\n2. ★ 3:1 两个渠道 → 长期分流 ≈75%/25%（平滑加权轮询）');
reset();
{
  const list = [cand('heavy', 3), cand('light', 1)];
  const hits = run(list, 400);
  const share = (hits.heavy || 0) / 400;
  check('重的占 75% ±3%', Math.abs(share - 0.75) <= 0.03, hits);
  check('轻的占 25% ±3%', Math.abs((hits.light || 0) / 400 - 0.25) <= 0.03, hits);
  check('两边都被用到（不是全压一个）', hits.heavy > 0 && hits.light > 0, hits);
}

console.log('\n3. ★ 平滑性：3:1 不允许"扎堆突发"');
reset();
{
  const list = [cand('heavy', 3), cand('light', 1)];
  let seq = [], maxRun = 0, run_ = 0;
  for (let i = 0; i < 40; i++) {
    const l = list.map((c) => ({ ...c }));
    applyWeightedPick(l);
    seq.push(l[0].channelId);
    run_ = l[0].channelId === 'heavy' ? run_ + 1 : 0;
    maxRun = Math.max(maxRun, run_);
  }
  check('重的连续命中不超过 weight(3) 次（真随机大权重会连击）', maxRun <= 3, { maxRun, seq: seq.slice(0, 12) });
  check('交替出现（不是先 30 次重的再 10 次轻的）', seq.slice(0, 4).includes('light'), seq.slice(0, 8));
}

console.log('\n4. 2:1:1 三渠道 → 50/25/25');
reset();
{
  const hits = run([cand('x', 2), cand('y', 1), cand('z', 1)], 400);
  const ok = Math.abs((hits.x || 0) / 400 - 0.5) <= 0.03 && Math.abs((hits.y || 0) / 400 - 0.25) <= 0.03 && Math.abs((hits.z || 0) / 400 - 0.25) <= 0.03;
  check('50/25/25 ±3%', ok, hits);
}

console.log('\n5. 冷却 / down / weight=0 的渠道一律不进池');
reset();
{
  const list = [cand('cooling', 5, { cooldownUntil: Date.now() + 60000 }), cand('down', 5, { status: 'down' }), cand('zero', 0), cand('healthy', 1)];
  const hits = run(list, 20);
  check('冷却渠道没被选中', !hits.cooling, hits);
  check('down 渠道没被选中', !hits.down, hits);
  check('weight=0 没被选中', !hits.zero, hits);
  check('健康成员吸收全部流量', hits.healthy === 20, hits);
  // 选中者被提到第一位，其余顺序保持（冷却的仍在后面做兜底）
  reset();
  let l = [cand('cooling', 5, { cooldownUntil: Date.now() + 60000 }), cand('healthy', 1)];
  applyWeightedPick(l);
  check('选中者提到第一位、兜底链顺序不乱', l.map((c) => c.channelId).join(',') === 'healthy,cooling', l.map((c) => c.channelId));
}

console.log('\n6. 单成员池 / 边界');
reset();
{
  let l = [cand('only', 1)];
  applyWeightedPick(l);
  check('单成员池顺序不变', l[0].channelId === 'only');
  const hits = run([cand('only', 1)], 5);
  check('单成员池不会产生偏移/异常', hits.only === 5, hits);
  reset();
  l = [cand('a', 1), cand('b', 1)];
  applyWeightedPick(l);
  const first = l[0].channelId;
  check('等权两渠道也有分流（不再永远是配置里的第一个）', first === 'a' || first === 'b', first);
}

console.log('\n7. 与 priority 的关系：轮询只决定"谁是第一位"，不改兜底链');
reset();
{
  const list = [cand('p10', 1, { priority: 10 }), cand('p5', 3, { priority: 5 }), cand('p1', 0, { priority: 1 })];
  let l = list.map((c) => ({ ...c }));
  applyWeightedPick(l);
  check('第一位来自轮询池（不是 priority 最高的 p10）', l[0].channelId !== 'p10', l.map((c) => c.channelId));
  check('未填 weight 的 p1 仍在链上兜底', l.some((c) => c.channelId === 'p1'), l.map((c) => c.channelId));
  check('所有候选都保留（不丢兜底渠道）', l.length === 3, l.length);
}

console.log('\n8. 统计可观测（/admin/api/status 的 weightedShare 来源）+ 记账只发生在真实派发');
reset();
{
  // ★ v1.18.76：第 1 段先证明"只选中不派发 = 一次都不记" —— 这是本次修复的核心判别量。
  const beforeMark = weightedStats().total;
  run([cand('a', 3), cand('b', 1)], 40);            // run 内部只调 applyWeightedPick
  check('★ 只"选中"不"派发"时一次都不记账（选中与记账已拆开）',
    weightedStats().total - beforeMark === 0, { total: weightedStats().total, beforeMark });

  // 第 2 段：模拟"真实派发"—— 每条候选链只给链首记一次（= server.js 三个链构造处的做法）
  const before = weightedStats().total;
  const marks = { picked: 0, unpicked: 0 };
  for (let i = 0; i < 40; i++) {
    const l = [cand('a', 3), cand('b', 1)].map((c) => ({ ...c }));
    applyWeightedPick(l);
    if (l[0].weightedPicked === true) marks.picked++;
    if (countWeightedHit(l[0])) marks.unpicked += 0; else marks.unpicked++;
  }
  const s = weightedStats();
  check('40 次派发 = 40 次命中（不多不少）', s.total - before === 40, { delta: s.total - before });
  check('每个链首都带着打标（weightedPicked），一次都没漏', marks.picked === 40, marks);
  check('★ 打标的必被记账、没打标的必被拒', marks.unpicked === 0, marks);
  check('每渠道命中数正确', s.channels.a.hits === 30 && s.channels.b.hits === 10, s.channels);
  check('两渠道命中比 ≈ 3:1', s.channels.a.hits / s.channels.b.hits === 3, s.channels);
  check('share = 该渠道命中 ÷ 全部命中（跨模型合计），字段是数字',
    s.channels.a.share === 75 && s.channels.b.share === 25, s.channels);
  check('★ 没打标的候选单独送进去也不记（兜底层那种"被枚举到"的候选污染不了份额）',
    countWeightedHit({ channelId: 'never' }) === false && !weightedStats().channels.never, weightedStats().channels);
  check('传 undefined / null 不炸也不记', countWeightedHit(undefined) === false && countWeightedHit(null) === false);
}

console.log('\n9. 装配守卫（改 server.js 时这些必须一起改）');
{
  // 结构判据（别用"两个 token 之间不超过 N 个字符"那种写法：server.js 在中间补几行注释就会假报警，
  // v1.10 加熔断分层注释时就踩过一次）。这里取 channelsServing 的函数体，只断言"先排序、后加权挑首位"。
  const csBody = (() => {
    const i = SRC.indexOf('function channelsServing');
    if (i < 0) return '';
    const end = SRC.indexOf('\n}', i);
    return end < 0 ? SRC.slice(i) : SRC.slice(i, end);
  })();
  check('channelsServing 末尾调用了 applyWeightedPick',
    /out\.sort\(/.test(csBody) && /return applyWeightedPick\(out\);/.test(csBody)
    && csBody.indexOf('out.sort(') < csBody.indexOf('return applyWeightedPick(out);'));
  check('三处候选对象都写了 weight 字段（v1.18.63 起经 effWeight：关闭时它原样返回手工权重，逐字节回旧行为）', (SRC.match(/weight: effWeight\(ch\)/g) || []).length >= 3 && /function effWeight\(ch\)/.test(SRC), (SRC.match(/weight: effWeight\(ch\)/g) || []).length);
  check('persistConfig 持久化 weight（否则控制台保存会抹掉权重）', /persistConfig[\s\S]{0,1900}?weight: ch\.def\.weight \?\? undefined/.test(SRC));
  check('upsert 未传 weight 时保留旧值', /prevDef[\s\S]{0,400}?body\.weight !== undefined/.test(SRC));
  check('validateChannelDef 校验 weight', /weight must be a finite number/.test(SRC));
  check('status 暴露 weightedHits / weightedShare', /weightedHits: wstats\.channels/.test(SRC) && /weightedShare: wstats\.channels/.test(SRC));
  /* ★ v1.18.76：三条纪律的结构性守卫（行为回归在 e2e，这里防"哪天又改回去"） */
  check('pickWeighted 自己不再写命中统计（记账已挪出该函数）',
    !/SWRR_HITS\.set\(/.test(extract('pickWeighted')) && !/SWRR_TOTAL\+\+/.test(extract('pickWeighted')));
  check('applyWeightedPick 打标而不是记账',
    /list\[0\]\.weightedPicked = true;/.test(extract('applyWeightedPick'))
    && !/SWRR_HITS\.set\(/.test(extract('applyWeightedPick')));
  check('countWeightedHit 只认真打了标的候选（没打标一律拒）',
    /cand\.weightedPicked !== true\) return false;/.test(extract('countWeightedHit')));
  check('channelsServing 有纯枚举分支（pure 时直接 return out：不推 SWRR、不选链首、不记账）',
    /if \(opts && opts\.pure\) return out;/.test(csBody));
  check('★ 三条客户端候选链各记一次命中（只给"第一个有候选的池"）',
    (SRC.match(/\n\s*countWeightedHit\(/g) || []).length === 3,
    (SRC.match(/\n\s*countWeightedHit\(/g) || []).length);
  check('管理面「手动测试」走纯枚举（点一次测试不再污染份额统计）',
    /channelsServing\(model, p, \{ pure: true \}\)/.test(SRC));
  check('anthropic / gemini 链不再把同一协议池查两遍（原写法空池分支会 pick 两次 → SWRR 多推一格）',
    (SRC.match(/const nativePool = channelsServing\(/g) || []).length === 2);
}

console.log('\n' + '─'.repeat(58));
console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
process.exit(fail ? 1 : 0);
