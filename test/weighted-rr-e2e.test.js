#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/weighted-rr-e2e.test.js — 加权轮询端到端回归（真起进程，零依赖）
 *
 * 单元测试证明算法对，这个文件证明**真实调度路径**上流量真的按权重分：
 *   真起「两个假上游 + 临时网关」，用 X-ZZCSAPI-Channel 响应头数 40 次请求的落点。
 *
 * 覆盖：
 *   · 3:1 两个渠道 → 实际分流 ≈75%/25%（真 HTTP，不是调函数）；
 *   · ★ 对照：两个渠道都不填 weight → 仍然 100% 走原来的第一个（老配置零影响）；
 *   · 冷却/降级渠道不进池，份额归健康成员；
 *   · 未填 weight 的渠道仍留在兜底链（第一个挂了能顶上）;
 *   · /admin/api/status 暴露 weight / weightedHits / weightedShare。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/weighted-rr-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-wrr-e2e-'));
const GW_KEY = 'e2e-gw', AD_KEY = 'e2e-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 220) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

// 两个假上游：A 永远成功；B 可控失败（测"降级渠道不进池"）
function makeUpstream(state) {
  return http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      if (req.method === 'GET' && /models/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-w' }] }));
      }
      if (state.down) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":"mock down"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok-' + state.tag } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
}

(async () => {
  const UA = { tag: 'A', down: false }, UB = { tag: 'B', down: false };
  const upA = makeUpstream(UA), upB = makeUpstream(UB);
  const PA = await freePort(), PB = await freePort(), GW = await freePort();
  await new Promise((r) => upA.listen(PA, '127.0.0.1', r));
  await new Promise((r) => upB.listen(PB, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'wr.json');
  const writeCfg = (weighted) => fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 1, maxModelFallbacks: 99 },
    channels: [
      { id: 'mock-wA', name: 'A', protocol: 'openai', baseUrl: `http://127.0.0.1:${PA}/v1`, apiKey: 'sk-a', priority: 10, enabled: true, models: { 'mock-w': 'mock-w' }, ...(weighted ? { weight: 3 } : {}) },
      { id: 'mock-wB', name: 'B', protocol: 'openai', baseUrl: `http://127.0.0.1:${PB}/v1`, apiKey: 'sk-b', priority: 5, enabled: true, models: { 'mock-w': 'mock-w' }, ...(weighted ? { weight: 1 } : {}) },
    ],
  }));
  writeCfg(true);

  const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
    stdio: 'ignore',
  });
  /* 等子进程真正退出再走人：process.exit() 撞上还没关干净的 libuv 句柄，在 Windows 上会
   以 0xC0000409 崩掉——断言全绿却返回失败退出码，把真回归藏在噪声里。 */
const stopChild = (cp) => new Promise((res) => {
  if (!cp || cp.exitCode !== null || cp.signalCode !== null) return res();
  cp.once('exit', () => res());
  try { cp.kill(); } catch { }
  setTimeout(res, 1500);   // 兜底：杀不掉也别把测试挂死
});
const cleanup = () => {
    try { gw.kill(); } catch { }
    try { upA.close(); upB.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  };
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
      body: JSON.stringify({ model: 'mock-w', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text();
    return { status: r.status, ch: r.headers.get('X-ZZCSAPI-Channel') };
  };
  const distribution = async (n) => {
    const hits = {};
    for (let i = 0; i < n; i++) { const r = await call(); hits[r.ch || ('HTTP' + r.status)] = (hits[r.ch || ('HTTP' + r.status)] || 0) + 1; }
    return hits;
  };
  const admin = async (p) => (await fetch(`http://127.0.0.1:${GW}${p}`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).json();

  try {
    if (!await waitUp()) throw new Error('临时网关未起来');

    console.log('\n1. ★ 配置 weight 3:1 → 真实流量分流 ≈75%/25%');
    let hits = await distribution(40);
    check('两个渠道都用上了（不是只走第一个）', (hits['mock-wA'] || 0) > 0 && (hits['mock-wB'] || 0) > 0, hits);
    const shareA = (hits['mock-wA'] || 0) / 40;
    check('★ A(w=3) 实际占比 75% ±10%', Math.abs(shareA - 0.75) <= 0.10, hits);
    check('全部请求都成功（分流不影响可用性）', ((hits['mock-wA'] || 0) + (hits['mock-wB'] || 0)) === 40, hits);
    const st = await admin('/admin/api/status');
    const chA = st.channels.find((c) => c.id === 'mock-wA');
    const chB = st.channels.find((c) => c.id === 'mock-wB');
    check('status 暴露 weight', chA.weight === 3 && chB.weight === 1, { a: chA.weight, b: chB.weight });
    check('status 暴露 weightedHits（与实测落点一致）', chA.weightedHits === (hits['mock-wA'] || 0), { status: chA.weightedHits, real: hits['mock-wA'] });
    check('status 暴露 weightedShare', chA.weightedShare > 50, chA.weightedShare);

    console.log('\n2. B 上游持续失败（连挂 3 次进 down）→ 份额自动归 A');
    UB.down = true;
    await distribution(4); // 让 B 累积失败（首个候选仍可能轮到 B，就会失败并切 A，能拿到结果）
    hits = await distribution(12);
    check('★ B 不再被选中（down 不进轮询池）', (hits['mock-wB'] || 0) === 0, hits);
    check('A 吸收全部流量且请求都成功', (hits['mock-wA'] || 0) === 12, hits);
    UB.down = false;

    console.log('\n3. ★ 对照：都不填 weight → 100% 走原来的第一个（老配置零影响）');
    // 重写配置（去掉 weight）+ 重启网关实例
    writeCfg(false);
    const gw2 = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage2.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
      stdio: 'ignore',
    });
    try { gw.kill(); } catch { }
    await sleep(600);
    if (!await waitUp()) throw new Error('第二个临时网关未起来');
    hits = await distribution(20);
    const st2 = await admin('/admin/api/status');
    check('★ 没有 weight 时：priority 最高的 A 吃满（20/20）', (hits['mock-wA'] || 0) === 20, hits);
    check('轮询统计为空（没进池，没人被记命中）', st2.channels.every((c) => !c.weightedHits), st2.channels.map((c) => [c.id, c.weightedHits]));
    check('A 的 weight 字段为 0（未配置）', st2.channels.find((c) => c.id === 'mock-wA').weight === 0, st2.channels.find((c) => c.id === 'mock-wA').weight);
    try { gw2.kill(); } catch { }

    console.log('\n4. 未填 weight 的渠道仍在兜底链（A 挂掉能顶到 B）');
    UA.down = true;
    writeCfg(false);
    const gw3 = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage3.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
      stdio: 'ignore',
    });
    await sleep(600);
    if (!await waitUp()) throw new Error('第三个临时网关未起来');
    const r1 = await call();
    check('首个渠道 500 时自动切到兜底渠道 B', r1.status === 200 && r1.ch === 'mock-wB', r1);
    try { gw3.kill(); } catch { }
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await cleanup();
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不 process.exit()：见 stopChild 注释
})();
