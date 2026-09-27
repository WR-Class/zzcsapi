#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/disabled-channel-manual-test-e2e.test.js — 停用渠道：能手动测，不被自动测
 *                                                                （真起进程，零依赖）
 *
 * 需求原话：「停用的渠道没办法手动测试模型是否可用，我想要停用的渠道点击测试也可以测试我添加的模型。
 *           当然停用的程序不用自动测试。」
 *
 * 查下来是**两处**、方向正好相反：
 *   · 手动测试打不通 —— 不是后端的问题（`/admin/api/test` 带 channelId 时本来就只打那一条渠道、
 *     不看 enabled），而是**控制台** `openTestModels` 里一句 `if(!c.on)continue;` 把停用渠道整个跳过，
 *     于是从停用渠道点「测试」弹出来的是空列表、运行按钮是灰的；
 *   · 自动探测恰恰**没有**跳过停用渠道 —— `probeAll()` 之前对 `channels.values()` 全量探测，
 *     停用渠道照样每隔 `health.intervalSec` 被探一次（消耗配额、还可能把状态越推越烂）。
 *
 * 这个文件守两条契约（真起「两个假上游 + 临时网关」，动态端口、配置在系统临时目录）：
 *   §1 自动探测（启动 + 定时器）**只打启用渠道**，停用渠道 0 次；
 *   §2 手动测试停用渠道**打得通**（真发一次 chat），且**不会**顺手把它启用、也不进 `/v1/models`；
 *   §3 手动「全部重探测」/ 单渠道重探测是**手动**动作 → 停用渠道照探（结果里带 enabled:false）。
 * 跑法：node test/disabled-channel-manual-test-e2e.test.js   （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
// 仓库里的源码是 CRLF：读进来先归一成 LF，下面的装配守卫才敢用 "\n" 写跨行正则
// （不然 `a\nb` 永远匹配不上 `a\r\nb`，守卫会静默变成恒假——这类坑本项目已经踩过一次）。
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-dis-test-'));
const GW_KEY = 'dc-gw', AD_KEY = 'dc-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 260) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/* 假上游：GET /models 记一次"探测"，POST 记一次"真实对话" */
function makeUpstream(tag) {
  const st = { tag, probeHits: 0, chatHits: 0, lastChat: null };
  st.server = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      if (req.method === 'GET') {
        st.probeHits++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: tag + '-probed', object: 'model' }] }));
      }
      st.chatHits++;
      let body = {}; try { body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}'); } catch { }
      st.lastChat = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-' + tag, object: 'chat.completion', model: body.model || 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: tag + ' 还活着' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }));
    });
  });
  return st;
}

(async () => {
  const UP_ON = await freePort(), UP_DIS = await freePort(), GW = await freePort();
  const on = makeUpstream('启用家'), dis = makeUpstream('停用家');
  await new Promise((r) => on.server.listen(UP_ON, '127.0.0.1', r));
  await new Promise((r) => dis.server.listen(UP_DIS, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'c.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW,
    // 1 秒一次自动探测：几秒内就能看出"停用的到底有没有被探"
    health: { intervalSec: 1, timeoutMs: 1500 },
    retries: { perChannel: 0, maxModelFallbacks: 3 },
    channels: [
      { id: 'live', name: '启用家', baseUrl: `http://127.0.0.1:${UP_ON}/v1`, apiKey: 'sk-on', protocol: 'openai', priority: 10, enabled: true, models: { 'm-on': 'up-on' } },
      { id: 'stopped', name: '停用家', baseUrl: `http://127.0.0.1:${UP_DIS}/v1`, apiKey: 'sk-dis', protocol: 'openai', priority: 20, enabled: false, models: { 'm-dis': 'up-dis' } },
    ],
  }));

  const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'u.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
    stdio: 'ignore',
  });
  const stop = (cp) => new Promise((res) => {
    if (!cp || cp.exitCode !== null || cp.signalCode !== null) return res();
    cp.once('exit', () => res());
    try { cp.kill(); } catch { }
    setTimeout(res, 1500);
  });
  const admin = (p, body) => fetch(`http://127.0.0.1:${GW}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AD_KEY}` },
    body: JSON.stringify(body || {}),
  }).then(async (r) => ({ code: r.status, body: await r.json().catch(() => null) }));

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${GW}/healthz`)).ok; } catch { await sleep(150); } }
    check('临时网关起来了', up);
    if (!up) throw new Error('网关未启动');

    /* ══════════ 0. 装配守卫 ══════════ */
    console.log('\n0. 装配守卫（源码里必须真的是这套接线）');
    {
      check('★ probeAll 默认跳过停用渠道（自动探测的目标集合先过滤）',
        /async function probeAll\(opts = \{\}\)[\s\S]{0,400}?includeDisabled[\s\S]{0,200}?ch\.def\.enabled !== false/.test(SRC));
      check('★ 启动与定时器那两处调用不带参数（= 跳过停用）',
        /\n  probeAll\(\)\.catch\(\(\) => \{\}\);\n  setInterval\(\(\) => probeAll\(\)\.catch\(\(\) => \{\}\), HEALTH\.intervalSec \* 1000\);/.test(SRC));
      check('★ 手动「全部重探测」显式传 includeDisabled:true（手动动作不被上面的跳过规则挡住）',
        /await probeAll\(\{ includeDisabled: true \}\)/.test(SRC));
      check('重探测结果里带 enabled 字段（控制台能区分"探过"和"跳过"）',
        /enabled: ch\.def\.enabled !== false,\n      error: ch\.lastError,/.test(SRC));
      check('★ /admin/api/test 指定 channelId 时不看 enabled（手动测试停用渠道本来就该能打）',
        /const onlyChannel = body\.channelId \? channels\.get\(body\.channelId\) : null;/.test(SRC)
        && !/onlyChannel[\s\S]{0,120}?enabled === false[\s\S]{0,80}?return sendJson\(res, 4/.test(SRC));
      const app = fs.readFileSync(path.join(ROOT, 'build', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
      check('★ 控制台 openTestModels 不再无条件跳过停用渠道（PT：从停用渠道点测试是空列表）',
        /function openTestModels/.test(app) && !/if\(!c\.on\)continue;/.test(app));
      check('★ 停用渠道在测试弹窗里有「已停用」标记，且说明不参与自动探测',
        /g\.c\.on\?'':'<span class="tag">已停用<\/span>'/.test(app) && /停用渠道不参与自动探测/.test(app));
    }

    /* ══════════ 1. 自动探测：停用的不被探 ══════════ */
    console.log('\n1. 自动探测（启动 + 每秒定时器）：只打启用渠道，停用渠道 0 次');
    {
      await sleep(3600);
      check('启用渠道被自动探过（≥1 次）', on.probeHits >= 1, on.probeHits);
      check('★★ 停用渠道一次都没被自动探（这就是"停用的不用自动测试"）', dis.probeHits === 0, dis.probeHits);
      check('停用渠道也没被自动打过真实对话', dis.chatHits === 0, dis.chatHits);
    }

    /* ══════════ 2. 手动测试停用渠道：打得通 ══════════ */
    console.log('\n2. 手动测试停用渠道：/admin/api/test 带 channelId → 真打一发');
    {
      // 先记下"自动探测"期间的基准，后面只看增量
      const beforeChat = dis.chatHits, beforeProbe = dis.probeHits;
      const r = await admin('/admin/api/test', { model: 'm-dis', channelId: 'stopped', prompt: 'hi' });
      check('HTTP 200（不是 404 "no channel"、也不是 4xx 拒绝）', r.code === 200, { code: r.code, body: r.body });
      const row = (r.body && r.body.results || [])[0] || {};
      check('★★ 测试真的成功了（停用渠道手动可测）', row.ok === true, row);
      check('回复是上游那条渠道给的（证明打的是停用家，不是别的渠道）',
        String(row.reply || '').includes('停用家'), row.reply);
      check('★ 上游确实收到了一发真实 chat 请求', dis.chatHits === beforeChat + 1, { before: beforeChat, now: dis.chatHits });
      check('★ 这一发不是探测（GET /models 计数没动）', dis.probeHits === beforeProbe, { before: beforeProbe, now: dis.probeHits });
      check('模型名按该渠道 aliasMap 翻译成上游名（m-dis → up-dis）', dis.lastChat && dis.lastChat.model === 'up-dis', dis.lastChat && dis.lastChat.model);

      const st = await (await fetch(`http://127.0.0.1:${GW}/admin/api/status`, { headers: { Authorization: `Bearer ${AD_KEY}` } })).json();
      const chDis = (st.channels || []).find((c) => c.id === 'stopped');
      check('★★ 测通**不会**顺手把它启用（停用状态不变）', chDis && chDis.enabled === false, chDis && chDis.enabled);
      const modelsOn = await (await fetch(`http://127.0.0.1:${GW}/v1/models`, { headers: { Authorization: `Bearer ${GW_KEY}` } })).json();
      const ids = (modelsOn.data || []).map((m) => m.id);
      check('★ 停用渠道的别名不进 /v1/models（停用就是不对外暴露）',
        ids.includes('m-on') && !ids.includes('m-dis'), ids);

      // 对照组：启用渠道手动测试也照旧能打
      const rOn = await admin('/admin/api/test', { model: 'm-on', channelId: 'live', prompt: 'hi' });
      check('对照：启用渠道手动测试行为没变', rOn.code === 200 && ((rOn.body.results || [])[0] || {}).ok === true, rOn.body);
    }

    /* ══════════ 3. 手动重探测：停用的照探 ══════════ */
    console.log('\n3. 手动重探测是手动动作 → 停用渠道照探（结果里带 enabled:false）');
    {
      const before = dis.probeHits;
      const r = await admin('/admin/api/recheck', {});           // 不带 id = 全部重探测
      check('HTTP 200 且带 summary', r.code === 200 && !!r.body.summary, r.body && r.body.summary);
      check('★ 停用渠道也被手动重探了（+1）', dis.probeHits === before + 1, { before, now: dis.probeHits });
      const row = (r.body.results || []).find((x) => x.id === 'stopped');
      check('★ 结果里如实标出 enabled:false（控制台能区分）', row && row.enabled === false, row);

      const b2 = dis.probeHits;
      const r2 = await admin('/admin/api/recheck', { id: 'stopped' });
      check('★ 单渠道重探测对停用渠道同样有效（+1）', dis.probeHits === b2 + 1, { before: b2, now: dis.probeHits });
      check('单渠道结果形态不变（id/status/latencyMs/modelCount）',
        r2.code === 200 && (r2.body.results || [])[0].id === 'stopped'
        && typeof (r2.body.results || [])[0].latencyMs === 'number', r2.body && r2.body.results);
    }

    /* ══════════ 4. 对照：停用渠道仍然不参与真实调度 ══════════ */
    console.log('\n4. 对照：能手动测 ≠ 会被调度（停用不参与分流）');
    {
      const before = dis.chatHits;
      for (let i = 0; i < 5; i++) {
        await fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GW_KEY}` },
          body: JSON.stringify({ model: 'm-dis', messages: [{ role: 'user', content: 'hi' }] }),
        }).catch(() => { });
      }
      check('★ 用停用渠道独有的模型名发真实请求：一次都没落到它（停用 ≠ 可用）', dis.chatHits === before, { before, now: dis.chatHits });
    }
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message) + '\n' + (e && e.stack ? String(e.stack).split('\n').slice(1, 4).join('\n') : ''));
  } finally {
    await stop(gw);
    try { on.server.close(); dis.server.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;
})();
