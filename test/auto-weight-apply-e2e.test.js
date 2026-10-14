#!/usr/bin/env node
/* 自动权重**生效**回归（node test/auto-weight-apply-e2e.test.js，零依赖）
 *
 * 守的是什么（v1.18.63）：观测算出的健康系数 h，在 `enabled:true` 时**真的乘进权重、真的影响分流**；
 * 关闭时**逐字节回旧行为**。姊妹用例 `auto-weight-e2e.test.js` 验的是关闭态那一臂（观测有数据、
 * 分流不变），本文件验开启态那一臂。
 *
 * 判据为什么是「B 被上游碰到几次」——这是唯一能区分新旧机制的观测量：
 *   · A（健康、priority 10）永远排在候选链第一位，B（慢失败、priority 0）只在前面的家失败时才被试。
 *   · **关闭**：没有任何渠道填 weight → `pickWeighted` 池子为空 → 顺序恒为 [A, B] → **B 一次都不会被碰**。
 *   · **开启**：`effWeight` 给每家一个 (权重‖1)×h 的值 → B 也会赢得加权选择、被提到链首 → **B 被碰到**。
 *     而且 h 掉到地板后 B 明显少 —— 但**不是零**（地板就是恢复路径，不能被堵死）。
 *
 * 两个实例、同一份假上游、同一批请求，只有 `autoWeight.enabled` 一个变量不同。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-awapply-'));

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 240) : '')); }
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

console.log('\n自动权重生效 / 关闭：两个实例，只差 enabled 一个变量');
(async () => {
  const upPort = await freePort();
  let slowHits = 0, fastHits = 0;

  // 假上游：/fast 立刻 200；/slow 慢 120ms 后 500（不健康但不死）。探测路径一律放行。
  const upstream = http.createServer((req, res) => {
    const u = String(req.url || '');
    const drain = () => {
      if (!/chat\/completions/.test(u)) {                 // /models 等探测：必须放行，否则启动探测把两家打进冷却
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }] }));
        return;
      }
      const slow = u.startsWith('/slow');
      if (slow) slowHits++; else fastHits++;
      setTimeout(() => {
        if (slow) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'slow-boom' } })); }
        else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
        }
      }, slow ? 120 : 0);
    };
    req.on('data', () => {}); req.on('end', drain);
  });
  await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

  const spin = async (enabled) => {
    const P = await freePort();
    const C = path.join(TMP, `aw-${enabled}.json`);
    fs.writeFileSync(C, JSON.stringify({
      port: P, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
      cooldown: { transientBaseMs: 1000 },
      // updateMs 压到 500ms：h 是"一拍一算"的（平滑 + 死区，抗振荡设计），用例要跑得动就得让它多拍几次
      autoWeight: { enabled, minSamples: 2, floor: 0.2, latencyPenalty: 0, maxShare: 70, updateMs: 500, ewma: 0.5, deadband: 0.01 },
      channels: [
        { id: 'aw-fast', name: 'A', baseUrl: `http://127.0.0.1:${upPort}/fast`, apiKey: 'k', protocol: 'openai', priority: 10, enabled: true, models: { m1: 'm1' } },
        { id: 'aw-slow', name: 'B', baseUrl: `http://127.0.0.1:${upPort}/slow`, apiKey: 'k', protocol: 'openai', priority: 0, enabled: true, models: { m1: 'm1' } },
      ],
    }));
    const gw = startGateway(C, P);
    const ok = await waitUp(P);
    const chat = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${P}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: false }),
        });
        await r.text();
        return r.status;
      } catch { return 0; }
    };
    return { gw, ok, chat, port: P };
  };

  const inst = [];
  try {
    /* ── 关闭态：分流必须逐字节不变（B 一次都不该被碰） ── */
    slowHits = 0; fastHits = 0;
    const off = await spin(false);
    inst.push(off.gw.proc);
    check('关闭态实例起来了', off.ok, off.gw.lines.slice(-2));
    await sleep(1200);                                   // 让节拍跑几拍（观测永远开）
    const offCodes = [];
    for (let i = 0; i < 30; i++) offCodes.push(await off.chat());
    await sleep(400);
    check('★ 关闭态：30 发全部成功（A 永远健康、B 从不被选中）', offCodes.every((c) => c === 200), offCodes.filter((c) => c !== 200));
    check('★ 关闭态：不健康的 B **一次都没被碰**（没有渠道填 weight → 加权池空 → 顺序恒为 [A,B]）', slowHits === 0, { slowHits, fastHits });
    const offSt = await (await fetch(`http://127.0.0.1:${off.port}/admin/api/status`)).json();
    const offHits = (offSt.channels || []).reduce((s, c) => s + (c.weightedHits || 0), 0);
    check('★ 关闭态：加权命中恒为 0（没填 weight → 池子空 → pickWeighted 直接返回 -1、完全空转）', offHits === 0, { offHits });

    /* ── 开启态：B 会被碰到（赢得加权选择），且被降权后明显少、但**不是零** ── */
    slowHits = 0; fastHits = 0;
    const on = await spin(true);
    inst.push(on.gw.proc);
    check('开启态实例起来了', on.ok, on.gw.lines.slice(-2));
    await sleep(1200);
    const onCodes = [];
    /* ★ 有界重试，不用固定发数赌运气（v1.18.66 修假红）。
       判别量是「B 被上游碰到过没有」，而 B 一失败就吃 **1s 冷却**（冷却下限就是 1s，压不下去）。
       固定发 60 发时，整轮可能正好落在同一个冷却窗口里 —— 单跑全过、**全量负载下偶发一败**
       （这正是它红过一次的原因）。改成：每轮 20 发、每发间隔 60ms（跨得过 1s 冷却），
       最多 8 轮，一旦 B 被碰到就停。忙机器上只是多跑几轮，**不会假红**；
       上限仍然存在，真坏了也不会变成死循环。 */
    let rounds = 0;
    while (slowHits === 0 && rounds < 8) {
      for (let i = 0; i < 20; i++) { onCodes.push(await on.chat()); await sleep(60); }
      rounds++;
    }
    await sleep(600);
    check('★ 开启态：请求仍全部成功（B 先失败 → 兜底到 A，客户端无感）', onCodes.every((c) => c === 200), onCodes.filter((c) => c !== 200));
    check('★ 开启态：B **被碰到了**（健康系数乘进权重后，它也能赢得加权选择、被提到链首）——这正是与关闭态的判别量',
      slowHits > 0, { slowHits, fastHits, rounds, sent: onCodes.length });
    check('★ 但它被降权后明显少于 A（不是平起平坐，也不至于垄断）', slowHits < fastHits, { slowHits, fastHits });
    const onSt = await (await fetch(`http://127.0.0.1:${on.port}/admin/api/status`)).json();
    const onHits = (onSt.channels || []).reduce((s, c) => s + (c.weightedHits || 0), 0);
    check('★ 开启态：加权命中非零（健康系数真的把这两家送进了加权池，而不是"看着生效"）', onHits > 0, { onHits });
    check('开启态：status 里 effective 为 true（观测值确实在影响分流）',
      onSt.autoWeight && onSt.autoWeight.effective === true, onSt.autoWeight && { e: onSt.autoWeight.enabled, f: onSt.autoWeight.effective });
    const obs = ((onSt.autoWeight || {}).models || []).find((m) => m.model === 'm1') || {};
    const slowCand = (obs.candidates || []).find((c) => c.id === 'aw-slow');
    const slowExcluded = (obs.excluded || []).includes('aw-slow');
    /* 两种形态**都算如实**，不是放宽：`autoWeightObserve` 只列 `live`（冷却/down 不列），
       而 B 恰恰是个一直失败的家 —— 读这一发的瞬间它完全可能正在冷却里，于是"没有行"
       本身就是观测对状态的真实反映（它会出现在 `excluded` 里）。
       钉死"必须有行"会变成假红：跑得越久 B 被碰越多、冷却越深、越容易被裁掉。 */
    check('开启态：不健康那家在观测里有交代（有行且 h/samples 是有限数，或因冷却列进 excluded）',
      (!!slowCand && Number.isFinite(slowCand.h) && Number.isFinite(slowCand.samples)) || slowExcluded,
      { hasRow: !!slowCand, h: slowCand && slowCand.h, samples: slowCand && slowCand.samples, excluded: slowExcluded });
    /* ⚠ 本夹具**证不到**"h 真的掉到地板"：B 一失败就被冷却挡在加权池外（冷却与自动权重是叠加的），
       攒不满 minSamples，于是 h 停在中性值。要证那一条得把冷却压到不影响观测的节奏上——
       那属于另一个夹具的题目，这里如实标注，不用一条更弱的断言冒充它。 */
  } finally {
    for (const p of inst) { try { p.kill('SIGKILL'); } catch { /* 已退出 */ } }
    try { upstream.close(); } catch { /* 已关 */ }
  }

  console.log('\n' + '─'.repeat(58));
  if (fail === 0) console.log(`✓ 全部通过（${pass} 项断言）`);
  else { console.log(`✗ ${pass} 通过 / ${fail} 失败`); process.exitCode = 1; }
})();
