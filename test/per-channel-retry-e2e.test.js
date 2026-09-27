#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/per-channel-retry-e2e.test.js — 「同渠道重试（perChannel）」端到端回归
 *                                                        （真起进程，零依赖）
 *
 * 背景：config.retries.perChannel 从 v1.0 起就写在配置示例里，但**从未接线**——
 * server.js 第 251 行读进 RETRIES 之后再无任何引用（真正生效的只有 maxModelFallbacks）。
 * 一个看起来能用的旋钮其实什么都不做，比没有这个旋钮更糟：用户以为瞬时故障会被重试，
 * 实际上第一次 5xx 就直接换下一家了。
 *
 * 本轮把它做成真的，语义钉死三条（见 server.js 的 PER_CHANNEL_RETRIES / isRetryableFailure）：
 *   · perChannel = **同一个渠道**失败后原地再试几次，试完才换下一家（1 → 失败后原地重试 1 次）；
 *   · 只重试"可重试的失败"（5xx / 网络错误 / 超时）；4xx 一律不重试——重发同一个请求只会
 *     再收一次同样的拒绝，其中不少还是客户端自己的参数错，重试纯属给上游添负载；
 *   · 每次尝试各记一次失败（recordFailure 在 tryChannel 内部），连败计数与指数退避按
 *     **真实尝试次数**增长，不被打折。
 * 另外：配置里没有这个键时默认为 **0**（不重试），也就是接线前的行为——接线不该偷偷改
 * 掉所有老配置的调度行为。上限钳到 5，写错数字不该把上游调用量放大十倍。
 *
 * 未覆盖（由 streaming-e2e 守着）：已经开始向客户端写 chunk 之后的失败不再重试——那属于
 * "半截回复"，dispatchRequest 在 headersSent 时直接收尾返回，压根走不到重试分支。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/per-channel-retry-e2e.test.js   （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-retry-e2e-'));
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

/* 假上游：
     state.status     — 失败时用的状态码（0/200 = 从不失败）
     state.failFirst  — 前 N 次对话请求失败，第 N+1 次起成功（用来模拟"抖一下就好了"）
     state.chat       — 只统计**对话请求**（/models 探测不算账：健康探测启动时会打一发，
                        混进来会让"这家被尝试了几次"这种断言莫名其妙地多 1） */
function makeUpstream(state) {
  return http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      if (req.method === 'GET' && /models/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-retry' }] }));
      }
      state.chat++;
      const failing = state.status && state.status !== 200 && (state.failFirst === undefined || state.chat <= state.failFirst);
      if (failing) {
        res.writeHead(state.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `upstream ${state.tag} attempt#${state.chat} says ${state.status}`, type: 'upstream_error' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: `ok-${state.tag}-attempt#${state.chat}` } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
  });
}

(async () => {
  const UA = { tag: 'A', status: 0, failFirst: undefined, chat: 0 };
  const UB = { tag: 'B', status: 0, failFirst: undefined, chat: 0 };
  const upA = makeUpstream(UA), upB = makeUpstream(UB);
  const PA = await freePort(), PB = await freePort(), GW = await freePort();
  await new Promise((r) => upA.listen(PA, '127.0.0.1', r));
  await new Promise((r) => upB.listen(PB, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'retry.json');
  /* perChannel 显式写进配置（包括 0——默认值就是 0，这里写出来是为了让"默认即不重试"可读） */
  const writeCfg = (perChannel, only) => {
    const all = {
      a: { id: 'pc-a', name: 'A', protocol: 'openai', baseUrl: `http://127.0.0.1:${PA}/v1`, apiKey: 'sk-a', priority: 30, enabled: true, models: { 'mock-retry': 'mock-retry' } },
      b: { id: 'pc-b', name: 'B', protocol: 'openai', baseUrl: `http://127.0.0.1:${PB}/v1`, apiKey: 'sk-b', priority: 20, enabled: true, models: { 'mock-retry': 'mock-retry' } },
    };
    fs.writeFileSync(cfgPath, JSON.stringify({
      port: GW,
      health: { intervalSec: 3600, timeoutMs: 3000 },
      retries: perChannel === undefined ? { maxModelFallbacks: 99 } : { perChannel, maxModelFallbacks: 99 },
      channels: only.split('').map((k) => all[k]),
    }));
  };
  const reset = (aStatus, aFailFirst) => {
    UA.status = aStatus; UA.failFirst = aFailFirst; UA.chat = 0;
    UB.status = 0; UB.failFirst = undefined; UB.chat = 0;
  };

  let gw = null, usageN = 0;
  /* 每个场景都起一个**全新**网关：上游一次失败就会给自己置冷却（recordFailure），
     且 PER_CHANNEL_RETRIES 是**配置加载期**的常量——跨场景复用既会带进冷却，也换不了旋钮。 */
  const restart = async (perChannel, only = 'ab') => {
    writeCfg(perChannel, only);
    await stopChild(gw);
    gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, `usage-${++usageN}.json`), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
      stdio: 'ignore',
    });
    if (!await waitUp()) throw new Error('临时网关未起来（perChannel=' + perChannel + ', only=' + only + '）');
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
      body: JSON.stringify({ model: 'mock-retry', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await r.text();
    return { status: r.status, ch: r.headers.get('X-ZZCSAPI-Channel'), text };
  };
  const admin = async (p) => (await fetch(`http://127.0.0.1:${GW}${p}`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).json();

  try {
    console.log('\n0. 判据单测：从 server.js 现抠 isRetryableFailure / 钳制公式 + 装配守卫');
    {
      const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
      const grab = (needle) => {
        const at = src.indexOf(needle);
        if (at < 0) throw new Error('server.js 里找不到 ' + needle);
        let depth = 0, end = -1;
        for (let k = src.indexOf('{', at); k < src.length; k++) {
          if (src[k] === '{') depth++;
          else if (src[k] === '}') { depth--; if (!depth) { end = k + 1; break; } }
        }
        return src.slice(at, end);
      };
      const retryable = new Function('return (' + grab('function isRetryableFailure') + ')')();
      check('★ 4xx 的标记 channel_error → 不重试（重发同一个请求只会再收一次同样的拒绝）',
        retryable('channel_error') === false);
      check('终态 success / fatal_client 不会被当成"值得重试"',
        retryable('success') === false && retryable('fatal_client') === false);
      check('★ 5xx / 网络错误 / 超时 → 值得原地重试',
        retryable('upstream 500: boom') === true && retryable('network: ECONNRESET') === true
        && retryable('upstream 503: unavailable') === true && retryable('codex stream: timeout') === true);
      check('其它异常（undefined 之类）按可重试处理，不吞掉', retryable(undefined) === true);

      const m = src.match(/const PER_CHANNEL_RETRIES = ([^;]+);/);
      if (!m) throw new Error('server.js 里找不到 PER_CHANNEL_RETRIES');
      /* 直接把公式搬进一个临时函数里跑：参数就叫 RETRIES，源码里的 RETRIES.perChannel 自然解析到它
         ——不在测试里维护第二份钳制实现 */
      const clamp = new Function('RETRIES', 'return ' + m[1] + ';');
      const pc = (v) => clamp({ perChannel: v });
      check('★ perChannel = 0 → 0（不重试）', pc(0) === 0);
      check('★ perChannel = 1 → 1（失败后原地再试一次）', pc(1) === 1);
      check('★ perChannel = 99 → 钳到 5（配置写错不该把上游调用量放大十倍）', pc(99) === 5);
      check('负数 / 非数字 / 小数都被收拾干净', pc(-3) === 0 && pc('abc') === 0 && pc(2.7) === 2);
      check('★ 默认值就是 0：配置里没有这个键时退回"不重试"（接线不偷改老配置的行为）',
        /const RETRIES = config\.retries \|\| \{ perChannel: 0,/.test(src));

      check('装配守卫：5 处 4xx 判据都标注了 channel_error（原生 4 家 + OpenAI 主路径）',
        (src.match(/return 'channel_error'/g) || []).length === 5, (src.match(/return 'channel_error'/g) || []).length);
      /* 只数**代码**里的读取：注释里提一句 RETRIES.perChannel 是说明，不算散落的第二份实现。
         （按"整行以 // 开头"过滤，比正则去行尾注释稳——这行里就有 `**` 和方括号，别再玩正则了） */
      const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      check('装配守卫：perChannel 只经由钳制常量读取（代码里不许散落着直接读 RETRIES.perChannel）',
        (code.match(/RETRIES\.perChannel/g) || []).length === 1, (code.match(/RETRIES\.perChannel/g) || []).length);
      check('★ 装配守卫：重试循环真的以 isRetryableFailure + 次数上限为出口',
        /isRetryableFailure\(result\)/.test(src) && /attempt >= PER_CHANNEL_RETRIES/.test(src));
      check('装配守卫：第几次尝试要传给 tryChannel（否则上游侧无法分辨重试）', /^\s+attempt,$/m.test(src));
    }

    console.log('\n1. ★ perChannel=1：上游抖一下（第 1 次 500、第 2 次成功）→ 原地重试救回，根本不换下家');
    reset(500, 1); await restart(1);
    let r = await call();
    check('★ 客户端拿到 200', r.status === 200, { status: r.status, text: r.text.slice(0, 140) });
    check('★ 落点仍是 pc-a（这次是人类想要的"自己家重试"，不是切出去）', r.ch === 'pc-a', r.ch);
    check('★ A 被尝试了 2 次（1 次原始 + 1 次重试）', UA.chat === 2, { a: UA.chat });
    check('★ B 一次都没被打扰', UB.chat === 0, { b: UB.chat });
    {
      const ca = (await admin('/admin/api/status')).channels.find((c) => c.id === 'pc-a');
      check('★ 重试成功后连败计数被清零（重试是真的成功，不是"记着坏账继续用"）',
        ca.consecutiveFail === 0 && ca.cooldownUntil === 0, { consecutiveFail: ca.consecutiveFail, cooldownUntil: ca.cooldownUntil });
    }

    console.log('\n2. perChannel=1：上游一直 500 → 原地试满才换下家，且每次尝试各记一次失败');
    reset(500, 99); await restart(1);
    r = await call();
    check('★ 客户端仍拿到 200（兜底到 B）', r.status === 200 && r.ch === 'pc-b', { status: r.status, ch: r.ch });
    check('★ A 恰好被尝试 2 次（1 + perChannel），不是只 1 次也不是无限次', UA.chat === 2, { a: UA.chat });
    check('B 被尝试 1 次', UB.chat === 1, { b: UB.chat });
    {
      const ca = (await admin('/admin/api/status')).channels.find((c) => c.id === 'pc-a');
      check('★ 连败计数 = 2（每次尝试都各记一次，退避按真实尝试次数增长）',
        ca.consecutiveFail === 2, { consecutiveFail: ca.consecutiveFail });
      check('lastError 记着上游 500', /500/.test(String(ca.lastError || '')), ca.lastError);
      check('没到 3 次所以还没被打成 down（阈值语义未被改动）', ca.status !== 'down', ca.status);
    }

    console.log('\n3. ★ perChannel=1：上游回 4xx → 不许重试（重发同一个 400 毫无意义）');
    reset(400, 99); await restart(1);
    r = await call();
    check('★ 客户端拿到 200（4xx 仍按"这家不行"继续切）', r.status === 200 && r.ch === 'pc-b', { status: r.status, ch: r.ch });
    check('★ A 只被打了 1 次（4xx 不重试）', UA.chat === 1, { a: UA.chat });

    console.log('\n4. perChannel=0：退回接线前的行为（第 1 次 500 就直接换下家）');
    reset(500, 1); await restart(0);
    r = await call();
    check('★ 客户端拿到 200（由 B 兜底）', r.status === 200 && r.ch === 'pc-b', { status: r.status, ch: r.ch });
    check('★ A 只被尝试 1 次（0 = 不重试，与本功能上线前一致）', UA.chat === 1, { a: UA.chat });

    console.log('\n5. perChannel 缺失（配置里根本没写这个键）→ 默认 0，不重试');
    reset(500, 1); await restart(undefined);
    r = await call();
    check('★ 键缺失时不重试：A 只 1 次、客户端由 B 兜到 200',
      UA.chat === 1 && r.status === 200 && r.ch === 'pc-b', { a: UA.chat, status: r.status, ch: r.ch });

    console.log('\n6. perChannel=99 被钳到 5：一直 500 时最多试 6 次（1 + 5）就收手');
    reset(500, 99); await restart(99);
    r = await call();
    check('★ A 恰好被尝试 6 次', UA.chat === 6, { a: UA.chat });
    check('★ 客户端仍拿到 200（试满后照常切 B）', r.status === 200 && r.ch === 'pc-b', { status: r.status, ch: r.ch });

    console.log('\n7. 单候选 + 一直 500：试满后没有下家 → 502，且 attempts 里能看到重试痕迹');
    reset(500, 99); await restart(1, 'a');
    r = await call();
    check('★ 客户端拿到 502（5xx 走的是兜底失败语义，不是 4xx 透传）', r.status === 502, { status: r.status, text: r.text.slice(0, 140) });
    check('★ 502 载荷里带着 attempt=1（重试过的证据，便于事后定位）', /"attempt":1/.test(r.text), r.text.slice(0, 200));
    check('★ A 被尝试 2 次（单候选也不改变"原地重试"的行为）', UA.chat === 2, { a: UA.chat });
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopChild(gw);
    try { upA.close(); upB.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不 process.exit()：见 stopChild 注释
})();
