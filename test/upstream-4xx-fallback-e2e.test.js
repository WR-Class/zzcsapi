#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/upstream-4xx-fallback-e2e.test.js — 「上游 4xx 不许短路兜底」端到端回归
 *                                                        （真起进程，零依赖）
 *
 * 背景（真机踩到的现象）：同一个模型有两个候选，排第一的那家**声明**了该模型但上游早已下架
 * （别名表过期）→ 上游回 404。旧判据里 401/402/403/408/429 之外的所有 4xx 一律原样透传，
 * 于是客户端拿到 404、第二家根本没被试——而网关此前**已经**给这家记了失败并置了冷却：
 * 自己认定是渠道的错，却对客户端说是客户端的错，还不兜底，逻辑自相矛盾。
 *
 * 契约（本轮定下，见 server.js 的 shouldPassThrough4xx）：
 *   · 后面还有**能上场**的候选 → 上游 4xx 当"这家不行"，继续切兜底；
 *   · 已是最后一个能上场的候选 → 原样透传（客户端的 400 参数错语义不变）；
 *   · 401/402/403/404/408/429 永远属于渠道侧，必切（跨渠道各不相同）。
 *
 * 两个**反例**（本轮真被测试抓出来的，必须一直绿）：
 *   · "还有后续候选"不能只看下标：冷却中的候选这一轮根本不会被 attempt，把它算成后手会让
 *     4xx 兜底切进空池，最后兜出个 502，把客户端本该看到的 400 弄丢；
 *   · 不能拿"两家都回同一个 4xx"当客户端错误的判据提前收手：同品牌中转的参数方言往往一致，
 *     那样会掐掉后面本来能成的渠道——这正是本修复要恢复的可用性。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/upstream-4xx-fallback-e2e.test.js   （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-4xx-e2e-'));
const GW_KEY = 'e2e-gw', AD_KEY = 'e2e-admin';

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

/* 假上游：state.status 为 0/200 = 成功，否则按该状态码回 JSON 错误体。
   state.chat 只统计**对话请求**（/models 探测不算账：健康探测会在启动时打一发，
   混进来会让"这家被打了几次"这种断言莫名其妙地多 1）。 */
function makeUpstream(state) {
  return http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      if (req.method === 'GET' && /models/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-4xx' }] }));
      }
      state.chat++;
      if (state.status && state.status !== 200) {
        res.writeHead(state.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `upstream ${state.tag} says ${state.status}`, type: state.status === 404 ? 'not_found_error' : 'invalid_request_error' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok-' + state.tag } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
}

(async () => {
  /* A 排第一（priority 高），B 兜底，C 再兜一层。三家都声明同一个模型。 */
  const UA = { tag: 'A', status: 0, chat: 0 };
  const UB = { tag: 'B', status: 0, chat: 0 };
  const UC = { tag: 'C', status: 0, chat: 0 };
  const upA = makeUpstream(UA), upB = makeUpstream(UB), upC = makeUpstream(UC);
  const PA = await freePort(), PB = await freePort(), PC = await freePort(), GW = await freePort();
  await new Promise((r) => upA.listen(PA, '127.0.0.1', r));
  await new Promise((r) => upB.listen(PB, '127.0.0.1', r));
  await new Promise((r) => upC.listen(PC, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'fourxx.json');
  /* only: 'abc' 全三家 / 'ab' 两家 / 'a' 单家 —— 用来验证"最后一个候选仍原样透传" */
  const writeCfg = (only) => {
    const all = {
      a: { id: 'up-a', name: 'A', protocol: 'openai', baseUrl: `http://127.0.0.1:${PA}/v1`, apiKey: 'sk-a', priority: 30, enabled: true, models: { 'mock-4xx': 'mock-4xx' } },
      b: { id: 'up-b', name: 'B', protocol: 'openai', baseUrl: `http://127.0.0.1:${PB}/v1`, apiKey: 'sk-b', priority: 20, enabled: true, models: { 'mock-4xx': 'mock-4xx' } },
      c: { id: 'up-c', name: 'C', protocol: 'openai', baseUrl: `http://127.0.0.1:${PC}/v1`, apiKey: 'sk-c', priority: 10, enabled: true, models: { 'mock-4xx': 'mock-4xx' } },
    };
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: GW, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 1, maxModelFallbacks: 99 },
      channels: only.split('').map((k) => all[k]),
    }));
  };
  const reset = (a, b, c) => { UA.status = a; UA.chat = 0; UB.status = b; UB.chat = 0; UC.status = c; UC.chat = 0; };

  let gw = null, usageN = 0;
  /* 每个场景都起一个**全新**网关：上游一次失败就会给自己置 2^n 秒冷却（recordFailure），
     跨场景复用会把上一场景的冷却带进来，断言就变成"因为冷却"而不是"因为修复"了。 */
  const restart = async (only) => {
    writeCfg(only);
    await stopChild(gw);
    gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, `usage-${++usageN}.json`), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
      stdio: 'ignore',
    });
    if (!await waitUp()) throw new Error('临时网关未起来（only=' + only + '）');
  };
  /* 等子进程真正退出再走人：process.exit() 撞上还没关干净的 libuv 句柄，在 Windows 上会以
     0xC0000409 崩掉——断言全绿却返回失败退出码，把真回归藏在噪声里。 */
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
      body: JSON.stringify({ model: 'mock-4xx', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await r.text();
    return { status: r.status, ch: r.headers.get('X-ZZCSAPI-Channel'), text };
  };
  const admin = async (p) => (await fetch(`http://127.0.0.1:${GW}${p}`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).json();

  try {
    console.log('\n0. 判据单测：从 server.js 现抠 shouldPassThrough4xx 跑真值表 + 装配守卫');
    {
      const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
      const at = src.indexOf('function shouldPassThrough4xx');
      if (at < 0) throw new Error('server.js 里找不到 shouldPassThrough4xx');
      /* 花括号配对抠函数体（与其它测试同款做法），不在测试里维护第二份实现 */
      let depth = 0, end = -1;
      for (let k = src.indexOf('{', at); k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') { depth--; if (!depth) { end = k + 1; break; } }
      }
      const fn = new Function('return (' + src.slice(at, end) + ')')();
      check('最后一个候选 + 400 → 透传（客户端的错语义不变）', fn(400, false) === true);
      check('★ 后面还有候选 + 400 → 不透传（继续兜底）', fn(400, true) === false);
      check('404 永远不透传（渠道声明过期 → 该切）', fn(404, false) === false && fn(404, true) === false);
      check('401/402/403/408/429 一样属于渠道侧 → 必切',
        [401, 402, 403, 408, 429].every((s) => fn(s, false) === false && fn(s, true) === false));
      check('5xx / 2xx 不归它管（照旧走兜底）', fn(500, true) === false && fn(200, true) === false);
      check('装配守卫：5 处 4xx 判据都走同一个函数（不再各写一份 includes 名单）',
        (src.match(/shouldPassThrough4xx\((resp|out|call)\.status/g) || []).length === 5, (src.match(/shouldPassThrough4xx\(/g) || []).length);
      check('装配守卫：渠道侧状态码名单只出现在这个函数里（1 处）',
        (src.match(/\[401, 402, 403, 404, 408, 429\]/g) || []).length === 1);
      check('★ 装配守卫："还有候选"必须排除冷却中的候选（回归：下标判法会兜出 502）',
        /some\(\(x\) => !\(x\.cooldownUntil > Date\.now\(\)\)\)/.test(src));
    }

    console.log('\n1. ★ 真机场景：排第一的渠道给 404（声明了过期模型）→ 必须兜到第二家');
    reset(404, 0, 0); await restart('abc');
    let r = await call();
    check('★ 客户端拿到 200（不是那家的 404）', r.status === 200, { status: r.status, text: r.text.slice(0, 120) });
    check('★ 落点是兜底渠道 up-b', r.ch === 'up-b', r.ch);
    check('先试了 A（它才是 404 的来源）', UA.chat === 1, { a: UA.chat });
    check('B 成了就没再打扰 C', UC.chat === 0, { c: UC.chat });

    console.log('\n2. ★ 新增行为：排第一的渠道给 400（参数方言不同）→ 也要兜到第二家');
    reset(400, 0, 0); await restart('abc');
    r = await call();
    check('★ 客户端拿到 200（400 不再被当成"客户端的错"而短路）', r.status === 200, { status: r.status, text: r.text.slice(0, 120) });
    check('★ 落点是 up-b', r.ch === 'up-b', r.ch);

    console.log('\n3. ★ 连吃两个 400 也继续切：第三家能成就必须给客户端 200');
    reset(400, 400, 0); await restart('abc');
    r = await call();
    check('★ 客户端拿到 200（同品牌中转的参数方言一致也不会提前收手）', r.status === 200, { status: r.status, text: r.text.slice(0, 120) });
    check('★ 落点是 up-c', r.ch === 'up-c', r.ch);
    check('A、B 各被试过一次', UA.chat === 1 && UB.chat === 1, { a: UA.chat, b: UB.chat });

    console.log('\n4. 全链都是 400（真·客户端的错）→ 走完链后原样透传 400，绝不是 502');
    reset(400, 400, 400); await restart('abc');
    r = await call();
    check('★ 客户端拿到上游的 400（不是网关 502 gateway_error）', r.status === 400, { status: r.status, text: r.text.slice(0, 160) });
    check('错误体是上游原文（含上游 message，便于定位）', /upstream [ABC] says 400/.test(r.text), r.text.slice(0, 160));
    check('透传的是**最后一家**（C）的错误体 —— 客户端看到的仍是上游真实答复', /upstream C says 400/.test(r.text), r.text.slice(0, 160));
    check('代价如实记录：三家都被试过（这就是"还有候选就继续切"的价格）',
      UA.chat === 1 && UB.chat === 1 && UC.chat === 1, { a: UA.chat, b: UB.chat, c: UC.chat });

    console.log('\n5. ★ 回归反例：兜底位那家在冷却 → 不算"还有后续候选"，400 不能被兜成 502');
    reset(400, 0, 0); await restart('ab');
    r = await call();
    check('第 1 发：A 400 → 兜到 B（200）', r.status === 200 && r.ch === 'up-b', { status: r.status, ch: r.ch });
    check('A 因为这次 400 进了冷却（recordFailure 的真实后果）',
      /HTTP 400/.test(String((await admin('/admin/api/status')).channels.find((c) => c.id === 'up-a').lastError || '')));
    const aChatAfterFirst = UA.chat;
    UB.status = 400;                       // 现在 A 冷却中、B 回 400 → B 就是"最后一个能上场的候选"
    r = await call();
    check('★ 第 2 发：客户端拿到 B 的 400（判据说"没人可切了"），而不是 502', r.status === 400, { status: r.status, text: r.text.slice(0, 160) });
    check('冷却中的 A 确实没被再打', UA.chat === aChatAfterFirst, { before: aChatAfterFirst, after: UA.chat });

    console.log('\n6. 只有一个候选 + 400 → 原样透传（客户端的错语义不变）');
    reset(400, 0, 0); await restart('a');
    r = await call();
    check('★ 单候选时 400 原样回给客户端', r.status === 400, { status: r.status, text: r.text.slice(0, 120) });
    check('只打了 A（没有"再切一家"这回事）', UA.chat === 1, { a: UA.chat });

    console.log('\n7. 401 / 429 仍属渠道侧 → 必切（不受新逻辑影响）');
    reset(401, 0, 0); await restart('abc');
    r = await call();
    check('★ 首候选 401 → 兜底到 up-b（拿到 200）', r.status === 200 && r.ch === 'up-b', { status: r.status, ch: r.ch });
    reset(429, 0, 0); await restart('abc');
    r = await call();
    check('★ 首候选 429 → 兜底到 up-b', r.status === 200 && r.ch === 'up-b', { status: r.status, ch: r.ch });

    console.log('\n8. 失败照旧记进渠道状态（兜底成功不代表"这家没坏"）');
    reset(400, 0, 0); await restart('abc');
    await call();
    const st = await admin('/admin/api/status');
    const ca = st.channels.find((c) => c.id === 'up-a');
    check('★ up-a 的 lastError 记着上游 400', /HTTP 400/.test(String(ca.lastError || '')), ca.lastError);
    check('up-a 的 consecutiveFail 已经累加', ca.consecutiveFail >= 1, ca.consecutiveFail);
    check('兜底成功的 up-b 状态是 ok', st.channels.find((c) => c.id === 'up-b').status === 'ok');
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopChild(gw);
    try { upA.close(); upB.close(); upC.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不 process.exit()：见 stopChild 注释
})();
