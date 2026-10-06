#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/channel-test-stream-and-streak-e2e.test.js
 *   ① 手动测试的**流式模式** + ② **真实流量单独一条 streak**（v1.18.40，真起进程，零依赖）
 *
 * 现场（用户点出来的两个真问题）：
 *   ① `/admin/api/test` 只发**非流式**请求，而真实客户端（DSH 等）一律走流式 ——
 *      上游完全可以"非流式答得好好的、流式那条路是坏的"（200 + 流内 error 帧 / 200 + 零正文流 /
 *      干脆无视 stream 参数回一整个 JSON）。测试与真实流量各写一套判据，就是"测试过、真实挂"的温床。
 *   ② 熔断跳开的唯一机制是 `cooldownUntil`，冷却时长按 streak 指数退避。可"GET /models 探测成功"
 *      和"手动测试成功"**都不是**"这家对话能用"的证据 —— 它们却会把真实流量的欠账减半、甚至清零，
 *      于是一个"测试过、真实挂"的死家，每被点一次测试就重新从 1× 退避起步，**永远熔断不掉**。
 *
 * 覆盖：
 *   §1 判据单测：`classifyStreamFrame`（真实链路与手动测试**共用**的帧分类）真值表
 *   §2 装配守卫：共用同一份帧分类 / stream 真的进了报文 / 测试成功不许清零真实流量欠账 / 两条 streak 的唯一实现
 *   §3 真链路（假上游 + 临时网关）：
 *        ★ ① 的核心断言——同一个渠道「非流式测试通过、流式测试失败」
 *        流式正常 / 流内 error 帧 / 零正文流 / 上游无视 stream 回 JSON / 只有思考吃光预算
 *        ★ ② 的核心断言——真实流量欠 2 笔 → 手动测试成功**不清零** → 真实成功才清零；
 *           GET /models 探测成功同样不清零；测试失败只记 probeFail
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/channel-test-stream-and-streak-e2e.test.js     （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-stream-streak-'));
const GW_KEY = 'e2e-gw', AD_KEY = 'e2e-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/* ── 假上游 ──────────────────────────────────────────────────────────────
 * 按 apiKey 决定形态；`flip` 渠道的形态由 FLIP.mode 在运行期翻转（用来造"先挂后好"的现场）。
 * 关键设计：**同一个 key 在 stream / 非 stream 下可以给出不同质量的回答** ——
 * 这正是"非流式测试通过、真实流式流量挂"的现场复刻。 */
const FLIP = { mode: 'ok' };
const seen = [];
const sse = (res, frames) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const f of frames) res.write('data: ' + JSON.stringify(f) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
};
const jchunk = (delta, extra) => ({ id: 'c', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta, ...(extra || {}) }] });
const upstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
    const auth = String(req.headers.authorization || '').replace('Bearer ', '');
    const raw = Buffer.concat(cs).toString('utf8');
    if (req.method === 'GET' && /models/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    }
    let body = {}; try { body = JSON.parse(raw); } catch { }
    const key = auth.includes('sk-flip') ? ('sk-flip:' + FLIP.mode) : auth;
    seen.push({ key, stream: body.stream === true, url: req.url, model: body.model });
    const json = (payload, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    const okJson = () => json({ id: 'c', object: 'chat.completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } });

    // ★ 现场复刻：非流式一切正常；流式那条路是坏的（零正文流）
    if (key === 'sk-stream-empty') {
      if (!body.stream) return okJson();
      return sse(res, [jchunk({ role: 'assistant' }), { id: 'c', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 0, total_tokens: 9 } }]);
    }
    // 流式正常
    if (key === 'sk-stream-ok') {
      if (!body.stream) return okJson();
      return sse(res, [jchunk({ role: 'assistant' }), jchunk({ content: 'o' }), jchunk({ content: 'k' }), { id: 'c', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }]);
    }
    // 流里塞错误帧
    if (key === 'sk-stream-err') {
      if (!body.stream) return okJson();
      return sse(res, [jchunk({ role: 'assistant' }), { error: { message: 'upstream stream blew up' } }]);
    }
    // 无视 stream=true，回整段 JSON（真实流式客户端会拿到零正文流）
    if (key === 'sk-stream-ignore') return okJson();
    // 只有思考，且 finish=length（真实链路按 v1.18.28 判失败）
    if (key === 'sk-stream-reason') {
      if (!body.stream) return okJson();
      return sse(res, [jchunk({ role: 'assistant' }), jchunk({ reasoning_content: '让我想想……' }), { id: 'c', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }]);
    }
    // 运行期可翻转的家：'ok' 正常 / '500' 上游故障
    if (auth.includes('sk-flip')) {
      if (FLIP.mode === '500') return json({ error: { message: 'upstream exploded' } }, 500);
      if (!body.stream) return okJson();
      return sse(res, [jchunk({ role: 'assistant' }), jchunk({ content: 'ok' }), { id: 'c', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]);
    }
    return okJson();
  });
});

function startGateway(cfgPath, port) {
  return spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
    stdio: 'ignore',
  });
}
async function waitUp(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true; } catch { }
    await sleep(200);
  }
  return false;
}

/* ── §1 判据单测：从 server.js 现抠帧分类 ─────────────────────────────── */
function unitTests() {
  console.log('\n1. 判据单测：classifyStreamFrame（真实链路与手动测试共用的帧分类）');
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const grabFn = (needle) => {
    const at = src.indexOf(needle);
    if (at < 0) throw new Error('server.js 里找不到 ' + needle);
    let depth = 0, end = -1;
    for (let k = src.indexOf('{', at); k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (!depth) { end = k + 1; break; } }
    }
    return src.slice(at, end);
  };
  const F = new Function(grabFn('function openaiUsageFromFrame') + ';' + grabFn('function classifyStreamFrame') + ';return classifyStreamFrame;')();
  const C = (j) => F(j);

  check('★ 错误帧：有 error 且无 choices → error 有原文',
    C({ error: { message: 'boom' } }).error === 'boom');
  check('错误帧：error 是字符串也能取到', C({ error: 'plain boom' }).error === 'plain boom');
  check('★ role-only 开场帧**不算正文**（旧写法用正则判 role，会把它误判成正文、错误帧就拦不住了）',
    C({ choices: [{ delta: { role: 'assistant' } }] }).content === false);
  check('★ 正文帧：delta.content 有内容 → visibleText + content',
    C({ choices: [{ delta: { content: 'hi' } }] }).visibleText === true && C({ choices: [{ delta: { content: 'hi' } }] }).content === true);
  check('空串 / 空数组 / 空对象都不算正文',
    C({ choices: [{ delta: { content: '' } }] }).content === false
    && C({ choices: [{ delta: { tool_calls: [] } }] }).content === false
    && C({ choices: [{ delta: { extra: {} } }] }).content === false);
  check('★ 思考帧：reasoning_content / reasoning 都认，且不冒充可见正文',
    C({ choices: [{ delta: { reasoning_content: '想' } }] }).reasoning === true
    && C({ choices: [{ delta: { reasoning_content: '想' } }] }).visibleText === false
    && C({ choices: [{ delta: { reasoning: '想' } }] }).reasoning === true);
  check('★ 工具调用帧：toolCall 置位（工具轮可以没有正文，不能误判成空回复）',
    C({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1' }] } }] }).toolCall === true);
  check('finish_reason 被抓到（判"思考吃光预算"要用）',
    C({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }).finish === 'length');
  check('★ usage 帧（末帧、delta 为空）也能抓到 —— 早退吞掉它就只剩我们自己的估算',
    (C({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 9, completion_tokens: 114, total_tokens: 123 } }).usage || {}).completion_tokens === 114);
  check('全 0 的 usage 帧不覆盖已有累计', C({ usage: { prompt_tokens: 0, completion_tokens: 0 } }).usage === null);
  check('★ 原生形态（直通）：content_block_delta / candidates / 裸 delta 都算正文',
    C({ type: 'content_block_delta', delta: { text: 'x' } }).content === true
    && C({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }).content === true
    && C({ delta: 'raw' }).content === true);
  check('垃圾输入不炸（null / 字符串 / 数组）',
    C(null).content === false && C('x').content === false && C([1]).content === false);
}

/* ── §2 装配守卫 ─────────────────────────────────────────────────────── */
function assemblyGuards() {
  console.log('\n2. 装配守卫');
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('★ 帧分类只有一份实现（谁都不许再抄第二份）',
    (src.match(/function classifyStreamFrame\(/g) || []).length === 1);
  check('★ 真实链路与手动测试**共用**同一份帧分类',
    /const noteStreamLine = \(line\) => \{[\s\S]{0,600}?classifyStreamFrame\(j\)/.test(src)
    && /function judgeStreamTest\(rawText, proto\) \{[\s\S]{0,900}?classifyStreamFrame\(j\)/.test(src));
  const testAt = src.indexOf("req.method === 'POST' && url.pathname === '/admin/api/test'");
  const testEnd = src.indexOf("req.method === 'DELETE' && url.pathname === '/admin/api/channels'");
  const testBody = src.slice(testAt, testEnd);
  check('★ ① 流式模式真的读了 body.stream === true', /const wantStream = body\.stream === true;/.test(testBody));
  check('★ ① 流式真的发进报文（openai/anthropic 的 stream:true）',
    /\.\.\.\(wantStream \? \{ stream: true \} : \{\}\)/.test(testBody)
    && (testBody.match(/\.\.\.\(wantStream \? \{ stream: true \} : \{\}\)/g) || []).length === 2);
  check('★ ① gemini 流式走 streamGenerateContent?alt=sse（不是 generateContent）',
    /wantStream \? ':streamGenerateContent\?alt=sse' : ':generateContent'/.test(testBody));
  check('★ ① 流式判据用的是与真实链路共用的 judgeStreamTest', /judgeStreamTest\(text, ch\.def\.protocol/.test(testBody));
  check('★ ① 流式失败要记账（source:test，只记 probeFail）',
    /recordFailure\(ch, 'test stream: ' \+ streamFail, undefined, \{ source: 'test' \}\)/.test(testBody));
  check('★ ② 手动测试成功**不许**走真实流量的清零入口（markTrafficOk 在测试分支里一次都不许出现）',
    !/markTrafficOk/.test(testBody));
  check('★ ② 手动测试成功走半愈合（healAfterProbe(ch, true, false)）',
    (testBody.match(/healAfterProbe\(ch, true, false\)/g) || []).length >= 5
    && /healAfterProbe\(target, true, false\)/.test(src));
  check('★ ② 真实流量成功只有 markTrafficOk 一处清零入口',
    (src.match(/ch\.consecutiveFail = 0;/g) || []).length === 1
    && /function markTrafficOk\(ch, ms\) \{[\s\S]{0,200}?ch\.consecutiveFail = 0;/.test(src));
  check('★ ② 冷却分级读的是两条 streak 的较大者（effFailStreak 唯一实现，cooldownMsFor 里不许再直读 consecutiveFail）',
    (src.match(/function effFailStreak\(ch\)/g) || []).length === 1
    && /function cooldownMsFor\(ch, kind, retryAfterMs\) \{\s*const n = Math\.max\(1, effFailStreak\(ch\) \|\| 1\);/.test(src));
  check('★ ② 探测/测试失败分别标了来源（probe ≥6 处、test ≥5 处）',
    (src.match(/source: 'probe'/g) || []).length >= 6 && (src.match(/source: 'test'/g) || []).length >= 5);
  check('② 状态接口下发了 probeFail（控制台才分得清两条欠账）',
    /consecutiveFail: ch\.consecutiveFail,[\s\S]{0,300}?probeFail: Number\(ch\.probeFail\) \|\| 0,/.test(src));
}

/* ── §3 真链路 ───────────────────────────────────────────────────────── */
(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const port = await freePort();
  const cfg = path.join(TMP, 'cfg.json');
  const ch = (id, key, model) => ({ id, name: id, protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: key, enabled: true, priority: 10, models: { [model]: 'mock' } });
  fs.writeFileSync(cfg, JSON.stringify({
    port, health: { intervalSec: 3600, timeoutMs: 3000 },
    // 瞬时故障的冷却压到下限（1s）：这样"连挂两次"能真的落在同一个渠道上（否则第二发会被冷却跳开，
    // 欠账只涨 1 —— 那不是我们要验的语义）
    cooldown: { transientBaseMs: 1000, transientMaxMs: 5000 },
    channels: [
      ch('s-empty', 'sk-stream-empty', 'm-empty'),
      ch('s-ok', 'sk-stream-ok', 'm-ok'),
      ch('s-err', 'sk-stream-err', 'm-err'),
      ch('s-ignore', 'sk-stream-ignore', 'm-ignore'),
      ch('s-reason', 'sk-stream-reason', 'm-reason'),
      ch('flip', 'sk-flip', 'm-flip'),
    ],
  }));
  const gw = startGateway(cfg, port);
  const admin = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AD_KEY };
  const runTest = async (channelId, stream) => {
    const r = await fetch(`http://127.0.0.1:${port}/admin/api/test`, {
      method: 'POST', headers: admin,
      body: JSON.stringify({ model: 'm', channelId, prompt: 'Reply with "ok".', ...(stream ? { stream: true } : {}) }),
    });
    const j = await r.json();
    return (j.results || [])[0] || {};
  };
  const chan = async (id) => ((await (await fetch(`http://127.0.0.1:${port}/admin/api/status`, { headers: admin })).json()).channels || []).find((c) => c.id === id);
  const traffic = async (model) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    return { status: r.status, ch: r.headers.get('X-ZZCSAPI-Channel'), text: await r.text() };
  };
  try {
    check('网关启动', await waitUp(port));
    unitTests();
    assemblyGuards();

    console.log('\n3. ★① 流式模式：同一个渠道「非流式过、流式挂」必须被抓出来');
    const nonStream = await runTest('s-empty', false);
    const streamed = await runTest('s-empty', true);
    check('非流式测试：这个渠道**通过**（旧行为只测到这里 → 控制台一片绿）',
      nonStream.ok === true && nonStream.reply === 'ok', { r: nonStream });
    check('★★ 流式测试：同一个渠道**不过**，并说清是"stream 零正文"',
      streamed.ok === false && /stream 零正文/.test(String(streamed.error || '')), { r: streamed });
    check('★ 流式结论带回 stream / streamFrames（控制台看得出这是流式判的）',
      streamed.stream === true && Number(streamed.streamFrames) >= 1, { r: streamed });
    const sentStream = seen.filter((s) => s.key === 'sk-stream-empty').pop() || {};
    check('★ 上游**真的**收到了 stream:true（不是我们嘴上说流式）', sentStream.stream === true, sentStream);

    console.log('\n4. 流式的其余四种形态');
    const rOk = await runTest('s-ok', true);
    check('流式正常：ok:true 且正文由 delta 拼成 "ok"', rOk.ok === true && rOk.reply === 'ok', { r: rOk });
    const rErr = await runTest('s-err', true);
    check('★ 流内 error 帧：判失败并写明 stream error frame',
      rErr.ok === false && /stream error frame/.test(String(rErr.error || '')), { r: rErr });
    const rIgnore = await runTest('s-ignore', true);
    check('★ 上游无视 stream、回整段 JSON：判失败（真实流式客户端会拿到零正文流）+ 标 streamIgnored',
      rIgnore.ok === false && rIgnore.streamIgnored === true && /无视 stream/.test(String(rIgnore.error || '')), { r: rIgnore });
    const rReason = await runTest('s-reason', true);
    check('★ 只有思考且 finish=length：流式模式判**失败**（按真实链路 v1.18.28），并说明"思考吃光预算"',
      rReason.ok === false && /思考吃光预算/.test(String(rReason.error || '')), { r: rReason });
    check('对照：同一家的**非流式**测试仍判可用（v1.18.29 的宽容只留给非流式模式）',
      (await runTest('s-reason', false)).ok === true);

    console.log('\n5. ★② 真实流量的欠账不许被"测试成功/探测成功"抹掉');
    FLIP.mode = '500';
    const t1 = await traffic('m-flip');
    await sleep(1200);                                  // 等 1s 冷却过期，让第二发也真的落到这家（否则会被跳开）
    const t2 = await traffic('m-flip');
    check('前置：真实流量连挂 2 次（两发都失败）', t1.status >= 400 && t2.status >= 400, { t1: t1.status, t2: t2.status });
    let cf = await chan('flip');
    check('★ 真实流量欠账 = 2（consecutiveFail）', cf.consecutiveFail === 2, { consecutiveFail: cf.consecutiveFail });
    check('★ 冷却已武装（熔断跳开死家靠的就是它）', cf.cooldownUntil > Date.now(), cf.cooldownUntil);

    FLIP.mode = 'ok';
    const okTest = await runTest('flip', true);
    check('手动测试（流式）通过', okTest.ok === true && okTest.reply === 'ok', { r: okTest });
    cf = await chan('flip');
    check('★★ 测试成功**没有**清零真实流量的欠账（仍是 2 —— 这就是"熔断真的会跳开死家"的前提）',
      cf.consecutiveFail === 2, { consecutiveFail: cf.consecutiveFail, probeFail: cf.probeFail });
    check('★ 但探测侧的账被还清了（probeFail 回 0）', (cf.probeFail || 0) === 0, cf.probeFail);
    check('★ 冷却被放开（修好的渠道立刻有机会再上场，不必等满 6 小时）', !(cf.cooldownUntil > Date.now()), cf.cooldownUntil);
    check('★ 状态进观察期而不是 ok（测试证明不了"真实流量能成"）', cf.probation === true && cf.status === 'degraded', { p: cf.probation, s: cf.status });

    const rc = await fetch(`http://127.0.0.1:${port}/admin/recheck`, { method: 'POST', headers: admin });
    check('/admin/recheck 正常返回', rc.status === 200);
    cf = await chan('flip');
    check('★★ GET /models 探测成功**也不许**清掉真实流量的欠账（仍是 2）',
      cf.consecutiveFail === 2, { consecutiveFail: cf.consecutiveFail });

    const t3 = await traffic('m-flip');
    check('★ 真实流量成功 → 欠账彻底清零', t3.status === 200 && t3.ch === 'flip', { t3: { s: t3.status, ch: t3.ch } });
    cf = await chan('flip');
    check('★ 只有真实成功才清零：consecutiveFail = 0 且出观察期', cf.consecutiveFail === 0 && !cf.probation, { c: cf.consecutiveFail, p: cf.probation });

    console.log('\n6. 测试**失败**只记探测侧的账（不许污染真实流量那条 streak）');
    FLIP.mode = '500';
    const badTest = await runTest('flip', false);
    cf = await chan('flip');
    check('测试失败：如实报失败', badTest.ok === false, { r: badTest });
    check('★ 探测侧欠账 +1（probeFail ≥ 1）', (cf.probeFail || 0) >= 1, cf.probeFail);
    check('★ 真实流量那条 streak 纹丝不动（仍是 0 —— 手动点一下测试不该让真实流量背锅）',
      cf.consecutiveFail === 0, { consecutiveFail: cf.consecutiveFail, probeFail: cf.probeFail });
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally { gw.kill('SIGKILL'); }
  upstream.close();
  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  // 收尾纪律：不用硬 process.exit —— kill 子进程与 close 假上游会和 Windows 上的 libuv 句柄关闭竞态
  // （撞断言会让退出码变成 0xC0000409，把全过的用例报成失败）。先让句柄落定，再按 exitCode 自然退出。
  process.exitCode = fail ? 1 : 0;
  await sleep(250);
})();
