#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/same-protocol-passthrough.test.js — 同协议直通（v1.15）
 *                                  Anthropic 客户端 → Anthropic 渠道 / Gemini 同理
 *
 * 以前这条链路是「客户端报文 → 内部 OpenAI → 原生报文」来回两趟翻译，每次都要丢掉内部格式
 * **承载不了**的字段：`thinking` / `cache_control` / `top_k` / `metadata` / 多段 system /
 * `stop_sequences` 细节 / `generationConfig.seed` / `thinkingConfig` …… 客户端以为发了，
 * 上游根本没收到，而回程还会把上游的块重排一遍（连 `message_start` 都是网关补出来的）。
 *
 * 直通做的事只有三件，其余一概不碰：
 *   ① 出站用**客户端原始报文**（anthropic 把 model 换成渠道的上游名；gemini 的模型名在 URL 里）；
 *   ② 出站 URL / 请求头与原生路径一致（x-api-key + anthropic-version / x-goog-api-key）；
 *   ③ 响应（含流式 SSE 字节）原样回传，不再 translateResponse / 不再套流式转换器 /
 *      不再补 message_start 与收尾——上游给什么就是什么。
 * 代价要诚实说：入站那层"顺手的清洗"也不再执行（内部格式才需要的工具 id 清洗、参数方言修正），
 * 报什么错就透什么错；candidate 过滤（图片能力门）仍在选路阶段照常生效。
 *
 * v1.18.32 增补（§3b）：直通路径上的「上游 200 但一个内容帧都没有」也要如实记账——直通是边收边写、
 *   `headCommitted` 恒真、换不了家，但"账本不说谎 + 让这家退避"必须成立（此前它被记成成功）。
 *
 * 跑法：node test/same-protocol-passthrough.test.js   （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-passthru-'));
const GW_KEY = 'pt-gw', AD_KEY = 'pt-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 320) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
// 抠函数：必须跳过字符串/注释里的花括号（源码里有 startsWith('{') 这类字面量）
function extract(name) {
  let i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('server.js 里找不到函数 ' + name);
  if (SRC.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
  let depth = 0, started = false, quote = null, esc = false;
  for (let k = i; k < SRC.length; k++) {
    const c = SRC[k], n = SRC[k + 1];
    if (esc) { esc = false; continue; }
    if (quote) {
      if (c === '\\') { esc = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { const e = SRC.indexOf('\n', k); k = e < 0 ? SRC.length : e; continue; }
    if (c === '/' && n === '*') { const e = SRC.indexOf('*/', k); k = e < 0 ? SRC.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return SRC.slice(i, k + 1); }
  }
  throw new Error('花括号不配对：' + name);
}
const load = (name) => new Function(extract(name) + '\nreturn ' + name + ';')();

/* ── 假上游：一个进程里同时扮演 anthropic / gemini / openai 三种原生上游 ── */
// v1.18.32：直通路径的「200 + 零正文」——上游只发 message_start + message_stop，
//   **零 content_block_delta**（客户端拿到的是一个没有任何内容块的消息）。
const EMPTY_ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_empty","role":"assistant","content":[],"usage":{"input_tokens":4,"output_tokens":0}}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');
function makeFakeUpstream() {
  const st = {
    mode: 'ok', hits: [], anthropicBody: '', anthropicSSE: '', geminiBody: '', oaiReply: null,
  };
  st.server = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      const raw = Buffer.concat(cs).toString('utf8');
      let body = null; try { body = JSON.parse(raw || '{}'); } catch { }
      st.hits.push({ method: req.method, url: req.url, headers: req.headers, raw, body });
      // 探测（GET /models、GET /v1/models …）
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'claude-3-5-sonnet-20241022' }, { id: 'gemini-2.5-pro' }, { id: 'gpt-x' }] }));
      }
      // Anthropic 原生
      if (/\/v1\/messages$/.test(req.url)) {
        // v1.18.32：渠道 ant-empty 的上游模型名 → 只回 message_start + message_stop（零 content_block_delta）
        if (body && body.model === 'claude-empty-up') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          return res.end(EMPTY_ANTHROPIC_SSE);
        }
        if (st.mode === 'anthropic-stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          return res.end(st.anthropicSSE);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(st.anthropicBody);
      }
      // Gemini 原生
      if (/:generateContent|:streamGenerateContent/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': /streamGenerateContent/.test(req.url) ? 'text/event-stream' : 'application/json' });
        return res.end(st.geminiBody);
      }
      // OpenAI（对照组用）
      if (/\/chat\/completions$/.test(req.url)) {
        if (body && body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          return res.end('data: {"id":"c","choices":[{"index":0,"delta":{"role":"assistant","content":"cv"}}]}\n\ndata: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(st.oaiReply || { id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'cv' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"no route"}');
    });
  });
  return st;
}

(async () => {
  /* ══════════ 0. 装配守卫 ══════════ */
  console.log('0. 装配守卫');
  {
    check('★ 直通选项存在，且**不**提供 translateResponse / makeStreamTranslator（否则等于把省掉的翻译加回来）',
      /function passthroughChannelOpts\(/.test(SRC)
      && !/passthroughChannelOpts[\s\S]{0,900}?translateResponse:/.test(SRC)
      && !/passthroughChannelOpts[\s\S]{0,900}?makeStreamTranslator:/.test(SRC));
    check('★ anthropic 直通只改 model（v1.18.33 起另按渠道 dropParams 剔除显式配置的那几个参数），其余字段原样带出去',
      /encodeOutgoing: \(b, c\) => \(proto === 'anthropic' \? \{ \.\.\.strip\(raw\), model: c\.upstream \} : strip\(raw\)\)/.test(SRC)
      // v1.18.33：strip() 的两条承诺——没配 dropParams 的渠道必须**原对象原样返回**（老配置行为一个字节不变，
      // 直通保真是这套设计的立身之本），配了也只删 drops 里那几个键、绝不整份重造报文。
      && /const strip = \(o\) => \{\s*if \(!drops\.length\) return o;/.test(SRC)
      && /for \(const k of drops\) delete c\[k\];/.test(SRC));
    check('★ 选路：只有客户端协议 === 渠道协议才直通（v1.18.8 直通前先做 thinking 签名修复——没坏就不碰），否则仍走原生转换',
      /opts\.clientProto && opts\.clientProto === chProto\)/.test(SRC)
      && /\? passthroughChannelOpts\(chProto, \(chProto === 'anthropic'\s*\?\s*repairThinkingBody/.test(SRC)
      && /: nativeChannelOpts\(chProto, requestedModel\)/.test(SRC));
    check('★ v1.18.8 修复只注入同协议直通（gemini 直通与跨协议原生转换都不碰报文）',
      (SRC.match(/repairThinkingBody\(/g) || []).length === 2   // 定义 + 唯一注入点
      && !/\? repairThinkingBody/.test(SRC.slice(SRC.indexOf(': nativeChannelOpts('))));
    check('★ 探测/健康路径不受影响（直通只在 dispatchRequest 选路处生效）',
      (SRC.match(/passthroughChannelOpts\(/g) || []).length === 2);
    const tc = extract('tryChannel');
    check('★ 流式直通：不建转换器、不发 prelude/epilogue、逐行原样写回', /function nativeStreamUsageScan/.test(SRC)
      && /if \(typeof opts\.makeStreamTranslator === 'function' && !passthrough\)/.test(tc)
      && /if \(typeof opts\.streamPrelude === 'function' && !passthrough\)/.test(tc)
      && /if \(typeof opts\.streamEpilogue === 'function' && !passthrough\)/.test(tc));
    check('★ 非流式直通：原样写回，且**跳过** onSuccessNonStream（不能既直通又转换；v1.18.8 在原样写回前只旁路学 thinking 对，不动转发字节）',
      /if \(passthrough\) \{[\s\S]{0,1300}?res\.end\(rawText\);\s*\n\s*return 'success';/.test(tc)
      && /passthrough\) \{[\s\S]{0,1300}?await onSuccessNonStream\(shim, candidate\)/.test(tc) === false);
    check('★ 两条客户端路由都把原始报文交出来（rawClientBody）',
      (SRC.match(/clientProto: 'anthropic'/g) || []).length === 1
      && (SRC.match(/clientProto: 'gemini'/g) || []).length === 1
      && (SRC.match(/rawClientBody: body/g) || []).length === 2);
    check('★ v1.18.32 直通空流判据的条件逐字为 `streamError === null && !nativeStream && !sawStreamContent`'
      + '（正则要求条件右括号后紧跟 `{`，所以多塞任何一项都会挂：既不许少 `!nativeStream`，也不许再加 `streamOutText.length === 0`。'
      + '`!nativeStream` 是真实误伤过的坑——原生流走翻译器、`noteStreamLine` 压根不跑，`sawStreamContent` 在原生流上恒 false，'
      + '缺了它每条正常原生流都会被判空：实测 mock-anthropic 翻译后已有 23 字符正文仍被记失败 → 渠道进冷却 → native-channels-e2e 6 条级联 503；'
      + '而 `streamOutText` 在直通路径会回落累计原始行，加了它等于把直通场景整条判死）',
      /if \(streamError === null && !nativeStream && !sawStreamContent\) \{/.test(SRC));
  }

  /* ══════════ 1. 真值表 ══════════ */
  console.log('\n1. 纯函数真值表（直通也要如实记 token）');
  {
    const usage = load('nativeUsageToOpenAI');
    // 依赖注入：scan 内部会调 usage 归一函数 → 两个一起抠出来
    const scan = new Function(extract('nativeUsageToOpenAI') + '\n' + extract('nativeStreamUsageScan') + '\nreturn nativeStreamUsageScan;')();
    check('anthropic usage 归一', JSON.stringify(usage('anthropic', { usage: { input_tokens: 11, output_tokens: 7 } })) === JSON.stringify({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }));
    check('gemini usageMetadata 归一', JSON.stringify(usage('gemini', { usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 } })) === JSON.stringify({ prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }));
    check('没有 usage / 非对象 → null（退回估算，不编数字）', usage('anthropic', {}) === null && usage('openai', { usage: {} }) === null && usage('anthropic', null) === null);
    check('anthropic 流式：message_start 的输入 + message_delta 的输出各归各位',
      (() => {
        let acc = null;
        acc = scan('anthropic', 'event: message_start', acc);
        acc = scan('anthropic', 'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}', acc);
        acc = scan('anthropic', 'data: {"type":"message_delta","usage":{"output_tokens":3}}', acc);
        return JSON.stringify(acc) === JSON.stringify({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
      })());
    check('gemini 流式：最后一个 chunk 的 usageMetadata 会被读到',
      JSON.stringify(scan('gemini', 'data: {"candidates":[],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":6}}', null)) === JSON.stringify({ prompt_tokens: 2, completion_tokens: 6, total_tokens: 8 }));
    check('不认识的行不动累积值（[DONE] / 空行 / 半截 JSON）',
      (() => {
        const acc = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
        const a = scan('anthropic', 'data: [DONE]', acc);
        const b = scan('anthropic', 'data: {oops', a);
        return a.prompt_tokens === 1 && b.completion_tokens === 2;
      })());
  }

  /* ══════════ 2. 真链路 ══════════ */
  const UP = await freePort(), GW = await freePort();
  const fake = makeFakeUpstream();
  await new Promise((r) => fake.server.listen(UP, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'c.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW,
    health: { intervalSec: 3600, timeoutMs: 8000 },
    channels: [
      { id: 'ant-native', name: 'Anthropic原生', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${UP}`, apiKey: 'sk-ant-test', priority: 1, models: { 'claude-x': 'claude-3-5-sonnet-20241022' } },
      { id: 'ant-openai', name: 'OpenAI中转', protocol: 'openai', baseUrl: `http://127.0.0.1:${UP}/v1`, apiKey: 'sk-oai-test', priority: 5, models: { 'claude-cv': 'gpt-x' } },
      { id: 'gem-native', name: 'Gemini原生', protocol: 'gemini', baseUrl: `http://127.0.0.1:${UP}`, apiKey: 'goog-test', priority: 3, models: { 'gem-x': 'gemini-2.5-pro' } },
      // v1.18.32：这条渠道的上游只回 message_start + message_stop（零内容帧）——直通空流用
      { id: 'ant-empty', name: 'Anthropic空流', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${UP}`, apiKey: 'sk-ant-empty', priority: 7, models: { 'claude-empty': 'claude-empty-up' } },
    ],
  }));
  const gwEnv = { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'u.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' };
  let gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: gwEnv, stdio: 'ignore' });
  const stop = (cp) => new Promise((res) => {
    if (!cp || cp.exitCode !== null || cp.signalCode !== null) return res();
    cp.once('exit', () => res());
    try { cp.kill(); } catch { }
    setTimeout(res, 1500);
  });
  const AH = { Authorization: `Bearer ${AD_KEY}`, 'Content-Type': 'application/json' };
  const waitUp = async () => { for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${GW}/healthz`)).ok) return true; } catch { } await sleep(150); } return false; };
  const post = (p, body, stream) => fetch(`http://127.0.0.1:${GW}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GW_KEY}`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ code: r.status, text: await r.text(), chan: r.headers.get('x-zzcsapi-channel'), ctype: r.headers.get('content-type') }));
  const lastHit = (re) => [...fake.hits].reverse().find((h) => re.test(h.url) && h.method === 'POST');
  const adminGet = (p) => fetch(`http://127.0.0.1:${GW}${p}`, { headers: AH }).then((r) => r.json());

  try {
    check('临时网关起来了', await waitUp());
    // 等到三个渠道都被探活过（否则可能在冷却里）
    for (let i = 0; i < 30; i++) {
      const st = await adminGet('/admin/api/status');
      const ok = ['ant-native', 'ant-openai', 'gem-native', 'ant-empty'].every((id) => { const c = st.channels.find((x) => x.id === id); return c && c.status === 'ok'; });
      if (ok) break;
      await sleep(300);
    }

    console.log('\n2. Anthropic 客户端 → Anthropic 渠道（非流式直通）');
    {
      const clientBody = {
        model: 'claude-x', max_tokens: 64,
        system: [{ type: 'text', text: 'S1', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'S2' }],
        top_k: 7,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        metadata: { user_id: 'u-1' },
        stop_sequences: ['\n\n'],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping', cache_control: { type: 'ephemeral' } }] }],
      };
      fake.mode = 'ok';
      // 上游回一个带 thinking 块 + cache_control 的原生响应（内部格式承载不了 thinking，转换路径会丢掉它）
      fake.anthropicBody = JSON.stringify({
        id: 'msg_pt', type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-20241022',
        content: [
          { type: 'thinking', thinking: '先想一下', signature: 'sig-xyz' },
          { type: 'text', text: 'pong', cache_control: { type: 'ephemeral' } },
        ],
        stop_reason: 'end_turn', stop_sequence: '\n\n',
        usage: { input_tokens: 11, output_tokens: 7 },
      });
      const r = await post('/anthropic/v1/messages', clientBody);
      const hit = lastHit(/\/v1\/messages$/);
      check('★ 上游收到的是**原生 Anthropic 报文**（URL /v1/messages）', !!hit, fake.hits.map((h) => h.url));
      check('★ model 被换成渠道的上游名，其余一字未改', hit && hit.body.model === 'claude-3-5-sonnet-20241022', hit && hit.body.model);
      check('★ thinking / top_k / metadata / stop_sequences 全部原样到达（转换路径会丢）',
        hit && hit.body.thinking && hit.body.thinking.budget_tokens === 1024 && hit.body.top_k === 7
        && hit.body.metadata && hit.body.metadata.user_id === 'u-1' && JSON.stringify(hit.body.stop_sequences) === JSON.stringify(['\n\n']),
        hit && hit.body);
      check('★ 多段 system + cache_control 原样保留（内部格式只有"一段 system 字符串"）',
        hit && Array.isArray(hit.body.system) && hit.body.system.length === 2
        && hit.body.system[0].cache_control && hit.body.system[0].cache_control.type === 'ephemeral', hit && hit.body.system);
      check('★ body 里的 cache_control 也没被剥掉',
        hit && hit.body.messages[0].content[0].cache_control && hit.body.messages[0].content[0].cache_control.type === 'ephemeral');
      check('出站鉴权头是原生 Anthropic 那一套', hit && hit.headers['x-api-key'] === 'sk-ant-test' && hit.headers['anthropic-version'] === '2023-06-01', hit && hit.headers);
      check('★ 客户端拿到的响应与上游**逐字节一致**（没有任何重排/翻译）', r.text === fake.anthropicBody, { got: r.text.slice(0, 160) });
      check('★ thinking 块活着回到客户端（这正是直通要保的东西）', /"type":"thinking"/.test(r.text) && /sig-xyz/.test(r.text));
      check('响应头带渠道标记，Content-Type 照抄上游', r.chan === 'ant-native' && /application\/json/.test(r.ctype), { chan: r.chan, ctype: r.ctype });
      const u = await adminGet('/admin/api/usage');
      const last = u.recent[0];
      check('★ 直通路径仍记**真实** token（11 进 / 7 出，不是估算）',
        last && last.channelId === 'ant-native' && last.in === 11 && last.out === 7, last);
    }

    console.log('\n3. Anthropic 客户端 → Anthropic 渠道（流式字节级直通）');
    {
      fake.mode = 'anthropic-stream';
      fake.anthropicSSE = [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_s","role":"assistant","usage":{"input_tokens":5,"output_tokens":1}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"pong"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":1}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n');
      const r = await post('/anthropic/v1/messages', {
        model: 'claude-x', max_tokens: 32, stream: true,
        thinking: { type: 'enabled', budget_tokens: 512 },
        messages: [{ role: 'user', content: 'ping' }],
      });
      const hit = lastHit(/\/v1\/messages$/);
      check('★ 流式请求也是原生报文（stream:true + thinking 原样）', hit && hit.body.stream === true && hit.body.thinking && hit.body.thinking.budget_tokens === 512, hit && hit.body);
      check('★ SSE 与上游逐字节一致（连分隔空行都没动）', r.text === fake.anthropicSSE, { got: r.text.slice(0, 200) });
      check('★ message_start 只出现一次（旧路径会由网关的 streamPrelude 再补一个）',
        (r.text.match(/event: message_start/g) || []).length === 1, (r.text.match(/event: message_start/g) || []).length);
      check('★ thinking_delta 事件原样到达（转换路径根本不存在这种块）', /thinking_delta/.test(r.text) && /"想"/.test(r.text));
      check('没有网关臆造的 [DONE]（原生协议里没有这种东西）', !/\[DONE\]/.test(r.text));
      check('Content-Type 照抄上游的 text/event-stream', /text\/event-stream/.test(r.ctype), r.ctype);
      await sleep(120);
      const u = await adminGet('/admin/api/usage');
      const last = u.recent[0];
      check('★ 流式直通也记真实 token（5 进 / 3 出）',
        last && last.in === 5 && last.out === 3, last);
    }

    console.log('\n3b. 直通路径的「200 + 零正文」：如实记失败、不谎报成功（v1.18.32）');
    {
      // 上游只发 message_start + message_stop（**零 content_block_delta**）：客户端拿到的是空回复。
      // 直通是边收边写（`headCommitted` 恒真、字节已经出去了），所以这一发**换不了家**——
      // 本节验证的是另两件：账本不许记成功、这家必须被记失败（下一发才会退避/换家）。
      const r = await post('/anthropic/v1/messages', {
        model: 'claude-empty', max_tokens: 32, stream: true,
        messages: [{ role: 'user', content: 'ping' }],
      });
      const hit = lastHit(/\/v1\/messages$/);
      check('★ 上游确实收到了这一发（原生报文、模型名已换成渠道的上游名）', !!hit && hit.body.model === 'claude-empty-up', hit && hit.body.model);
      check('★ 客户端仍拿到 200 + 上游原始 SSE（字节已写出、按设计换不了家）',
        r.code === 200 && r.text === EMPTY_ANTHROPIC_SSE && /message_start/.test(r.text) && /message_stop/.test(r.text),
        { code: r.code, got: r.text.slice(0, 200) });
      check('响应头带渠道标记', r.chan === 'ant-empty', r.chan);
      await sleep(200);
      const u = await adminGet('/admin/api/usage');
      const rows = (u.recent || []).filter((x) => x.channelId === 'ant-empty');
      check('★ 用量行如实记 ok:false（不再"200 + 空 = 成功"）', rows.length > 0 && rows.some((x) => x.ok === false), rows);
      check('★ 失败行备注写明「200 但零正文」', rows.some((x) => /no content|零正文/.test(String(x.note || ''))), rows);
      const st = await adminGet('/admin/api/status');
      const ch = (st.channels || []).find((x) => x.id === 'ant-empty');
      check('★ 该渠道被记了失败（lastError 写明 stream empty + consecutiveFail ≥ 1，下一发才会退避）',
        !!ch && /stream empty/.test(String(ch.lastError || '')) && Number(ch.consecutiveFail) >= 1,
        ch && { lastError: ch.lastError, consecutiveFail: ch.consecutiveFail });
      check('对照：这条判据没碰前面那些**正常**直通流（§2 非流式 / §3 流式之后 ant-native 仍是零欠账）',
        (st.channels || []).filter((x) => x.id === 'ant-native').every((x) => Number(x.consecutiveFail) === 0),
        (st.channels || []).map((x) => ({ id: x.id, f: x.consecutiveFail })));
    }

    console.log('\n4. Gemini 客户端 → Gemini 渠道（直通）');
    {
      fake.mode = 'ok';
      const clientBody = {
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
        generationConfig: { temperature: 0.3, seed: 42, thinkingConfig: { thinkingBudget: 512 } },
      };
      fake.geminiBody = JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'pong' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
        modelVersion: 'gemini-2.5-pro-001',
      });
      const r = await post('/gemini/v1beta/models/gem-x:generateContent', clientBody);
      const hit = lastHit(/:generateContent/);
      check('★ 上游 URL 用**渠道的上游模型名**（gemini 的模型名在路径里）', hit && /\/v1beta\/models\/gemini-2\.5-pro:generateContent$/.test(hit.url), hit && hit.url);
      check('★ seed / thinkingConfig / safetySettings 原样到达（转换路径会丢）',
        hit && hit.body.generationConfig && hit.body.generationConfig.seed === 42
        && hit.body.generationConfig.thinkingConfig && hit.body.generationConfig.thinkingConfig.thinkingBudget === 512
        && Array.isArray(hit.body.safetySettings), hit && hit.body);
      check('出站鉴权头是原生 Gemini 那一套', hit && hit.headers['x-goog-api-key'] === 'goog-test', hit && hit.headers);
      check('★ 客户端拿到的响应与上游逐字节一致', r.text === fake.geminiBody, { got: r.text.slice(0, 160) });
      check('响应头带渠道标记', r.chan === 'gem-native', r.chan);
      await sleep(120);
      const u = await adminGet('/admin/api/usage');
      const last = u.recent[0];
      check('★ 真实 token（9 进 / 4 出）', last && last.in === 9 && last.out === 4, last);

      // 流式：alt=sse
      fake.mode = 'ok';
      fake.geminiBody = 'data: {"candidates":[{"content":{"parts":[{"text":"po"}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"ng"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":6}}\n\n';
      const rs = await post('/gemini/v1beta/models/gem-x:streamGenerateContent', { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] });
      const hits = lastHit(/:streamGenerateContent/);
      check('★ 流式动作走 :streamGenerateContent?alt=sse', hits && /:streamGenerateContent\?alt=sse/.test(hits.url), hits && hits.url);
      check('★ SSE 逐字节一致', rs.text === fake.geminiBody, { got: rs.text.slice(0, 160) });
      await sleep(120);
      const u2 = await adminGet('/admin/api/usage');
      check('★ 流式真实 token（2 进 / 6 出）', u2.recent[0] && u2.recent[0].in === 2 && u2.recent[0].out === 6, u2.recent[0]);
    }

    console.log('\n5. 对照组：协议不同仍走转换（直通没有把老路弄丢）');
    {
      fake.oaiReply = { id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'cv' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
      const r = await post('/anthropic/v1/messages', {
        model: 'claude-cv', max_tokens: 32, system: 'SYS', top_k: 9,
        messages: [{ role: 'user', content: 'ping' }],
      });
      const hit = lastHit(/\/chat\/completions$/);
      check('★ OpenAI 渠道收到的是**转换后**的 OpenAI 报文（system 提到 messages[0]）',
        hit && hit.body.messages && hit.body.messages[0].role === 'system' && hit.body.messages[0].content === 'SYS', hit && hit.body.messages);
      check('★ 转换路径照旧丢掉内部格式没有的字段（top_k 不会出现在 OpenAI 报文里）', hit && hit.body.top_k === undefined, hit && hit.body);
      const j = (() => { try { return JSON.parse(r.text); } catch { return null; } })();
      check('★ 客户端仍拿到 Anthropic 形态的响应（content[] + usage.input_tokens）',
        !!j && Array.isArray(j.content) && j.content[0].text === 'cv' && j.usage && j.usage.input_tokens === 2, j);
    }
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message) + '\n' + (e && e.stack ? String(e.stack).split('\n').slice(1, 4).join('\n') : ''));
  } finally {
    await stop(gw);
    try { fake.server.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;
})();
