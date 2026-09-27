#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/auto-weight.test.js — 自动权重（静默观测版）单元回归（零依赖）
 *
 * 从 server.js 现抠真实实现跑断言（不复制粘贴逻辑，改坏了这里就会红）：
 *   AUTO_W / AUTO_STATE / normAutoWeight / pureCandidatesFor / capShares /
 *   autoRawFor / autoWeightObserve
 *
 * 这一版**只算不生效**，所以本文件守两类东西：
 *   1) 算法本身：样本不足不动、失败率是主力信号、速度只温和惩罚且给地板、
 *      低频 + 指数平滑 + 死区抗振荡、份额归一化与单渠道封顶；
 *   2) **静默不变式**（最重要）：观测跑一百遍也不许动 SWRR_* 状态、不许改 ch.def.weight、
 *      不许让 pickWeighted 选出不一样的结果——否则"看一眼"就把分流改了。
 *
 * 跑法：node test/auto-weight.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/* ── 从源码抽函数/声明（大括号配对；沿用其它测试的抽法）── */
function extract(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
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
function extractDecl(decl) {
  const m = new RegExp('^(?:const|let)\\s+' + decl + '\\s*=.*$', 'm').exec(SRC);
  if (!m) throw new Error('找不到声明: ' + decl);
  return m[0];
}

/* 沙箱：把观测那一套和它依赖的 SWRR 一起抠出来，依赖（channels/aggregateModels/ensureUsage）由测试注入 */
const code = [
  extractDecl('SWRR_CUR'), extractDecl('SWRR_HITS'), extractDecl('SWRR_TOTAL'),
  extractDecl('AUTO_W'), extractDecl('AUTO_STATE'), extractDecl('AUTO_LAST_AT'),
  extract('normAutoWeight'), extract('capShares'), extract('pureCandidatesFor'),
  extract('autoRawFor'), extract('autoWeightObserve'),
  extract('pickWeighted'), extract('weightedStats'),
].join('\n');

const sandbox = new Function('channels', 'aggregateModels', 'ensureUsage', code + `
  return { AUTO_W, AUTO_STATE, normAutoWeight, capShares, pureCandidatesFor, autoRawFor,
           autoWeightObserve, pickWeighted, weightedStats, SWRR_CUR, SWRR_HITS,
           get total(){ return SWRR_TOTAL; } };`);

/* 假渠道：字段名/结构对齐真实 channels 里的 ch（def + aliasMap + models + 健康状态） */
const chan = (id, o = {}) => ({
  def: { id, weight: o.weight ? o.weight : undefined, enabled: o.enabled !== false, autoAlias: o.autoAlias !== false },
  models: o.models || [],
  aliasMap: new Map(Object.entries(o.aliases || {})),
  status: o.status || 'ok',
  cooldownUntil: o.cooldownUntil || 0,
  roll: o.roll || undefined,
  latEwma: o.latEwma == null ? undefined : o.latEwma,
});

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra) : '')); }
};

/* 每节用一套干净的世界：channels / usage / SWRR 状态全重置 */
function world(chs, byModel = {}, opts = {}) {
  const channels = new Map(chs.map((c) => [c.def.id, c]));
  const lib = sandbox(channels, () => Object.keys(opts.models || {}), () => ({ byModel }));
  Object.assign(lib.AUTO_W, lib.normAutoWeight(opts.autoWeight || {}));
  lib.SWRR_CUR.clear(); lib.SWRR_HITS.clear();
  return lib;
}
const sum = (arr) => Math.round(arr.reduce((s, v) => s + v, 0) * 10) / 10;

/* ══════════════════════════ 0. 装配守卫 ══════════════════════════ */
console.log('\n0. 装配守卫（源码里必须真的是这套接线）');
{
  check('server.js 定义了 autoWeightObserve', /function\s+autoWeightObserve\s*\(/.test(SRC));
  check('channelStatusAll 真的调用了观测（否则控制台拿不到数据）',
    /function\s+channelStatusAll\s*\([\s\S]{0,400}?autoWeightObserve\(\)/.test(SRC));
  check('★ persistConfig 白名单里有 autoWeight（否则保存一次渠道就把用户调好的旋钮抹掉，同 PT29 那个坑）',
    /function\s+persistConfig\s*\([\s\S]{0,2000}?autoWeight:/.test(SRC));
  check('观测函数体里**不出现** SWRR_（静默的结构性证据：它根本没资格影响分流）',
    !/SWRR_/.test(extract('autoWeightObserve')), 'autoWeightObserve 里出现了 SWRR_');
  check('观测不改渠道定义（不出现 ch.def.x =）', !/\.def\.\w+\s*=/.test(extract('autoWeightObserve')));
  check('删除渠道时清掉 AUTO_STATE（同 id 重加回来不该继承旧健康分）',
    /channels\.delete\(body\.id\)[\s\S]{0,600}?AUTO_STATE\.delete\(body\.id\)/.test(SRC));
  check('recordUsage 里维护了延迟 EWMA（速度信号的来源）',
    /function\s+recordUsage[\s\S]{0,1500}?latEwma/.test(SRC));
  // 后台节拍：观测的 h 是"一拍一算"的（平滑 + 死区），触发点原来只有 /admin/api/status，
  // 等于"没人开控制台就没有观测数据"——想跑几天看趋势就必须有自己的节拍。
  check('★ 有后台观测节拍，且只在 enabled 时才建定时器（关了就不观测、不算、不占 CPU）',
    /function\s+autoWeightTick\s*\(/.test(SRC) && /if\s*\(AUTO_W\.enabled\)\s*\{[\s\S]{0,300}?setInterval\(autoWeightTick/.test(SRC));
  check('★ 节拍跑的就是观测本身，且节拍长度 = updateMs（不再有隐藏下限）',
    /setInterval\(autoWeightTick,\s*AUTO_W\.updateMs\)/.test(SRC));
  check('★ 节拍函数运行时再兜一次 enabled（配置改了不至于还在空转），且异常不外抛（观测不许影响服务）',
    /function\s+autoWeightTick\s*\(\)\s*\{[\s\S]{0,400}?if\s*\(!AUTO_W\.enabled\)\s*return;[\s\S]{0,200}?catch/.test(SRC));
  check('观测计数只由节拍累加（控制台拉 status 那一路不算，否则"ticks"证明不了节拍真的在跑）',
    (SRC.match(/AUTO_TICKS\+\+/g) || []).length === 1
    && /function\s+autoWeightTick[\s\S]{0,300}?AUTO_TICKS\+\+/.test(SRC));
  check('status 暴露 ticks（否则没法从外部看出节拍在不在跑）', /ticks:\s*AUTO_TICKS/.test(SRC));
}

/* ══════════════════════════ 1. 旋钮归一化 ══════════════════════════ */
console.log('\n1. normAutoWeight：默认值 / 钳制 / 脏输入');
{
  const lib = world([chan('a')]);
  const d = lib.normAutoWeight({});
  check('空配置 → 默认值', d.minSamples === 10 && d.floor === 0.2 && d.latencyPenalty === 0.5 &&
    d.maxShare === 70 && d.updateMs === 30000 && d.ewma === 0.5 && d.deadband === 0.1 && d.enabled === false, d);
  check('★ enabled 默认 false（老配置零影响：不开就一行都不动）', lib.normAutoWeight(undefined).enabled === false);

  const lo = lib.normAutoWeight({ floor: -1, latencyPenalty: -3, ewma: -5, minSamples: -1, maxShare: 0, updateMs: 1, deadband: -1 });
  check('下限钳制（floor 0 / penalty 0 / ewma 0.05 / minSamples 1 / maxShare 1 / updateMs 1000 / deadband 0）',
    lo.floor === 0 && lo.latencyPenalty === 0 && lo.ewma === 0.05 && lo.minSamples === 1 &&
    lo.maxShare === 1 && lo.updateMs === 1000 && lo.deadband === 0, lo);
  const hi = lib.normAutoWeight({ floor: 9, latencyPenalty: 9, ewma: 9, minSamples: 99999, maxShare: 999, updateMs: 9e9, deadband: 9 });
  check('上限钳制（floor 1 / penalty 1 / ewma 1 / maxShare 100 / updateMs 3600000 / deadband 1）',
    hi.floor === 1 && hi.latencyPenalty === 1 && hi.ewma === 1 && hi.maxShare === 100 &&
    hi.updateMs === 3600000 && hi.deadband === 1, hi);
  check('enabled 只认严格布尔 true（字符串 "true" 不算，避免配置里写错就悄悄生效）',
    lib.normAutoWeight({ enabled: 'true' }).enabled === false && lib.normAutoWeight({ enabled: true }).enabled === true);
  check('脏输入（null / 字符串 / 数字）→ 全默认，不抛错',
    lib.normAutoWeight(null).maxShare === 70 && lib.normAutoWeight('x').maxShare === 70 && lib.normAutoWeight(7).floor === 0.2);
}

/* ══════════════════════════ 2. 份额封顶 ══════════════════════════ */
console.log('\n2. capShares：按权重归一化 + 只封自动份额（手填权重永不封顶）');
{
  const lib = world([chan('a')]);
  const s = (ws, cap) => lib.capShares(ws.map((w) => ({ w })), cap);
  const sm = (ws, cap) => lib.capShares(ws.map((w) => ({ w, manual: true })), cap);
  check('2:1:1 → 50 / 25 / 25', JSON.stringify(s([2, 1, 1], 100)) === '[50,25,25]', s([2, 1, 1], 100));
  check('3:1 且不封顶 → 75 / 25', JSON.stringify(s([3, 1], 100)) === '[75,25]', s([3, 1], 100));
  check('★ 同一个 3:1，上限 70 时自动份额被压到 70 / 30', JSON.stringify(s([3, 1], 70)) === '[70,30]', s([3, 1], 70));
  check('★ 但用户手填的 3:1 在上限 70 下仍按 75 / 25 走（手工权重是硬意图，护栏不该反过来压它）',
    JSON.stringify(sm([3, 1], 70)) === '[75,25]', sm([3, 1], 70));
  check('混搭：手填的那家不封顶，自动的那家按剩余空间分配',
    JSON.stringify(lib.capShares([{ w: 9, manual: true }, { w: 1 }], 70)) === '[90,10]',
    lib.capShares([{ w: 9, manual: true }, { w: 1 }], 70));
  check('只有一个候选 → 100（不封顶：只有一个提供方时它就是 100%，谈不上抢份额）',
    JSON.stringify(s([1], 70)) === '[100]', s([1], 70));
  check('9:1 且上限 70 → 70 / 30（多出来的按比例让给别人）',
    JSON.stringify(s([9, 1], 70)) === '[70,30]', s([9, 1], 70));
  check('100:1:1 且上限 70 → 70 / 15 / 15（被顶住的那个固定 70，剩下的平分）',
    JSON.stringify(s([100, 1, 1], 70)) === '[70,15,15]', s([100, 1, 1], 70));
  check('全 0 权重 → 全 0（不产生 NaN/Infinity）',
    JSON.stringify(s([0, 0], 70)) === '[0,0]', s([0, 0], 70));
  check('总和恒为 100（四舍五入后不漂）', sum(s([7, 5, 3, 2], 70)) === 100, s([7, 5, 3, 2], 70));
  check('上限调到 100 = 不封顶', JSON.stringify(s([9, 1], 100)) === '[90,10]', s([9, 1], 100));
  check('★ 数学上不可能（上限 1 × 2 个候选 < 100）时退化成平均分，不留下不收敛的循环',
    JSON.stringify(s([9, 1], 1)) === '[50,50]', s([9, 1], 1));
}

/* ══════════════════════════ 3. 健康系数 ══════════════════════════ */
console.log('\n3. 健康系数：样本不足不动 / 失败率是主力 / 速度温和惩罚 + 地板 / 死区平滑');
{
  /* 3.1 样本不足 → h = 1（新渠道不被噪声打死） */
  {
    const l = world([chan('a', { roll: { w: 3, f: 2 } })]);
    l.autoWeightObserve();
    const st = l.AUTO_STATE.get('a');
    check('样本 < minSamples(10) → failRate = null（判定为"还看不清"）', st.failRate === null && st.samples === 5, st);
    check('★ 样本不足时 h 保持 1（不动它：新渠道不被随机噪声打死）', st.h === 1, st);
  }

  /* 3.2 失败率是主力信号 */
  {
    const l = world([chan('a', { roll: { w: 5, f: 5 } })]); // 10 样本 50% 失败
    l.autoWeightObserve();
    const st = l.AUTO_STATE.get('a');
    check('50% 失败率 → h ≈ 0.5', Math.abs(st.h - 0.5) < 0.001, st);
    const l2 = world([chan('a', { roll: { w: 1, f: 19 } })]); // 95% 失败
    l2.autoWeightObserve();
    check('★ 95% 失败率 → 撞地板而不是 0（地板默认 0.2）', l2.AUTO_STATE.get('a').h === 0.2, l2.AUTO_STATE.get('a'));
    const l3 = world([chan('a', { roll: { w: 1, f: 19 } })], {}, { autoWeight: { floor: 0 } });
    l3.autoWeightObserve();
    check('地板可配成 0（想更狠的人自己调）', l3.AUTO_STATE.get('a').h < 0.1, l3.AUTO_STATE.get('a'));
  }

  /* 3.3 速度：温和惩罚 + 没有数据不扣分 */
  {
    const mk = (latA, latB, autoWeight) => {
      const l = world([chan('a', { latEwma: latA, roll: { w: 20, f: 0 } }), chan('b', { latEwma: latB, roll: { w: 20, f: 0 } })], {}, { autoWeight });
      l.autoWeightObserve();
      return { a: l.AUTO_STATE.get('a'), b: l.AUTO_STATE.get('b') };
    };
    const r1 = mk(100, 200);
    check('★ 2× 慢只温和打折（penalty 0.5 → h = 0.75，不是 0.5）', Math.abs(r1.b.h - 0.75) < 0.001, r1.b.h);
    check('最快的那家 h 保持 1', r1.a.h === 1 && r1.a.speedRatio === 1, r1.a);
    check('记录速度比（2× 慢 → speedRatio 2）', r1.b.speedRatio === 2, r1.b);
    const r2 = mk(100, 1000, { latencyPenalty: 0 });
    check('penalty 设 0 → 完全不看速度（10× 慢也是 h = 1）', r2.b.h === 1, r2.b);
    const r3 = mk(100, null);
    check('没有延迟数据 → 不因速度扣分（speedRatio null、h = 1）',
      r3.b.h === 1 && r3.b.speedRatio === null, r3.b);
  }

  /* 3.4 低频缓存：间隔内不重算 */
  {
    const ch = chan('a', { roll: { w: 20, f: 0 } });
    const l = world([ch]);
    l.autoWeightObserve();
    const h1 = l.AUTO_STATE.get('a').h;
    ch.roll = { w: 0, f: 20 };              // 渠道突然全失败
    l.autoWeightObserve();
    check('★ updateMs 内不重算（低频是抗振荡的第一道闸）', l.AUTO_STATE.get('a').failRate === 0, l.AUTO_STATE.get('a'));
    l.AUTO_W.updateMs = 0;                   // 放开间隔（真实配置最小 1000ms，这里为测试直接置 0）
    l.AUTO_STATE.get('a').at = 0;
    l.autoWeightObserve();
    const after = l.AUTO_STATE.get('a');
    check('过了间隔就采用新数据（failRate 变 1）', after.failRate === 1, after);
    check('★ 但不会一步跳到底：先按 ewma 推一半（1 → 0.6），要连续观测才收敛到地板',
      after.h > 0.2 && after.h < h1, { h1, after: after.h });
    for (let i = 0; i < 60; i++) { l.AUTO_STATE.get('a').at = 0; l.autoWeightObserve(); }
    check('★ 持续坏下去最终停在**地板附近**（不会一路归零把渠道饿死）；'
      + '停在 0.2~0.3 之间而不是精确 0.2，是死区在收尾时把最后一点点变化冻住了——这正是设计意图',
      l.AUTO_STATE.get('a').h >= 0.2 && l.AUTO_STATE.get('a').h <= 0.3, l.AUTO_STATE.get('a').h);
  }

  /* 3.5 死区 + 指数平滑 */
  {
    const ch = chan('a', { roll: { w: 20, f: 0 } });
    const l = world([ch]);
    l.autoWeightObserve();
    check('开局 h = 1', l.AUTO_STATE.get('a').h === 1, l.AUTO_STATE.get('a').h);

    // 手工把当前 h 摆到 0.5，再让目标值变成 0.52（48% 失败率）：只差 4% < 死区 10% → 不许动
    l.AUTO_W.updateMs = 0;
    l.AUTO_STATE.get('a').h = 0.5;
    ch.roll = { w: 13, f: 12 };              // 25 样本 / 48% 失败 → 目标 0.52
    l.autoWeightObserve();
    check('目标只差 4%（死区内）→ h 保持 0.5 不动（免得份额在噪声里抖）',
      l.AUTO_STATE.get('a').h === 0.5, { h: l.AUTO_STATE.get('a').h, failRate: l.AUTO_STATE.get('a').failRate });

    // 大幅变化（目标 0.2，差 60%）→ 按 ewma 逐步推进，不是一步跳到位
    const before = l.AUTO_STATE.get('a').h;
    ch.roll = { w: 0, f: 20 };
    l.autoWeightObserve();
    const after = l.AUTO_STATE.get('a').h;
    check('★ 大幅变化按 ewma 逐步推进（不是一步跳到位）', after !== before && after > 0.2, { before, after });
    check('推进方向正确（往坏里走）', after < before, { before, after });
  }
}

/* ══════════════════════════ 4. 静默不变式（最重要） ══════════════════════════ */
console.log('\n4. 静默不变式：观测跑再多遍也不许改分流');
{
  const chs = [chan('a', { weight: 3 }), chan('b', { weight: 1 }), chan('c', {})];
  const l = world(chs, {}, { models: { m: 1 } });
  // 先跑几轮真实选择，留下 SWRR 状态
  const list = () => chs.map((c) => ({ channelId: c.def.id, upstream: c.def.id, weight: Number(c.def.weight) > 0 ? Number(c.def.weight) : 0, status: c.status, cooldownUntil: 0 }));
  const picks = [];
  for (let i = 0; i < 8; i++) picks.push(l.pickWeighted(list()));
  const snap = () => JSON.stringify({
    total: l.total, cur: [...l.SWRR_CUR.entries()].sort(), hits: [...l.SWRR_HITS.entries()].sort(), w: chs.map((c) => c.def.weight),
  });
  const before = snap();
  for (let i = 0; i < 100; i++) l.autoWeightObserve();
  check('★ 观测 100 遍后 SWRR_* 状态逐字节不变（选中的渠道不会因此改变）', snap() === before, { before, after: snap() });
  const picks2 = [];
  for (let i = 0; i < 8; i++) picks2.push(l.pickWeighted(list()));
  check('★ 观测前后 pickWeighted 的落点序列完全一致', JSON.stringify(picks) === JSON.stringify(picks2), { picks, picks2 });
  check('观测不改 ch.def.weight（手工权重仍是唯一生效的份额依据）',
    JSON.stringify(chs.map((c) => c.def.weight ?? 0)) === '[3,1,0]', chs.map((c) => c.def.weight ?? 0));
  check('观测不改渠道候选对象（没被就地改坏）',
    JSON.stringify(list()[0]) === JSON.stringify({ channelId: 'a', upstream: 'a', weight: 3, status: 'ok', cooldownUntil: 0 }));
}

/* ══════════════════════════ 5. 预测份额 ══════════════════════════ */
console.log('\n5. 预测份额：多候选模型才有意义 / 坏的多拿少 / 冷却的被排除');
{
  /* 5.1 两个候选、都没填权限 → 预测对半，且标注"当前未启用加权轮询" */
  {
    const chs = [chan('a', { aliases: { m: {} } }), chan('b', { aliases: { m: {} } })];
    const l = world(chs, { m: { requests: 10 } }, { models: { m: 1 } });
    const obs = l.autoWeightObserve();
    const e = obs.find((o) => o.model === 'm');
    check('多候选模型出现在观测里', !!e, obs.map((o) => o.model));
    check('两个候选各 50%', JSON.stringify(e.candidates.map((c) => c.share)) === '[50,50]', e.candidates.map((c) => c.share));
    check('★ 都没填 weight → 标 manualOff（说明"当前压根没开加权轮询"）', e.manualOff === true);
    check('nowShare 为 null（没有手工份额可对照）', e.candidates.every((c) => c.nowShare === null));
    check('基础权重回落成 1（不配置也能自动分流的关键）', e.candidates.every((c) => c.base === 1));
  }
  /* 5.2 一个健康、一个 50% 失败 → 健康的拿更多 */
  {
    const chs = [
      chan('good', { aliases: { m: {} }, roll: { w: 20, f: 0 } }),
      chan('bad', { aliases: { m: {} }, roll: { w: 10, f: 10 } }),
    ];
    const l = world(chs, { m: { requests: 5 } }, { models: { m: 1 } });
    const e = l.autoWeightObserve().find((o) => o.model === 'm');
    const good = e.candidates.find((c) => c.id === 'good'), bad = e.candidates.find((c) => c.id === 'bad');
    check('★ 健康的那家份额更高（≈67% vs ≈33%）', good.share > bad.share && Math.abs(good.share - 66.7) < 1, e.candidates.map((c) => [c.id, c.share]));
    check('份额合计 100', sum(e.candidates.map((c) => c.share)) === 100);
    check('每个候选都带可解释的原因（失败率/样本/延迟）',
      bad.failRate === 0.5 && bad.samples === 20 && 'latMs' in bad, bad);
  }
  /* 5.3 冷却中 / down 的候选不进预测（它们本来就不进池） */
  {
    const chs = [
      chan('a', { aliases: { m: {} } }),
      chan('cold', { aliases: { m: {} }, cooldownUntil: Date.now() + 60000 }),
      chan('dead', { aliases: { m: {} }, status: 'down' }),
    ];
    const l = world(chs, { m: { requests: 3 } }, { models: { m: 1 } });
    const e = l.autoWeightObserve().find((o) => o.model === 'm');
    check('★ 冷却中与 down 的候选被排除，不参与分份额',
      e.candidates.map((c) => c.id).join(',') === 'a' && e.excluded.sort().join(',') === 'cold,dead',
      { candidates: e.candidates.map((c) => c.id), excluded: e.excluded });
    check('排除后只剩一个候选 → 它 100%', e.candidates[0].share === 100, e.candidates[0]);
  }
  /* 5.4 手工权重仍然作为基础权重参与预测（对照 nowShare） */
  {
    const chs = [chan('a', { weight: 3, aliases: { m: {} } }), chan('b', { weight: 1, aliases: { m: {} } })];
    const l = world(chs, { m: { requests: 1 } }, { models: { m: 1 } });
    const e = l.autoWeightObserve().find((o) => o.model === 'm');
    check('手工 3:1 → nowShare 75 / 25（当前真实份额的对照）',
      JSON.stringify(e.candidates.map((c) => c.nowShare)) === '[75,25]', e.candidates.map((c) => c.nowShare));
    check('预测份额此时与手工一致（两边都健康）',
      JSON.stringify(e.candidates.map((c) => c.share)) === '[75,25]', e.candidates.map((c) => c.share));
  }
  /* 5.5 单候选模型不出现（一个提供方谈不上分流） */
  {
    const chs = [chan('a', { aliases: { only: {} } }), chan('b', { aliases: { m: {} } }), chan('c', { aliases: { m: {} } })];
    const l = world(chs, { only: { requests: 99 }, m: { requests: 1 } }, { models: { only: 1, m: 1 } });
    const obs = l.autoWeightObserve();
    check('★ 只有一个候选的模型不进观测（否则满屏"100%"噪音）',
      !obs.some((o) => o.model === 'only') && obs.some((o) => o.model === 'm'), obs.map((o) => o.model));
    check('多候选的排前面（按请求量）', obs[0].model === 'm', obs.map((o) => [o.model, o.requests]));
  }
}

console.log('\n──────────────────────────────────────────────────────────');
if (fail) { console.log('✗ 失败 ' + fail + ' 项 / 通过 ' + pass + ' 项'); process.exitCode = 1; }
else console.log('✓ 全部通过（' + pass + ' 项断言）');
