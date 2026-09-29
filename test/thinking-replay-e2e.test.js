#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/thinking-replay-e2e.test.js — thinking 回放缓存回归（v1.18.8，真起进程，零依赖）
 *
 * 守的是什么：Anthropic 同协议直通上，客户端把上一轮 thinking 块**丢了 signature** 再送回来时
 * （部分开源 agent 框架重新序列化会丢不认识的字段；Anthropic 规定回传的 thinking 块必须带有效签名），
 * 网关按「会话键 + 渠道 + 模型 + 块哈希」缓存把**上游自己签的那枚**签名补回去——
 * 同时**绝不**生成/猜测签名、绝不跨渠道/跨会话/跨模型回放、没坏就不碰报文。
 *
 * 设计稿 §7.2 的验收清单逐条落在这里（第 7 条的文档同步见 docs/thinking-replay-design.md 与
 * test/thinking-fidelity.test.js 的同轮更新）：
 *   1. 先复现真实失败（对照轮：回放关闭 → 假上游签名校验把无签名块 400 回来）；
 *   2. 同会话同渠道相邻轮次，上游真的收到带签名 thinking（逐字段比对）；
 *   3. 不同会话 / 不同渠道 / 不同模型 → 绝不回放（三组反向断言）；
 *   4. 过期 / 超限淘汰后不回放，计数正确（纯函数真值表）；
 *   5. 完好客户端的直通保真不受影响（带签名块原样到达上游，一个字段不动）；
 *   6. 上游 400 时这组记录作废（stale），第二次不再回放同一条；
 *
 * §2 真链路按「六幕剧」走（每一幕 = 网关进程 + 假上游 + 真实 HTTP 请求，一步一步看发生了什么）：
 *   幕一【对照：先证明问题是真的】把回放关掉。客户端把上一轮 thinking 块的签名丢了再送回来
 *        → 假上游按 Anthropic 的规矩 400（"signature required"）。没有这一幕，后面的"修好了"无从谈起。
 *   幕二【学习 → 修复 → 没坏不碰】把回放打开。第 1 轮上游回带签名的 thinking，网关**旁路**记下
 *        "这枚签名是这家渠道签给这段文字的"（转给上游的字节一个没改）。第 2 轮客户端又把签名丢了
 *        → 网关把第 1 轮那枚**原样**补回去 → 上校验、过（200）——修复真的发生了，且逐字段比对。
 *        第 3 轮客户端签名带得好好的 → 网关**一个字段都不碰**（修复命中计数不涨）——没坏不碰。
 *   幕三【流式也认】第 1 轮改走 SSE：签名藏在分片里（signature_delta），网关边转发边旁扫照样学得到；
 *        第 2 轮丢签名照样修回来。
 *   幕四【三条反向线：缓存绝不越界】换会话 / 换模型 / 带错签名（伪造一枚别的串）→ 一律**不修**，
 *        上游照样 400。带错签名这轮还会把这条缓存记录**作废**（stale 计数 +1、缓存条数掉下来）——
 *        网关从不帮坏签名背书，也不拿已被拒过的那枚反复去赌。
 *   幕五【作废之后】再丢签名也不修了（上游第三次 400）——作废是真的作废。
 *   幕六【跨渠道不借：最后一幕】单开一个双渠道网关（A、B 都是 Anthropic 渠道）。
 *        第 1 轮落在 A，A 学到了签名；然后让 A 临时挂掉（500），第 2 轮自然落到 B 渠道。
 *        断言：**B 收到的是没有签名的块**，B 的上游照样 400——A 家学的签名没有借给 B 家。
 *        为什么这是对的行为：Anthropic 的签名与上游**账号**绑定，A 家签的签名本来就过不了
 *        B 家的校验——硬把 A 的签名塞进去 B 的请求等于替客户端**伪造**，只会白白消耗一次上游调用。
 *        所以缓存键里带渠道 id：A 家的记录在"这请求要发给 B"时**压根查不到**，想借也借不了。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/thinking-replay-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-replay-'));
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

/* 现抠真实的回放模块（normReplayCfg → applyRuntimeSettings 注释之前），注入 config/crypto
 * 与一个桩 affinityKeyFor 后取回内部函数——断言的是跑在真实源码里的那份逻辑。 */
const REPLAY_SRC = SRC.slice(SRC.indexOf('function normReplayCfg('), SRC.indexOf('// 运行期重新套用这四组设置'));
function makeReplay(cfg) {
  const stubAffinityKey = (req, body, ignoreEnabled) => 'stub:' + (ignoreEnabled ? 'yes' : 'no');
  const factory = new Function('config', 'crypto', 'affinityKeyFor', REPLAY_SRC + `
    return { REPLAY_CFG, REPLAY, REPLAY_STAT, replaySessionKeyFor, replayBlockKey,
             replayLearn, replaySignature, replayStale, repairThinkingBody,
             thinkingPairsFromAnthropic, thinkingStreamScan, replayStatus };`);
  return factory(cfg, require('crypto'), stubAffinityKey);
}

(async () => {
  /* ─────────────────────────── 0. 装配守卫 ─────────────────────────── */
  console.log('\n0. 装配守卫（源码级：接线点存在且边界没被越界）');
  check('回放块真实存在且被完整抠出（normReplayCfg → applyRuntimeSettings）',
    REPLAY_SRC.includes('function repairThinkingBody') && REPLAY_SRC.includes('function thinkingStreamScan'));
  check('默认关闭：enabled 只有显式 true 才为真', /enabled: c\.enabled === true/.test(REPLAY_SRC));
  check('会话键复用粘性推导但不受粘性开关牵连（affinityKeyFor 第三参 ignoreEnabled）',
    /function affinityKeyFor\(req, body, ignoreEnabled\) \{\s*\n\s*if \(!ignoreEnabled && !AFFINITY_CFG\.enabled\)/.test(SRC));
  const learnCalls = (SRC.match(/replayLearn\(/g) || []).length;
  check('replayLearn 恰好 3 处（定义 + 两个学习点：直通非流式 / 直通流式）', learnCalls === 3, learnCalls);
  check('修复只发生在同协议直通的选路处（repairThinkingBody 只出现在回放块与选路处）',
    (SRC.match(/repairThinkingBody\(/g) || []).length === 2 &&
    SRC.indexOf('repairThinkingBody(opts.replayKey') > SRC.indexOf('async function dispatchRequest'));
  check('作废只发生在 4xx 透传分支（replayStale 恰好 2 处：定义 + 4xx 分支）',
    (SRC.match(/replayStale\(/g) || []).length === 2 && /replayStale\(opts\.replayKey, candidate\.channelId/.test(SRC));
  check('persistConfig 白名单含 thinkingReplay（否则控制台保存渠道会把它抹掉）',
    /thinkingReplay: \(config && config\.thinkingReplay\) \|\| undefined/.test(SRC));
  check('settings 端点认第四组（groups 数组含 thinkingReplay）',
    /\['sessionAffinity', 'rateLimit', 'metrics', 'thinkingReplay'\]/.test(SRC));
  check('runtimeSettingsView / applyRuntimeSettings / status / metrics 四处都接了回放',
    /thinkingReplay: \{ enabled: REPLAY_CFG\.enabled/.test(SRC) &&
    /Object\.assign\(REPLAY_CFG, normReplayCfg/.test(SRC) &&
    /thinkingReplay: replayStatus\(\),/.test(SRC) &&
    /zzcsapi_thinking_replay_events_total/.test(SRC));
  check('回放代码不碰 SWRR_ / cooldownUntil / recordFailure（不污染调度）',
    !/SWRR_/.test(REPLAY_SRC) && !/recordFailure\(/.test(REPLAY_SRC) && !/cooldownUntil\s*=/.test(REPLAY_SRC));
  const antIn = SRC.slice(SRC.indexOf('function anthropicToOpenAI('), SRC.indexOf('function sanitizeOpenAIToolIds'));
  const antOut = SRC.slice(SRC.indexOf('function oaiRequestToAnthropic('), SRC.indexOf('function oaiRequestToGemini'));
  const antCli = SRC.slice(SRC.indexOf('function openAIToAnthropicResponse('), SRC.indexOf('function createAnthropicStreamConverter'));
  check('跨协议转换器仍一个 signature 都不碰（签名唯一活路 = 直通 + 回放缓存）',
    !/signature/.test(antIn) && !/signature/.test(antOut) && !/signature/.test(antCli));

  /* ─────────────────────────── 1. 纯函数真值表 ─────────────────────────── */
  console.log('\n1. 钳制 / 学习 / 查找 / 修复 / 抽取 / 流扫描（现抠真实源码跑）');
  {
    const r = makeReplay({ thinkingReplay: { enabled: false } });
    check('关闭时：会话键恒为空（不受粘性牵连也不开门）', r.replaySessionKeyFor({}, {}) === '');
    check('关闭时：learn 不写表', (r.replayLearn('k', 'ch', 'm', [{ thinking: 't', signature: 's' }]), r.REPLAY.size === 0));
    check('关闭时：查签名恒为空', r.replaySignature('k', 'ch', 'm', 't') === '');
    check('关闭时：修复恒返回 null（报文一个字节都不动）',
      r.repairThinkingBody('k', 'ch', 'm', { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 't' }] }] }) === null);
    check('关闭时：状态 enabled=false 且全零', r.replayStatus().enabled === false && r.replayStatus().entries === 0);
  }
  {
    const r = makeReplay({ thinkingReplay: { enabled: true } });
    const nc = (v) => { const f = new Function('raw', REPLAY_SRC.slice(REPLAY_SRC.indexOf('function normReplayCfg('), REPLAY_SRC.indexOf('const REPLAY_CFG')) + ' return normReplayCfg(raw);'); return f(v); };
    check('钳制：ttlSec 5 → 30（下限）', nc({ ttlSec: 5 }).ttlMs === 30000);
    check('钳制：ttlSec 超大 → 604800（上限 7 天）', nc({ ttlSec: 99e9 }).ttlMs === 604800000);
    check('钳制：maxEntries 1 → 16（下限）', nc({ maxEntries: 1 }).maxEntries === 16);
    check('钳制：负数 / 非数字 → 默认 3600 秒 / 2048 条', nc({ ttlSec: -5, maxEntries: 'x' }).ttlMs === 3600000 && nc({ ttlSec: -5, maxEntries: 'x' }).maxEntries === 2048);
    check('回放开着、粘性关着：会话键照样推导（第三参跳过粘性门槛）',
      r.replaySessionKeyFor({}, {}) === 'stub:yes');
    r.replayLearn('k1', 'chA', 'm1', [{ thinking: 'think-one', signature: 'sig-one' }, { thinking: 'no-sig' }, null]);
    check('学习：只存带签名的（没签名的跳过，表里 1 条）', r.REPLAY.size === 1 && r.REPLAY_STAT.learned === 1);
    check('查找：命中返回原签名', r.replaySignature('k1', 'chA', 'm1', 'think-one') === 'sig-one' && r.REPLAY_STAT.hits === 1);
    check('查找：不同渠道不认（跨渠道绝不回放）', r.replaySignature('k1', 'chB', 'm1', 'think-one') === '' && r.REPLAY_STAT.misses === 1);
    check('查找：不同模型不认（模型在键里）', r.replaySignature('k1', 'chA', 'm2', 'think-one') === '' && r.REPLAY_STAT.misses === 2);
    check('查找：thinking 文本改过一个字也不认（块哈希在键里）', r.replaySignature('k1', 'chA', 'm1', 'think-onf') === '' && r.REPLAY_STAT.misses === 3);
    const key0 = r.REPLAY.keys().next().value;
    r.REPLAY.get(key0).ts = Date.now() - 3600000 - 1;   // 手动把时间拨过期
    check('查找：过期即删且计数（懒清理）', r.replaySignature('k1', 'chA', 'm1', 'think-one') === '' && r.REPLAY.size === 0 && r.REPLAY_STAT.expired === 1);
    r.replayLearn('k3', 'chB', 'm1', [{ thinking: 'other', signature: 's-other' }]);
    r.replayStale('k3', 'chB', 'm1');
    check('作废：只删本组（chB 组没了，learned 的记录不受别的组牵连）', r.REPLAY_STAT.stale === 1);
  }
  {
    const r = makeReplay({ thinkingReplay: { enabled: true, maxEntries: 1 } });   // 钳到下限 16
    const many = Array.from({ length: 17 }, (_, i) => ({ thinking: 't-' + i, signature: 's-' + i }));
    r.replayLearn('k2', 'chA', 'm1', many);
    check('超限淘汰最旧：maxEntries 钳到 16，灌 17 条丢最旧（t-0 不在、t-16 在、evicted ≥1）',
      r.REPLAY.size === 16 && r.replaySignature('k2', 'chA', 'm1', 't-0') === '' && r.replaySignature('k2', 'chA', 'm1', 't-16') === 's-16' && r.REPLAY_STAT.evicted >= 1,
      { size: r.REPLAY.size, evicted: r.REPLAY_STAT.evicted });
  }
  {
    const r = makeReplay({ thinkingReplay: { enabled: true } });
    r.replayLearn('k', 'ch', 'm', [{ thinking: 'TH', signature: 'SIG' }]);
    const raw = (blocks) => ({ model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: blocks }, { role: 'user', content: 'next' }], metadata: { x: 1 }, top_k: 3 });
    const fixed = r.repairThinkingBody('k', 'ch', 'm', raw([{ type: 'thinking', thinking: 'TH' }, { type: 'text', text: 'ans' }]));
    check('修复：缺签名的 thinking 块补上缓存里的原签名', fixed && fixed.messages[1].content[0].signature === 'SIG' && r.REPLAY_STAT.hits === 1);
    check('修复：只动 content，顶层字段（system/metadata/top_k/messages 首尾）原样带过去',
      fixed.system === 's' && fixed.top_k === 3 && fixed.metadata.x === 1 && fixed.messages[0].content === 'hi' && fixed.messages[2].content === 'next');
    check('修复：同消息里没坏的其他块（text）一个字段不动', fixed.messages[1].content[1].text === 'ans' && fixed.messages[1].content[1].type === 'text');
    check('没坏就不碰：块本来带签名 → 返回 null（完好客户端的直通保真不变）',
      r.repairThinkingBody('k', 'ch', 'm', raw([{ type: 'thinking', thinking: 'TH', signature: 'SIG' }])) === null);
    check('未命中就不碰：thinking 文本被客户端改写 → null（上游继续 400，不造签名）',
      r.repairThinkingBody('k', 'ch', 'm', raw([{ type: 'thinking', thinking: 'TH-改写' }])) === null && r.REPLAY_STAT.misses === 1);
    check('只认 assistant 消息：user 消息里挂着 thinking 块也不修',
      r.repairThinkingBody('k', 'ch', 'm', { messages: [{ role: 'user', content: [{ type: 'thinking', thinking: 'TH' }] }] }) === null);
    check('redacted_thinking 不修（它本来就没有签名字段，丢了也不补）',
      r.repairThinkingBody('k', 'ch', 'm', raw([{ type: 'redacted_thinking', data: 'xx' }])) === null);
    check('缺会话键不修（没有会话边界就没有安全边界）',
      r.repairThinkingBody('', 'ch', 'm', raw([{ type: 'thinking', thinking: 'TH' }])) === null);
    check('thinking 空串不修', r.repairThinkingBody('k', 'ch', 'm', raw([{ type: 'thinking', thinking: '' }])) === null);
  }
  {
    const r = makeReplay({ thinkingReplay: { enabled: true } });
    check('抽取：响应里带签名的 thinking 进对、没签名与 redacted 跳过、无 content → null',
      JSON.stringify(r.thinkingPairsFromAnthropic({ content: [
        { type: 'thinking', thinking: 'a', signature: 'sa' },
        { type: 'thinking', thinking: 'b' },
        { type: 'redacted_thinking', data: 'x' },
        { type: 'text', text: 't' },
      ] })) === JSON.stringify([{ thinking: 'a', signature: 'sa' }]) &&
      r.thinkingPairsFromAnthropic({ content: [{ type: 'text', text: 't' }] }) === null &&
      r.thinkingPairsFromAnthropic({}) === null);
    let acc = r.thinkingStreamScan('data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}', null);
    acc = r.thinkingStreamScan('data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"part1-"}}', acc);
    acc = r.thinkingStreamScan('data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"part2"}}', acc);
    acc = r.thinkingStreamScan('data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}', acc);
    check('流扫描：text 块不干扰 thinking 块的累积', acc.open.size === 1 && acc.open.get(0).text === 'part1-part2');
    acc = r.thinkingStreamScan('data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG-s"}}', acc);
    acc = r.thinkingStreamScan('data: {"type":"content_block_stop","index":0}', acc);
    check('流扫描：分片攒成完整对（thinking_delta×2 + signature_delta + stop）',
      JSON.stringify(acc.done) === JSON.stringify([{ thinking: 'part1-part2', signature: 'SIG-s' }]));
    check('流扫描：没走到 content_block_stop 的块不收（上游截流不学半截）',
      (() => { const a2 = r.thinkingStreamScan('data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}', null);
        return a2.done.length === 0 && a2.open.size === 1; })());
    check('流扫描：垃圾行 / [DONE] / 非 data 行静默跳过',
      r.thinkingStreamScan('data: {oops', acc) === acc && r.thinkingStreamScan('data: [DONE]', acc) === acc && r.thinkingStreamScan('', acc) === acc);
  }

  /* ─────────────────────────── 2. 真链路：复现 → 修复 → 边界 ─────────────────────────── */
  console.log('\n2. 真链路（临时网关 + 假 Anthropic 上游：复现失败 → 回放修复 → 三组反向）');
  // 假上游：真做签名校验——无签名 / 签名不对都 400；自己发的响应带 thinking + signature
  const makeUpstream = (tag) => {
    const st = { remembered: new Map(), hits: [], httpHits: 0, fail: false };
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        st.httpHits++;
        if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
        let body = null; try { body = JSON.parse(raw); } catch { /* 忽略 */ }
        // 每一发都记档（包括之后被 400 / fail 的）——负向断言要看的正是"上游收到了什么"
        st.hits.push({ url: req.url, key: req.headers['x-api-key'], ver: req.headers['anthropic-version'], body });
        if (st.fail) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":"mock down"}'); }
        if (!body) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"type":"error","error":{"type":"invalid_request_error","message":"bad json"}}'); }
        // 签名校验：assistant 消息里每个 thinking 块必须带它记得的那枚签名
        for (const m of body.messages || []) {
          if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
          for (const b of m.content) {
            if (!b || b.type !== 'thinking' || !b.thinking) continue;
            const want = st.remembered.get(b.thinking);
            if (!b.signature) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking signature required: each thinking block must be passed back with its original signature' } }));
            }
            if (want === undefined || want !== b.signature) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid thinking signature: signature does not match the thinking block it accompanies' } }));
            }
          }
        }
        const think = `deep-thought-answer-${tag}-${st.httpHits}`;
        const sig = `sig-${tag}-${st.httpHits}`;
        st.remembered.set(think, sig);
        if (body.stream === true) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const frames = [
            ['message_start', { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } }],
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: think.slice(0, 8) } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: think.slice(8) } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: sig } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'pong' } }],
            ['content_block_stop', { type: 'content_block_stop', index: 1 }],
            ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
            ['message_stop', { type: 'message_stop' }],
          ];
          for (const [ev, j] of frames) res.write(`event: ${ev}\ndata: ${JSON.stringify(j)}\n\n`);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_x', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
          content: [{ type: 'thinking', thinking: think, signature: sig }, { type: 'text', text: 'pong' }],
          usage: { input_tokens: 3, output_tokens: 5 },
        }));
      });
    });
    return { server, st };
  };
  const upA = makeUpstream('A'), upB = makeUpstream('B');
  const PA = await freePort(), PB = await freePort(), GW = await freePort(), GW2 = await freePort();
  await new Promise((r) => upA.server.listen(PA, '127.0.0.1', r));
  await new Promise((r) => upB.server.listen(PB, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'replay.json');
  const writeCfg = (replay, twoChannels) => fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
    cooldown: { transientBaseMs: 1000 },   // 测试节奏：负向 400 只上 1 秒冷却（下限），下一轮前睡过它
    thinkingReplay: replay,
    channels: [
      { id: 'ant-main', name: '主上游', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${PA}`, apiKey: 'sk-a', priority: 10, enabled: true, weight: 1, models: { 'm1': 'up-m1', 'm2': 'up-m2' } },
      ...(twoChannels ? [{ id: 'ant-side', name: '侧上游', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${PB}`, apiKey: 'sk-b', priority: 5, enabled: true, weight: 1, models: { 'm1': 'up-m1' } }] : []),
    ],
  }));
  // 跨渠道那组要单开一个网关（主网关只有一家：400 直接透传，不被"换一家"语义搅浑）
  const cfgPath2 = path.join(TMP, 'replay2.json');
  fs.writeFileSync(cfgPath2, JSON.stringify({
    port: GW2, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
    cooldown: { transientBaseMs: 1000 },
    thinkingReplay: { enabled: true, ttlSec: 3600 },
    channels: [
      // 都不填 weight：不激活加权池 → 100% 按原序首发（A 家优先级 10 永远第一位，B 家只在 A 失败时接手）——
      // 填了 weight 会被加权轮询随机抽到 B 家首发，落家就不确定了
      { id: 'ant-main', name: '主上游', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${PA}`, apiKey: 'sk-a', priority: 10, enabled: true, models: { 'm1': 'up-m1' } },
      { id: 'ant-side', name: '侧上游', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${PB}`, apiKey: 'sk-b', priority: 5, enabled: true, models: { 'm1': 'up-m1' } },
    ],
  }));

  let gw = null;
  const spawnGw = async (cfg, usage) => {
    gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ZZCSAPI_CONFIG: cfg, ZZCSAPI_USAGE: path.join(TMP, usage), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
      stdio: 'ignore',
    });
    const port = cfg === cfgPath2 ? GW2 : GW;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return port; } catch { }
      await sleep(200);
    }
    return 0;
  };
  const stopGw = () => new Promise((res) => {
    if (!gw || gw.exitCode !== null) return res();
    gw.once('exit', () => res());
    try { gw.kill(); } catch { }
    // 兜底 4000ms（不是常见的 1500）：本用例同一端口连起三个网关，负载下旧进程退出慢一拍
    // 就会让下一节的 listen 撞 EADDRINUSE——那是环境竞态，不是被测行为
    setTimeout(res, 4000);
  });
  const antCall = async (port, body, sessionId) => {
    const r = await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY, ...(sessionId ? { 'X-Session-Id': sessionId } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, text: await r.text() };
  };
  const admin = async (p) => (await fetch(`http://127.0.0.1:${GW}${p}`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).json();
  const round1Body = (model) => ({ model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
  // 第 2 轮用**客户端自己的模型名**（不是上游回显的那枚）——真客户端重发时要的是同一个模型
  const round2Body = (model, round1, opts) => {
    const blocks = (round1.content || []).map((b) => {
      const c = { ...b };
      if (opts && opts.strip && c.type === 'thinking') delete c.signature;      // 客户端把签名弄丢了
      if (opts && opts.wrongSig && c.type === 'thinking') c.signature = 'sig-forged';  // 客户端带着错签名
      return c;
    });
    return { model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: blocks }, { role: 'user', content: 'next' }] };
  };
  const parseMsg = (text) => { try { return JSON.parse(text); } catch { return null; } };

  try {
    /* 2.1 对照（设计稿 §7.2 第 1 条：先复现真实失败）——回放关闭 */
    writeCfg({ enabled: false });
    if (!await spawnGw(cfgPath, 'usage1.json')) throw new Error('对照网关未起来');
    const c1 = parseMsg((await antCall(GW, round1Body('m1'), 'sess-aaaaaaaa')).text);
    check('[对照] 第 1 轮：客户端拿到带签名的 thinking 块（直通原样）',
      c1 && c1.content[0].type === 'thinking' && !!c1.content[0].signature === true);
    const c2 = await antCall(GW, round2Body('m1', c1, { strip: true }), 'sess-aaaaaaaa');
    const cap2 = upA.st.hits[upA.st.hits.length - 1];
    check('[对照·复现失败] 客户端丢签名 → 上游 400（无签名块原样到达上游，问题真实存在）',
      c2.status === 400 && cap2.body.messages[1].content[0].signature === undefined &&
      /signature required/.test(c2.text), { status: c2.status, err: c2.text.slice(0, 80) });
    const st0 = (await admin('/admin/api/status')).thinkingReplay;
    check('[对照] 关闭时零状态：enabled=false / entries=0 / 全零计数',
      st0.enabled === false && st0.entries === 0 && st0.learned === 0 && st0.hits === 0, st0);
  } catch (e) {
    fail++; console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopGw();
  }

  try {
    /* 2.2 回放开启：学 → 修 → 完好不碰 */
    writeCfg({ enabled: true, ttlSec: 3600 });
    upA.st.hits.length = 0;
    if (!await spawnGw(cfgPath, 'usage2.json')) throw new Error('主网关未起来');
    const r1 = parseMsg((await antCall(GW, round1Body('m1'), 'sess-aaaaaaaa')).text);
    const sig1 = r1.content[0].signature, think1 = r1.content[0].thinking;
    const st1 = (await admin('/admin/api/status')).thinkingReplay;
    check('第 1 轮：学习点真的记下了（learned ≥1 / entries ≥1）', st1.learned >= 1 && st1.entries >= 1, st1);
    const r2 = await antCall(GW, round2Body('m1', r1, { strip: true }), 'sess-aaaaaaaa');
    const cap = upA.st.hits[upA.st.hits.length - 1];
    check('第 2 轮：丢签名的块被补回了第 1 轮那枚原签名（逐字段：thinking 一致 + signature === 原值）',
      r2.status === 200 && cap.body.messages[1].content[0].signature === sig1 && cap.body.messages[1].content[0].thinking === think1,
      { status: r2.status, got: cap.body.messages[1].content[0].signature });
    const st2 = (await admin('/admin/api/status')).thinkingReplay;
    check('第 2 轮：修复命中计数（hits ≥1）', st2.hits >= 1, st2);
    check('上游始终收到原生头（x-api-key + anthropic-version）与原生 URL（/v1/messages）',
      cap.key === 'sk-a' && cap.ver === '2023-06-01' && cap.url === '/v1/messages', { url: cap.url, key: cap.key });
    // 完好客户端：带完整签名的块原样回传 → 上游原样收到，修复不介入（hits 不涨）
    const hitsBefore = ((await admin('/admin/api/status')).thinkingReplay).hits;
    const r3 = await antCall(GW, round2Body('m1', r1, {}), 'sess-aaaaaaaa');
    const cap3 = upA.st.hits[upA.st.hits.length - 1];
    const hitsAfter = ((await admin('/admin/api/status')).thinkingReplay).hits;
    check('完好客户端：带签名块原样到达上游（200，字段一字不差）——没坏就不碰',
      r3.status === 200 && cap3.body.messages[1].content[0].signature === sig1 && hitsAfter === hitsBefore);
    // 流式学习：第 1 轮走 SSE，第 2 轮丢了签名照样补回（放在负向轮之前：负向 400 会给渠道上短暂冷却）
    const learnedBefore = ((await admin('/admin/api/status')).thinkingReplay).learned;
    const r4raw = await antCall(GW, { ...round1Body('m1'), stream: true }, 'sess-cccccccc');
    const st4 = (await admin('/admin/api/status')).thinkingReplay;
    check('流式第 1 轮：直通流式旁路扫描也学习（learned 继续涨 / 200 SSE）',
      r4raw.status === 200 && st4.learned > learnedBefore && r4raw.text.includes('content_block_start'), { status: r4raw.status, learned: st4.learned });
    const streamThink = (r4raw.text.match(/"thinking_delta","thinking":"([^"]+)"/g) || []).map((s) => s.match(/"thinking":"([^"]+)"/)[1]).join('');
    const streamSig = (r4raw.text.match(/"signature_delta","signature":"([^"]+)"/) || [])[1];
    const r5 = await antCall(GW, { model: 'm1', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'thinking', thinking: streamThink }, { type: 'text', text: 'pong' }] }, { role: 'user', content: 'next' }] }, 'sess-cccccccc');
    check('流式第 2 轮：分片攒出来的对照样修（上游收到拼接原文 + 原签名）',
      r5.status === 200 && upA.st.hits[upA.st.hits.length - 1].body.messages[1].content[0].signature === streamSig
      && upA.st.hits[upA.st.hits.length - 1].body.messages[1].content[0].thinking === streamThink,
      { status: r5.status });
    // 负向轮（400）会给单渠道上短暂 transient 冷却——睡过冷却窗再插一发**成功请求**回血
    // （成功即满血：consecutiveFail 清零），后面的轮次才不会被 503 搅浑
    const heal = async () => { await sleep(1100); await antCall(GW, round1Body('m1'), 'sess-heal-0001'); };
    // 反向三连：跨会话 / 跨模型 → 绝不回放
    const rx = await antCall(GW, round2Body('m1', r1, { strip: true }), 'sess-xxxxxxxx');
    check('反向① 跨会话：另一条会话绝不回放（上游继续看到无签名 → 400）',
      rx.status === 400 && upA.st.hits[upA.st.hits.length - 1].body.messages[1].content[0].signature === undefined);
    await heal();
    const rm = await antCall(GW, round2Body('m2', r1, { strip: true }), 'sess-aaaaaaaa');
    check('反向② 跨模型：换了模型绝不回放（模型在键里）',
      rm.status === 400 && upA.st.hits[upA.st.hits.length - 1].body.messages[1].content[0].signature === undefined);
    await heal();
    // stale：带着错签名（不是丢）→ 上游 400 → 这组作废 → 再丢签名也修不回来了
    const stBefore = (await admin('/admin/api/status')).thinkingReplay;
    const rw = await antCall(GW, round2Body('m1', r1, { wrongSig: true }), 'sess-aaaaaaaa');
    const stMid = (await admin('/admin/api/status')).thinkingReplay;
    check('stale① 错签名（伪造）不会被修也不会被放行：上游 400（网关从不帮坏签名背书）',
      rw.status === 400 && /invalid thinking signature/.test(rw.text), { status: rw.status, err: rw.text.slice(0, 60) });
    check('stale② 上游 400 后这组记录作废（stale 计数在涨、entries 立即掉下来）',
      stMid.stale >= (stBefore.stale || 0) + 1 && stMid.entries < stBefore.entries, stMid);
    await heal();
    const r6 = await antCall(GW, round2Body('m1', r1, { strip: true }), 'sess-aaaaaaaa');
    const stEnd = (await admin('/admin/api/status')).thinkingReplay;
    check('stale③ 作废后再丢签名也不回放（同一条坏记录不反复引发 4xx）',
      r6.status === 400 && upA.st.hits[upA.st.hits.length - 1].body.messages[1].content[0].signature === undefined,
      { status: r6.status });
    check('未命中计数累计 ≥3（跨会话 / 跨模型 / 作废后三发都真去了上游）', stEnd.misses >= 3, stEnd);
    // 观测面：settings / metrics
    const set = await (await fetch(`http://127.0.0.1:${GW}/admin/api/settings`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).json();
    check('GET /admin/api/settings：第四组 config/effective 两段都在（enabled=true）',
      set.config && set.config.thinkingReplay && set.config.thinkingReplay.enabled === true &&
      set.effective && set.effective.thinkingReplay && set.effective.thinkingReplay.enabled === true, set.config && set.config.thinkingReplay);
    check('GET /admin/api/settings：status 段有回放实时计数（entries/learned/hits）',
      set.status && set.status.thinkingReplay && set.status.thinkingReplay.entries >= 0 && set.status.thinkingReplay.learned >= 2);
    const met = await (await fetch(`http://127.0.0.1:${GW}/metrics`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).text();
    check('/metrics：zzcsapi_thinking_replay_entries 与 events_total（learned/hits/stale）都在动',
      met.includes('zzcsapi_thinking_replay_entries') && met.includes('zzcsapi_thinking_replay_events_total{event="learned"}') &&
      met.includes('zzcsapi_thinking_replay_events_total{event="hits"}') && met.includes('zzcsapi_thinking_replay_events_total{event="stale"}'));
  } catch (e) {
    fail++; console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopGw();
  }

  try {
    /* 2.3 反向③ 跨渠道：渠道 A 学的签名绝不借给渠道 B（单开双渠道网关；A 家临时挂掉逼第 2 轮落到 B 家） */
    if (!await spawnGw(cfgPath2, 'usage3.json')) throw new Error('双渠道网关未起来');
    const bSeen0 = upB.st.hits.length;
    const g1 = parseMsg((await antCall(GW2, round1Body('m1'), 'sess-dddddddd')).text);
    check('[跨渠道前置] 第 1 轮落在主渠道 A（B 家一枪未发、响应带签名）',
      upB.st.hits.length === bSeen0 && !!(g1 && g1.content && g1.content[0].signature), { b: upB.st.hits.length - bSeen0 });
    upA.st.fail = true;   // A 家临时挂掉：第 2 轮必然切到 B 家
    const g2 = await antCall(GW2, round2Body('m1', g1, { strip: true }), 'sess-dddddddd');
    upA.st.fail = false;
    const bLast = upB.st.hits[upB.st.hits.length - 1];
    check('反向③ 跨渠道：A 家挂掉后第 2 轮落到 B 家，B 收到的是无签名块（A 家学的签名没借给 B 家）',
      g2.status === 400 && upB.st.hits.length === bSeen0 + 1 && bLast.body.messages[1].content[0].signature === undefined,
      { status: g2.status, bHits: upB.st.hits.length - bSeen0, err: g2.text.slice(0, 200) });
  } catch (e) {
    fail++; console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopGw();
    try { upA.server.close(); upB.server.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log(`\n合计：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('fatal:', e); process.exit(1); });
