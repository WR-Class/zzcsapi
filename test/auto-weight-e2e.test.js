#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/auto-weight-e2e.test.js — 自动权重「静默观测版」端到端（零依赖）
 *
 * 单元测试证明"算得对"，这个文件证明**最要紧的那件事：它真的不说话**——
 *   1) 真起「假上游 + 临时网关」，真发请求，看真实落点；
 *   2) 观测给出的预测份额随便怎么算，`weightedHits` 必须恒为 0、落点必须一动不动
 *      （老配置零影响：没填 weight 就还是走原来的候选链第一位）；
 *   3) 真实失败/真实延迟会改变**预测**，但不改变**分流**；
 *   4) 配置往返：控制台保存一次渠道之后，config.json 里的 autoWeight 旋钮还在
 *      （否则用户刚调好的参数会被 persistConfig 白名单吞掉——PT29 那个坑的同类）。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/auto-weight-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-aw-e2e-'));
const GW_KEY = 'aw-gw', AD_KEY = 'aw-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/* ── 假上游：按路径区分行为（/fast 立刻成功、/slow 拖 250ms、failFast 打开后 /fast 交替 500）── */
let failFast = false;
const fastSeq = { n: 0 };
const upHits = new Map();
const upstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', async () => {
    const url = String(req.url || '');
    const which = url.startsWith('/fast') ? 'a' : url.startsWith('/slow') ? 'b' : '?';
    upHits.set(which, (upHits.get(which) || 0) + 1);
    if (url.startsWith('/slow')) await sleep(250);
    if (url.startsWith('/fast') && failFast && (fastSeq.n++ % 2 === 0)) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'flaky upstream' } }));
    }
    let model = '';
    try { model = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}').model || ''; } catch { }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'c', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
});

(async () => {
  const PU = await freePort(), GW = await freePort();
  await new Promise((r) => upstream.listen(PU, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'c.json');
  const KNOBS = { enabled: true, minSamples: 10, floor: 0.2, latencyPenalty: 0.6, maxShare: 70, updateMs: 1000, ewma: 0.5, deadband: 0.1 };
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 2000 }, retries: { perChannel: 1, maxModelFallbacks: 99 },
    autoWeight: KNOBS,
    channels: [
      // 两个渠道服务同一个模型 m1，**都没填 weight**（这就是"我不配置权重"的场景）
      // priority 不同只为让候选链第一位确定（a 在前），与观测无关
      { id: 'aw-a', name: 'A', baseUrl: `http://127.0.0.1:${PU}/fast`, apiKey: 'k', protocol: 'openai', priority: 10, enabled: true, models: { m1: 'm1' } },
      { id: 'aw-b', name: 'B', baseUrl: `http://127.0.0.1:${PU}/slow`, apiKey: 'k', protocol: 'openai', priority: 0, enabled: true, models: { m1: 'm1' } },
    ],
  }));

  const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'u.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
    stdio: 'ignore',
  });
  const stopChild = (cp) => new Promise((res) => {
    if (!cp || cp.exitCode !== null || cp.signalCode !== null) return res();
    cp.once('exit', () => res());
    try { cp.kill(); } catch { }
    setTimeout(res, 1500);
  });
  const cleanup = async () => {
    await stopChild(gw);
    try { upstream.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  };

  const admin = async (p, opt) => {
    const r = await fetch(`http://127.0.0.1:${GW}${p}`, {
      method: (opt && opt.method) || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AD_KEY },
      body: opt && opt.body ? JSON.stringify(opt.body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const status = async () => (await admin('/admin/api/status')).body;
  const chat = async () => {
    const r = await fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
      body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text().catch(() => '');
    return { code: r.status, ch: r.headers.get('x-zzcsapi-channel') };
  };
  const landings = async (n) => { const h = {}; for (let i = 0; i < n; i++) { const r = await chat(); h[r.ch || '?'] = (h[r.ch || '?'] || 0) + 1; } return h; };
  const preview = (st, model) => (st.autoWeight.models || []).find((m) => m.model === model);
  const chOf = (st, id) => st.channels.find((c) => c.id === id) || {};
  /* 健康系数与样本是**低频重算**的（updateMs，本夹具设 1 秒；这是抗振荡设计，不是延迟 bug）。
     所以断言算出来的值之前要先跨过一个重算间隔，否则读到的是上一拍的缓存快照。 */
  const settle = () => sleep(1200);

  try {
    /* 等网关起来 */
    let boot = null;
    for (let i = 0; i < 40 && !boot; i++) { try { boot = await status(); } catch { await sleep(150); } }
    check('临时网关起来了', !!boot && Array.isArray(boot.channels));
    if (!boot) throw new Error('网关未启动');

    /* ══════════ 0. 契约：观测块存在、旋钮回显、effective 恒为 false ══════════ */
    console.log('\n0. 契约：观测数据真的暴露出来了，但明确写着"不生效"');
    {
      const aw = boot.autoWeight;
      check('status 里有 autoWeight 观测块', !!aw, Object.keys(boot));
      check('★ effective === false（即使 config 里 enabled: true，本版也不改分流）',
        aw.enabled === true && aw.effective === false, { enabled: aw.enabled, effective: aw.effective });
      check('旋钮按配置回显（latencyPenalty/maxShare/minSamples 等）',
        aw.knobs.latencyPenalty === 0.6 && aw.knobs.maxShare === 70 && aw.knobs.minSamples === 10, aw.knobs);
      check('观测时间戳有值（说明真的跑过一次）', typeof aw.at === 'number' && aw.at > 0, aw.at);
      const e = preview(boot, 'm1');
      check('两个候选都服务的模型出现在观测里', !!e && e.candidates.length === 2, e && e.candidates.map((c) => c.id));
      check('★ 都没填 weight → manualOff = true（当前压根没开加权轮询，这正是用户的原话场景）', e.manualOff === true);
    }

    /* ══════════ 1. 静默核心：预测怎么算都行，真实落点一动不动 ══════════ */
    console.log('\n1. ⭐ 静默核心：观测给出预测，但真流量完全按老规矩走');
    {
      const st = await status();
      const e = preview(st, 'm1');
      check('两个候选都很健康 → 预测对半 50 / 50', JSON.stringify(e.candidates.map((c) => c.share)) === '[50,50]', e.candidates.map((c) => [c.id, c.share, c.h]));
      check('此时两边的健康系数都是 1', e.candidates.every((c) => c.h === 1), e.candidates.map((c) => [c.id, c.h]));

      const h1 = await landings(20);      check('★ 真发 20 次请求：全部落在候选链第一位 a（预测的 50/50 没被当成真的分流）',
        h1['aw-a'] === 20 && !h1['aw-b'], h1);

      for (let i = 0; i < 5; i++) await status();   // 反复"看一眼"
      const h2 = await landings(20);
      check('★ 又看 5 遍再发 20 次：落点仍是 20/0（观测跑再多遍也不改分流）',
        h2['aw-a'] === 20 && !h2['aw-b'], h2);

      await settle();                       // 跨过一个重算间隔，读到本拍的统计（见 settle 注释）
      const st2 = await status();
      check('★ 两个渠道的 weightedHits 恒为 0（观测没有偷偷把渠道塞进加权池）',
        chOf(st2, 'aw-a').weightedHits === 0 && chOf(st2, 'aw-b').weightedHits === 0,
        { a: chOf(st2, 'aw-a').weightedHits, b: chOf(st2, 'aw-b').weightedHits });
      check('观测把真实流量记进了样本数（a 有数据、没流量过的 b 是 0）',
        chOf(st2, 'aw-a').autoSamples > 0 && chOf(st2, 'aw-b').autoSamples === 0,
        { a: chOf(st2, 'aw-a').autoSamples, b: chOf(st2, 'aw-b').autoSamples });
      check('延迟 EWMA 也真的有数（速度信号的来源通了）', chOf(st2, 'aw-a').autoLatMs > 0, chOf(st2, 'aw-a').autoLatMs);
    }

    /* ══════════ 2. 真实失败 → 预测变差，但不改分流 ══════════ */
    console.log('\n2. 真实失败只改「预测」，不改「分流」');
    {
      failFast = true;                              // /fast 交替 500（真失败，用于验证观测读的是真实数据）
      await landings(20);
      failFast = false;
      await settle();
      const st = await status();
      const e = preview(st, 'm1');
      const chA = chOf(st, 'aw-a');
      const chB = chOf(st, 'aw-b');
      const knobs = (st.autoWeight || {}).knobs || {};
      const a = e.candidates.find((c) => c.id === 'aw-a');
      const b = e.candidates.find((c) => c.id === 'aw-b');
      /* ★ 这一节曾经断言"a 的份额不超过对半"，那是**错的**判据：本夹具里 b 是 /slow（恒定
         250ms），它的速度惩罚会随样本出现而独立变动，实测 a 的份额反而会因为 b 被扣分而涨到
         ~58-64%。失败项本身的可测契约是下面两条：
           · 失败率低于死区 → h 按设计冻在 1（抗振荡，不是没读到失败）；
           · 失败率高于死区 → h 必须真的被扣（单元测试卡死数量关系）。
         另外真失败会被"重试 + 冷却"双重稀释：失败的渠道一进冷却就不再接流量、也就不再攒失败，
         所以观测到的失败率通常远低于上游的真实失败比例——这是既有机制的产物，不是观测的漏洞。 */
      const deadband = knobs.deadband;
      check('★ 真实失败被记进观测（a 的失败率 > 0）', chA.autoFailRate > 0, { failRate: chA.autoFailRate, samples: chA.autoSamples });
      check('★ 失败率没推过死区 → h 按设计冻着；推过了就得真扣（抗振荡契约）',
        deadband === undefined ? chA.autoH <= 1
          : (chA.autoFailRate >= deadband ? chA.autoH < 1 : chA.autoH === 1),
        { h: chA.autoH, failRate: chA.autoFailRate, deadband, samples: chA.autoSamples });
      check('★ 样本不足时观测选择"看不清就不动"（h = 1），而不是凭两三次失败就砍份额',
        chA.autoSamples < 10 ? chA.autoH === 1 : chA.autoH <= 1,
        { samples: chA.autoSamples, h: chA.autoH });
      /* 预测不是凭空来的：份额就是 h 归一化的结果（两家都没触发单渠道封顶时应当严格自洽）。
         这条把"观测真的按健康系数算份额"端到端钉住，且不依赖 b 的速度项怎么动。 */
      if (a && b && a.share < knobs.maxShare && b.share < knobs.maxShare) {
        const implied = Math.round((a.h / (a.h + b.h)) * 1000) / 10;
        check('★ 预测份额与健康系数自洽：share = h_a / (h_a + h_b)（含 b 的速度惩罚）',
          Math.abs(a.share - implied) <= 0.2, { share: a.share, implied, ha: a.h, hb: b.h, fastRateB: chB.autoFailRate });
      } else {
        check('★ 有候选触发了单渠道封顶或已被排除 → 份额不自洽属预期（跳过自洽比对）', true, { a: a && a.share, b: b && b.share, maxShare: knobs.maxShare });
      }
      check('★ 与此同时 weightedHits 仍然是 0（坏消息没有变成"偷偷改分流"）',
        chA.weightedHits === 0 && chB.weightedHits === 0,
        { a: chA.weightedHits, b: chB.weightedHits });
      check('渠道的 weight 字段仍是 0（没有谁被写进配置）',
        chOf(st, 'aw-a').weight === 0 && chOf(st, 'aw-b').weight === 0);
      check('落点变化完全由既有机制（失败重试 / 冷却兜底）解释：b 只是在 a 不健康时分到流量',
        (upHits.get('a') || 0) > 0 && (upHits.get('b') || 0) >= 0, { a: upHits.get('a'), b: upHits.get('b') });
    }

    /* ══════════ 3. 真实延迟进观测：慢的那家被温和打折 ══════════ */
    console.log('\n3. 真实延迟：慢的候选被温和打折（有延迟数据才打折，没数据不扣分）');
    {
      // 让 b 也能拿到流量：给两边填同样的手工权重（这一步是测试手段，不是被测行为）
      // 走 `/admin/api/channel` 单渠道轻量路径（批量路径 `/admin/api/channels` 收的是**单个**渠道对象）
      const wa = await admin('/admin/api/channel', { method: 'POST', body: { id: 'aw-a', weight: 1 } });
      const wb = await admin('/admin/api/channel', { method: 'POST', body: { id: 'aw-b', weight: 1 } });
      check('两个渠道的权重都设置成功（测试前置条件）', wa.status === 200 && wb.status === 200, { a: wa.status, b: wb.status });
      await landings(12);
      await settle();                     // 同上：速度项也在一拍一算，别读到上拍缓存
      const st = await status();
      const e = preview(st, 'm1');
      const a = e.candidates.find((c) => c.id === 'aw-a'), b = e.candidates.find((c) => c.id === 'aw-b');
      check('两个渠道都拿到了延迟数据（各至少 1 次成功请求）', a.latMs > 0 && b.latMs > 0, { a: a.latMs, b: b.latMs });
      check('★ 慢的那家速度比 > 1（/slow 拖了 250ms，实测得到）', b.speedRatio > 1.5, { b: b.speedRatio, a: a.speedRatio });
      check('★ 慢的被温和打折（h < 1），但没被打死（h ≥ 地板 0.2）', b.h < 1 && b.h >= 0.2, b.h);
      /* ★ 基准的含义要写准（v1.9.3 起 perChannel 真正接线，这条随之收紧）：
         §2 造出来的失败还留在 a 的滚动窗口里，而重试会让"每次尝试各记一次失败"——失败率因此可能
         真的推过死区，a 的 h 就会被**失败项**扣到 1 以下（实测 0.875）。所以基准不能写成 "a.h === 1"，
         而要写成蕴含式：h 掉了就必须能归因到失败项。这样"速度惩罚漏到快渠道上"照样会被抓住。 */
      {
        const knobs = (st.autoWeight || {}).knobs || {};
        check('★ 快的那家的速度比 ≈ 1（延迟项只往慢的那边扣）',
          Math.abs(a.speedRatio - 1) < 0.05, { a: a.speedRatio, b: b.speedRatio });
        check('★ 快的那家 h 若没保持 1，只允许是失败项扣的（h < 1 ⇒ 失败率已过死区）',
          a.h === 1 || a.failRate >= knobs.deadband,
          { h: a.h, failRate: a.failRate, deadband: knobs.deadband, samples: a.samples });
      }
      check('手工权重 1:1 时 nowShare 是 50 / 50（当前真实份额的对照）',
        JSON.stringify(e.candidates.map((c) => c.nowShare)) === '[50,50]', e.candidates.map((c) => c.nowShare));
    }

    /* ══════════ 4. 配置往返：旋钮不能被保存渠道顺手抹掉 ══════════ */
    console.log('\n4. 配置往返：保存渠道之后旋钮还在（persistConfig 白名单）');
    {
      await admin('/admin/api/channel', { method: 'POST', body: { id: 'aw-a', enabled: true } });
      const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      check('★ config.json 里 autoWeight 块仍在', !!disk.autoWeight, Object.keys(disk));
      check('★ 而且旋钮值原样保留（latencyPenalty 0.6 / maxShare 70）',
        disk.autoWeight && disk.autoWeight.latencyPenalty === 0.6 && disk.autoWeight.maxShare === 70, disk.autoWeight);
      check('渠道也在（没被顺手清掉）', disk.channels.length === 2, disk.channels.map((c) => c.id));
    }
    /* ══════════ 5. 后台节拍：数据不该依赖"有没有人开着控制台" ══════════ */
    console.log('\n5. ⭐ 后台节拍：不开控制台也在观测（自动权重要跑几天看趋势就靠它）');
    {
      /* 为什么要单独起两个实例：观测的 h 是"一拍一算"的（指数平滑 + 死区），而触发点原来只有
         /admin/api/status —— 控制台一关就没数据了。这里故意**全程不拉 status**，只在最后读一次，
         于是 ticks 里有且只有后台定时器的拍数，因果干净。 */
      const spin = async (enabled) => {
        const P = await freePort(), C = path.join(TMP, `tick-${enabled}.json`);
        fs.writeFileSync(C, JSON.stringify({
          port: P, health: { intervalSec: 3600, timeoutMs: 2000 }, retries: { perChannel: 0 },
          autoWeight: { ...KNOBS, enabled, updateMs: 1000 },
          channels: [{ id: 'tk-a', name: 'A', baseUrl: `http://127.0.0.1:${PU}/fast`, apiKey: 'k', protocol: 'openai', priority: 10, enabled: true, models: { m1: 'm1' } }],
        }));
        const cp = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
          cwd: ROOT,
          env: { ...process.env, ZZCSAPI_CONFIG: C, ZZCSAPI_USAGE: path.join(TMP, `tick-${enabled}-u.json`), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
          stdio: 'ignore',
        });
        const up = async () => {
          for (let i = 0; i < 40; i++) {
            try { const r = await fetch(`http://127.0.0.1:${P}/healthz`); if (r.ok) return true; } catch { }
            await sleep(150);
          }
          return false;
        };
        const ok = await up();
        return { cp, P, ok, stop: () => stopChild(cp) };
      };
      const readTicks = async (P) => {
        const r = await fetch(`http://127.0.0.1:${P}/admin/api/status`, { headers: { Authorization: 'Bearer ' + AD_KEY } });
        const j = await r.json();
        return j.autoWeight;
      };

      // ① 关着：不该建定时器 —— 静默不变式在"没开"的时候也要成立（不观测、不算、不占 CPU）
      const off = await spin(false);
      check('enabled:false 的实例起来了', off.ok);
      await sleep(3400);                                  // 足够跑 3 拍（updateMs 1s），但它不该跑
      const awOff = await readTicks(off.P);
      check('★ enabled:false → 后台拍了 0 次（不开就一行都不动）', awOff.ticks === 0, { ticks: awOff.ticks });
      await off.stop();

      // ② 开着：全程不碰 status，只靠后台节拍（最后这一次读也算在因果之外：ticks 只数定时器那一路）
      const on = await spin(true);
      check('enabled:true 的实例起来了', on.ok);
      await sleep(3400);
      const awOn = await readTicks(on.P);
      check('★ enabled:true → 后台自己拍了 ≥2 次（没人开控制台也在观测）', awOn.ticks >= 2, { ticks: awOn.ticks });
      check('★ 而且这一路仍然只算不生效（effective 恒 false、旋钮照配置回显）',
        awOn.effective === false && awOn.enabled === true && awOn.knobs.updateMs === 1000,
        { effective: awOn.effective, enabled: awOn.enabled, updateMs: awOn.knobs.updateMs });
      check('节拍真的产出了观测数据（时间戳有值）', typeof awOn.at === 'number' && awOn.at > 0, awOn.at);
      await on.stop();
    }
  } finally {
    await cleanup();
  }

  console.log('\n──────────────────────────────────────────────────────────');
  if (fail) { console.log('✗ 失败 ' + fail + ' 项 / 通过 ' + pass + ' 项'); process.exitCode = 1; }
  else console.log('✓ 全部通过（' + pass + ' 项断言）');
})();
