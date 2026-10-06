#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/session-affinity-e2e.test.js — 会话粘性回归（v1.17，真起进程，零依赖）
 *
 * 守的是什么：**同一条会话上的请求落在同一个上游渠道**（上游提示缓存/KV cache 复用、
 * 订阅号不被来回换家触发风控），同时**不许悄悄变成"绕过加权轮询"**。
 *
 * 覆盖：
 *   · 装配守卫：粘性只在 dispatchRequest 里改顺序、成功时才 learn、四处聊天路由都传了键、
 *     persistConfig 白名单含 sessionAffinity、粘性代码里不许出现 SWRR_（不污染份额统计）、
 *     不许动 cooldownUntil/probation（不硬塞冷却中的渠道）；
 *   · 键推导真值表（现抠真实源码跑）：关闭时恒为空、显式头优先于正文、长度下限、
 *     prompt_cache_key/session_id 认得出、deriveFromBody 的稳定哈希与内容区分、短内容不哈希、
 *     旋钮钳制（ttlSec 下限 30s / 上限 7 天、maxEntries 下限）；
 *   · 学习/命中/过期/淘汰：命中计数、过期懒清理、表满淘汰最旧；
 *   · 排序语义：命中且可上场→提到链首；在冷却/down/不在候选里→一动不动；
 *   · 真链路：同一会话 8 次请求落同一家；上游挂掉后切到另一家并**重新粘住**；
 *     对照：关闭时表恒为空（零状态、零影响）。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/session-affinity-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-affinity-'));
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

// 现抠真实的粘性模块（从 AFFINITY_CFG 到"客户端限流"分节之前），注入 config/crypto 后取回内部函数。
// 这样断言的是**跑在真实源码里的那份逻辑**，不是测试里重写的一份。
const AFF_SRC = SRC.slice(SRC.indexOf('function normAffinityCfg('), SRC.indexOf('// ─────────────────────────── 客户端限流'));
function makeAffinity(cfg) {
  const factory = new Function('config', 'crypto', AFF_SRC + `
    return { AFFINITY_CFG, AFFINITY, AFFINITY_STAT, AFFINITY_HEADERS,
             affinityKeyFor, affinitySticky, affinityLearn, applyAffinity, affinityStatus };`);
  return factory(cfg, crypto);
}
const cand = (id, extra) => ({ channelId: id, upstream: 'm', priority: 0, weight: 0, status: 'ok', latencyMs: 5, cooldownUntil: 0, consecutiveFail: 0, probation: false, protocol: 'openai', kind: 'explicit', ...(extra || {}) });

(async () => {
  /* ─────────────────────────── 0. 装配守卫 ─────────────────────────── */
  console.log('\n0. 装配守卫（源码级：接线点存在且边界没被越界）');
  const dispIdx = SRC.indexOf('async function dispatchRequest');
  const dispBody = SRC.slice(dispIdx, SRC.indexOf('\nfunction ', dispIdx + 10));
  check('dispatchRequest 里确实调用了 applyAffinity', /applyAffinity\(candidates, opts\.affinityKey\)/.test(dispBody));
  check('粘性重排发生在 maxCand 计算之后（只影响顺序，不影响链长）',
    dispBody.indexOf('applyAffinity(candidates') > dispBody.indexOf('const maxCand'));
  check('成功路径才 learn（失败的渠道不会被粘住）', /if \(result === 'success'\) \{ affinityLearn\(opts\.affinityKey, c\.channelId\); return; \}/.test(dispBody));
  const routes = (SRC.match(/affinityKey: affinityKeyFor\(req, body\)/g) || []).length;
  check('四处聊天路由（openai/anthropic/gemini/responses）都传了粘性键', routes === 4, routes);
  check('图片路由不传粘性键（它不是会话）', !/kind: 'images'[\s\S]{0,400}affinityKey/.test(SRC));
  const affOnly = AFF_SRC;
  check('粘性代码不碰 SWRR_（份额统计不会被粘性流量污染）', !/SWRR_/.test(affOnly));
  check('粘性代码不写 cooldownUntil / probation / consecutiveFail',
    !/cooldownUntil\s*=/.test(affOnly) && !/probation\s*=/.test(affOnly) && !/consecutiveFail\s*=/.test(affOnly));
  check('粘性代码不调用 recordFailure / persistConfig', !/recordFailure\(/.test(affOnly) && !/persistConfig\(/.test(affOnly));
  check('persistConfig 白名单含 sessionAffinity（否则控制台保存渠道会把它抹掉）',
    /sessionAffinity: \(config && config\.sessionAffinity\) \|\| undefined/.test(SRC));
  check('默认关闭：AFFINITY_CFG.enabled 只有显式 true 才为真', /enabled: c\.enabled === true/.test(affOnly));

  /* ─────────────────────────── 1. 键推导真值表 ─────────────────────────── */
  console.log('\n1. 会话键推导（关闭 / 显式头 / 正文标识 / 兜底哈希 / 钳制）');
  {
    const a = makeAffinity({ sessionAffinity: { enabled: false } });
    check('关闭时：带了显式头也返回空键', a.affinityKeyFor({ headers: { 'x-session-id': 'sess-12345678' } }, {}) === '');
    check('关闭时：learn 不写表', (a.affinityLearn('k', 'ch'), a.AFFINITY.size === 0));
    const list = [cand('a'), cand('b')];
    check('关闭时：applyAffinity 原样返回（同一份数组、顺序不变）', a.applyAffinity(list, 'k') === list && list[0].channelId === 'a');
    check('关闭时：状态里 enabled=false', a.affinityStatus().enabled === false);
  }
  {
    const a = makeAffinity({ sessionAffinity: { enabled: true } });
    check('显式头 X-Session-Id（够长）→ 生成键', a.affinityKeyFor({ headers: { 'x-session-id': 'sess-12345678' } }, {}) === 'h:x-session-id:sess-12345678');
    check('显式头太短（<8 字符）→ 不当会话标识', a.affinityKeyFor({ headers: { 'x-session-id': 'abc' } }, {}) === '');
    check('四个头都认（claude-code / conversation / zzcsapi）',
      ['x-claude-code-session-id', 'x-conversation-id', 'x-zzcsapi-session'].every((h) => a.affinityKeyFor({ headers: { [h]: 'abcdefgh' } }, {}).startsWith('h:' + h + ':')));
    check('头的优先级：session-id 先于 claude-code',
      a.affinityKeyFor({ headers: { 'x-session-id': 'aaaaaaaa', 'x-claude-code-session-id': 'bbbbbbbb' } }, {}) === 'h:x-session-id:aaaaaaaa');
    check('正文 prompt_cache_key 认得出', a.affinityKeyFor({ headers: {} }, { prompt_cache_key: 'cache-abcdef' }) === 'b:pc:cache-abcdef');
    check('正文 session_id / conversation_id 认得出',
      a.affinityKeyFor({ headers: {} }, { session_id: 'sess-abcdef' }) === 'b:sid:sess-abcdef' &&
      a.affinityKeyFor({ headers: {} }, { conversation_id: 'conv-abcdef' }) === 'b:cid:conv-abcdef');
    check('头的优先级高于正文', a.affinityKeyFor({ headers: { 'x-session-id': 'hhhhhhhh' } }, { session_id: 'sess-abcdef' }) === 'h:x-session-id:hhhhhhhh');
    check('没带任何会话标识 → 空键（退回普通调度）', a.affinityKeyFor({ headers: {} }, { messages: [{ role: 'user', content: 'hi' }] }) === '');
    check('metadata.user_id 刻意不认（账号级 id，会把整个账号钉死在一家）',
      a.affinityKeyFor({ headers: {} }, { metadata: { user_id: 'user_abc123456' } }) === '');
    check('键长度被截断到 160 字符（防超长头撑爆内存表）',
      a.affinityKeyFor({ headers: { 'x-session-id': 'x'.repeat(500) } }, {}).length === 'h:x-session-id:'.length + 160);
  }
  {
    const a = makeAffinity({ sessionAffinity: { enabled: true, deriveFromBody: true } });
    const body = { system: '你是一个网关助手，回答要短。', messages: [{ role: 'user', content: '请解释一下什么是会话粘性，以及它对上游提示缓存有什么影响' }] };
    const k1 = a.affinityKeyFor({ headers: {} }, body), k2 = a.affinityKeyFor({ headers: {} }, body);
    check('deriveFromBody：同样的系统提示+首条用户消息 → 同一个键', k1 && k1 === k2, k1);
    check('deriveFromBody：键带 b:hash: 前缀且是 20 位十六进制', /^b:hash:[0-9a-f]{20}$/.test(k1), k1);
    check('deriveFromBody：内容不同 → 键不同',
      a.affinityKeyFor({ headers: {} }, { ...body, messages: [{ role: 'user', content: '换一个完全不同的问题来问' }] }) !== k1);
    check('deriveFromBody：内容太短（<32 字符）→ 不哈希，返回空键',
      a.affinityKeyFor({ headers: {} }, { messages: [{ role: 'user', content: 'hi' }] }) === '');
    check('deriveFromBody 仍然让显式头优先', a.affinityKeyFor({ headers: { 'x-session-id': 'zzzzzzzz' } }, body) === 'h:x-session-id:zzzzzzzz');
  }
  {
    const a = makeAffinity({ sessionAffinity: { enabled: true, ttlSec: 5, maxEntries: 1 } });
    check('ttlSec 下限钳到 30 秒', a.AFFINITY_CFG.ttlMs === 30000);
    check('maxEntries 下限钳到 16', a.AFFINITY_CFG.maxEntries === 16);
    const b = makeAffinity({ sessionAffinity: { enabled: true, ttlSec: 999999999, maxEntries: 44 } });
    check('ttlSec 上限钳到 7 天', b.AFFINITY_CFG.ttlMs === 7 * 86400 * 1000);
    check('maxEntries 正常值原样生效', b.AFFINITY_CFG.maxEntries === 44);
    check('旋钮非数字时退回默认（1 小时 / 2000 条）',
      makeAffinity({ sessionAffinity: { enabled: true, ttlSec: 'x', maxEntries: null } }).AFFINITY_CFG.ttlMs === 3600000);
  }

  /* ─────────────────────────── 2. 学习 / 命中 / 过期 / 淘汰 ─────────────────────────── */
  console.log('\n2. 学习 / 命中 / 过期 / 淘汰');
  {
    const a = makeAffinity({ sessionAffinity: { enabled: true, maxEntries: 16 } });
    a.affinityLearn('k1', 'chA');
    check('learn 后可取回同一个渠道', a.affinitySticky('k1') === 'chA');
    check('hits 计数 +1', a.AFFINITY_STAT.hits === 1);
    check('未知键返回空且 misses +1', a.affinitySticky('nope') === '' && a.AFFINITY_STAT.misses === 1);
    check('空键直接返回空、不计 misses', a.affinitySticky('') === '' && a.AFFINITY_STAT.misses === 1);
    a.AFFINITY.get('k1').ts = Date.now() - 3600001;   // 手动推过期（1 小时 TTL）
    check('过期后返回空并计入 expired', a.affinitySticky('k1') === '' && a.AFFINITY_STAT.expired === 1);
    check('过期条目已被懒清理出表', a.AFFINITY.size === 0);
    for (let i = 0; i < 17; i++) a.affinityLearn('key' + i, 'ch' + i);
    check('表满后仍不超过 maxEntries', a.AFFINITY.size === 16, a.AFFINITY.size);
    check('淘汰的是最旧的一条（key0 已不在）', !a.AFFINITY.has('key0') && a.AFFINITY.has('key16'));
    check('淘汰计数被记下', a.AFFINITY_STAT.evicted === 1, a.AFFINITY_STAT);
  }

  /* ─────────────────────────── 3. 排序语义 ─────────────────────────── */
  console.log('\n3. 排序语义（只在"还能上场"时提到链首）');
  {
    const a = makeAffinity({ sessionAffinity: { enabled: true } });
    a.affinityLearn('k', 'cC');
    const list = [cand('cA'), cand('cB'), cand('cC')];
    const out = a.applyAffinity(list, 'k');
    check('粘住的渠道被提到链首', out[0].channelId === 'cC' && out.length === 3, out.map((x) => x.channelId));
    check('其余候选保持原有相对顺序（兜底链不变）', out[1].channelId === 'cA' && out[2].channelId === 'cB');
    check('重排计数 +1', a.AFFINITY_STAT.reordered === 1);

    const b = makeAffinity({ sessionAffinity: { enabled: true } });
    b.affinityLearn('k', 'cC');
    const cool = [cand('cA'), cand('cB'), cand('cC', { cooldownUntil: Date.now() + 60000 })];
    check('粘住的那家在冷却 → 一动不动（不硬塞、也不清冷却）',
      b.applyAffinity(cool, 'k')[0].channelId === 'cA' && cool[2].cooldownUntil > Date.now());
    const down = [cand('cA'), cand('cC', { status: 'down' })];
    check('粘住的那家是 down → 一动不动', b.applyAffinity(down, 'k')[0].channelId === 'cA');

    const c = makeAffinity({ sessionAffinity: { enabled: true } });
    c.affinityLearn('k', 'cZ');
    const other = [cand('cA'), cand('cB')];
    check('粘住的渠道不在候选里（换模型了）→ 原样', c.applyAffinity(other, 'k')[0].channelId === 'cA');
    check('不在候选里也不制造"重排"计数', c.AFFINITY_STAT.reordered === 0);
    check('已经在链首 → 不动、不计数',
      (c.affinityLearn('k2', 'cA'), c.applyAffinity(other, 'k2'), other[0].channelId === 'cA' && c.AFFINITY_STAT.reordered === 0));
    check('无键（没带会话标识）→ 原样', c.applyAffinity([cand('cB'), cand('cA')], '')[0].channelId === 'cB');
  }

  /* ─────────────────────────── 4. 真链路 ─────────────────────────── */
  console.log('\n4. 真链路（假上游 ×2 + 临时网关）');
  const upState = { A: { fail: false }, B: { fail: false } };
  const makeUpstream = (tag) => http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      if (req.method === 'GET' && /models/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-aff' }] }));
      }
      if (upState[tag].fail) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":"mock down"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok-' + tag } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  const upA = makeUpstream('A'), upB = makeUpstream('B');
  const PA = await freePort(), PB = await freePort(), GW = await freePort();
  await new Promise((r) => upA.listen(PA, '127.0.0.1', r));
  await new Promise((r) => upB.listen(PB, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'aff.json');
  const writeCfg = (affinity) => fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
    sessionAffinity: affinity,
    channels: [
      { id: 'mock-affA', name: 'A', protocol: 'openai', baseUrl: `http://127.0.0.1:${PA}/v1`, apiKey: 'sk-a', priority: 10, enabled: true, weight: 1, models: { 'mock-aff': 'mock-aff' } },
      { id: 'mock-affB', name: 'B', protocol: 'openai', baseUrl: `http://127.0.0.1:${PB}/v1`, apiKey: 'sk-b', priority: 5, enabled: true, weight: 1, models: { 'mock-aff': 'mock-aff' } },
    ],
  }));
  writeCfg({ enabled: true, ttlSec: 3600 });

  let gw = null;
  const spawnGw = async (suffix) => {
    gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage' + suffix + '.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
      stdio: 'ignore',
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try { if ((await fetch(`http://127.0.0.1:${GW}/healthz`)).ok) return true; } catch { }
      await sleep(200);
    }
    return false;
  };
  const stopGw = () => new Promise((res) => {
    if (!gw || gw.exitCode !== null) return res();
    gw.once('exit', () => res());
    try { gw.kill(); } catch { }
    setTimeout(res, 1500);
  });
  const call = async (sessionId) => {
    const r = await fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY, ...(sessionId ? { 'X-Session-Id': sessionId } : {}) },
      body: JSON.stringify({ model: 'mock-aff', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text();
    return { status: r.status, ch: r.headers.get('X-ZZCSAPI-Channel') };
  };
  const admin = async (p) => (await fetch(`http://127.0.0.1:${GW}${p}`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).json();

  try {
    if (!await spawnGw('1')) throw new Error('临时网关未起来');

    const landings = [];
    for (let i = 0; i < 8; i++) landings.push((await call('sess-aaaaaaaa')).ch);
    check('同一会话 8 次请求全部落在同一个渠道（粘性生效）', new Set(landings).size === 1, landings);
    check('响应头仍标出落点渠道（可观测性没丢）', !!landings[0], landings);

    const st1 = await admin('/admin/api/status');
    check('/admin/api/status 暴露 affinity 状态', !!st1.affinity && st1.affinity.enabled === true, st1.affinity);
    check('表里恰好 1 条会话（8 次同一会话）', st1.affinity.entries === 1, st1.affinity);
    check('命中有计数（第 2 次起算命中）', st1.affinity.hits >= 7, st1.affinity);
    check('学习有计数', st1.affinity.learned >= 1, st1.affinity);
    check('粘性没有污染加权轮询份额统计（落点 100% 集中在 1 家，份额仍报 ≈50/50）', (() => {
      const shares = st1.channels.map((c) => c.weightedShare || 0);
      return shares.every((s) => s >= 25 && s <= 75) && new Set(landings).size === 1;
    })(), { shares: st1.channels.map((c) => c.weightedShare), landings });

    const pinned = landings[0];
    // 让被粘住的那家挂掉：下一个请求必然切走，并在**成功那家**上重新粘住
    const failTag = pinned === 'mock-affA' ? 'A' : 'B';
    upState[failTag].fail = true;
    const afterFail = [];
    for (let i = 0; i < 4; i++) afterFail.push((await call('sess-aaaaaaaa')).ch);
    check('粘住的那家 500 后切到另一家（粘性不挡故障切换）', afterFail.every((c) => c && c !== pinned), { pinned, afterFail });
    check('重新粘在成功的那家上（后续不再反复横跳）', new Set(afterFail).size === 1, afterFail);
    upState[failTag].fail = false;

    const st2 = await admin('/admin/api/status');
    check('重排计数增加（说明真的做了"提到链首"）', st2.affinity.reordered >= 1, st2.affinity);

    // 另一条会话：允许落到任一渠道，但必须真的被记入表
    await call('sess-bbbbbbbb');
    const st3 = await admin('/admin/api/status');
    check('不同会话各占一条（表里 2 条）', st3.affinity.entries === 2, st3.affinity);
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopGw();          // 上游留着给第 5 组对照用，最后统一关
  }

  /* ─────────────────────────── 5. 对照：关闭 = 零状态 ─────────────────────────── */
  console.log('\n5. 对照组：关闭时零状态、零影响');
  try {
    writeCfg({ enabled: false });
    if (!await spawnGw('2')) throw new Error('对照网关未起来');
    const landings = [];
    for (let i = 0; i < 6; i++) landings.push((await call('sess-aaaaaaaa')).ch);
    check('关闭时请求照常成功', landings.every((c) => !!c), landings);
    const st = await admin('/admin/api/status');
    check('关闭时粘性表恒为 0 条（一个字节状态都不留）', st.affinity.entries === 0, st.affinity);
    check('关闭时 enabled=false 且命中/学习全 0',
      st.affinity.enabled === false && st.affinity.hits === 0 && st.affinity.learned === 0, st.affinity);
    check('关闭时加权份额照常在算（老观测没被这版影响）', st.channels.some((c) => (c.weightedHits || 0) > 0), st.channels.map((c) => c.weightedHits));
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopGw();
    try { upA.close(); upB.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不 process.exit()：Windows 上撞到未关句柄会崩，见 weighted-rr-e2e 注释
})();
