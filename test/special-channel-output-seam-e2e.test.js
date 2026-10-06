#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/special-channel-output-seam-e2e.test.js
 *   专用报文渠道的**输出收口**：任一客户端面都必须收到自己那套报文
 *                                            （装配守卫 + 真链路，零依赖）
 *
 * 现场证据（v1.18.38，公网实例实测）：`/v1/responses` 客户端打到 **notion 渠道**，
 * 收到的是 `{"object":"chat.completion","id":"chatcmpl-notion-…"}` —— 不是 Responses 报文。
 *
 * 根因（两层，缺一层都修不好）：
 *   ① `tryChannel` 分派这五条"专用报文"路径（notion / notion-agent / workbuddy /
 *      genspark / codex）时，只透传了 res/body/candidate/…，把
 *      `onSuccessNonStream` / `onStreamChunk` / `streamPrelude` / `streamEpilogue`
 *      **四个输出钩子全丢了** —— 代码注释里写着"anthropic 入口经 onStreamChunk 转换"，
 *      可钩子根本没传进来（注释描述的是意图，代码漏了转发）。
 *   ② 这五条路径因此只能**自己写响应**：非流式 `res.end(JSON.stringify(chat 报文))`、
 *      流式 `res.write(chat SSE 行)`。OpenAI 客户端面看不出问题（那本来就是要的形态），
 *      但 Anthropic / Gemini / OpenAI Responses 客户端会拿到错形态；
 *      而且流式连 `streamPrelude` 都没有 → Anthropic 面没有 `message_start`、
 *      Responses 面没有 `response.created`（客户端会一直等第一帧）。
 *
 * 处置：钩子转发 + 四个收口 helper（specialNonStreamOut / specialStreamHead /
 *       specialStreamLine / specialStreamEnd），五条路径统一走它们。
 *       **对 OpenAI 面字节等价**：handleOpenAIRequest 只设 onSuccessNonStream、
 *       不设 onStreamChunk/prelude/epilogue，所以老路一个字节都没变（§6 对照守着）。
 *
 * 覆盖面刻意用**两条真的会被选中的渠道**：
 *   · workbuddy —— openai 类候选链里有它（Responses 面就靠它，上游只需 SSE）
 *   · notion    —— anthropic / gemini 两条候选链里**只有** notion / notion-agent / codex
 *                  （workbuddy / genspark 不在那两条链里，这是调度语义，不是本用例的范围），
 *                  所以"Anthropic 面 / Gemini 面"的断言必须用 notion 渠道才打得到
 *
 * 跑法：node test/special-channel-output-seam-e2e.test.js  （退出码非 0 = 有回归）
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-seam-'));
const GW_KEY = 'seam-gw', AD_KEY = 'seam-admin';
const JWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl';

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
// 取一个**顶层函数**的源码：从 `function name(` 到下一个顶格 `function`/`async function`。
// 刻意不用花括号配对——这五条路径里有正则字面量（`/^\s*data:/` 之类），朴素配对会把它算成结构。
function sliceFn(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('server.js 里找不到函数 ' + name + '（改名了？请同步本脚本）');
  const rest = SRC.slice(i + 1);
  const m = rest.match(/\n(?:async )?function [A-Za-z_$]/);
  return rest.slice(0, m ? m.index : rest.length);
}
const countOf = (hay, needle) => hay.split(needle).length - 1;
/* 五条专用报文路径（现场出问题的那条排第一） */
const SPECIAL = ['tryNotionChannel', 'tryNotionAgentChannel', 'tryWorkbuddyChannel', 'tryGensparkChannel', 'tryCodexChannel'];
/* SSE 解析小工具：把响应体拆成 [{event, data}]（OpenAI 面没有 event 行，event 为 null） */
function parseSSE(text) {
  const out = [];
  for (const blk of String(text).split(/\n\n/)) {
    let ev = null, data = [];
    for (const ln of blk.split('\n')) {
      if (ln.startsWith('event:')) ev = ln.slice(6).trim();
      else if (ln.startsWith('data:')) data.push(ln.slice(5).trim());
    }
    if (data.length) out.push({ event: ev, data: data.join('\n') });
  }
  return out;
}

/* 假 WorkBuddy 上游：只有 POST /v2/chat/completions，且**只回 SSE**（上游强制流式） */
function makeWbFake() {
  const st = { hits: 0, lastBody: null };
  st.server = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      st.hits++;
      try { st.lastBody = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}'); } catch { st.lastBody = null; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"wb","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n');
      res.write('data: {"id":"wb","choices":[{"index":0,"delta":{"content":"pong"}}]}\n\n');
      res.write('data: {"id":"wb","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  return st;
}

/* 假 Notion 上游：getSpaces（发现账号）+ runInferenceTranscript（NDJSON，record-map 权威全文） */
function makeNotionFake() {
  const st = { hits: 0, getSpaces: 0, transcripts: 0, lastBody: null, text: 'pong' };
  // 一条 record-map 行 = Notion 的权威全文（createNotionStreamParser → extractFinalFromRecordMap：
  //   md.value.value = iv，iv.step.type='markdown-chat'，正文在 step.value[].content）
  const ndjson = () => {
    const iv = {
      step: { type: 'markdown-chat', value: [{ type: 'text', content: st.text }] },
      last_edited_time: 1,
      created_time: 1,
    };
    const rm = { thread_message: { m1: { value: { value: iv } } } };
    return JSON.stringify({ type: 'record-map', recordMap: rm }) + '\n';
  };
  st.server = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      st.hits++;
      const url = req.url || '';
      if (url.includes('/getSpaces')) {
        st.getSpaces++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          'user-1': {
            space: { 'space-1': { value: { value: { name: 'Demo Space' } } } },
            space_view: { 'sv-1': { value: { value: { space_id: 'space-1' } } } },
            notion_user: { 'user-1': { value: { value: { given_name: 'Demo', email: 'demo@example.com' } } } },
          },
        }));
      }
      if (url.includes('/runInferenceTranscript')) {
        st.transcripts++;
        try { st.lastBody = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}'); } catch { st.lastBody = null; }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        return res.end(ndjson());
      }
      // 其余（用量资格等）一律空对象：调用方自己吞异常
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return st;
}

(async () => {
  /* ══════════ 1. 装配守卫（源码） ══════════ */
  console.log('1. 装配守卫：钩子必须转发，五条路径必须走收口');
  {
    // ① tryChannel 分派处把四个输出钩子一起传下去
    const at = SRC.indexOf('const specialOpts = {');
    const disp = SRC.slice(at, at + 900);
    check('★ tryChannel 的 specialOpts 转发 onSuccessNonStream', /onSuccessNonStream:\s*opts\.onSuccessNonStream/.test(disp));
    check('★ tryChannel 的 specialOpts 转发 onStreamChunk', /onStreamChunk:\s*opts\.onStreamChunk/.test(disp));
    check('★ tryChannel 的 specialOpts 转发 streamPrelude / streamEpilogue',
      /streamPrelude:\s*opts\.streamPrelude/.test(disp) && /streamEpilogue:\s*opts\.streamEpilogue/.test(disp));
    check('五条路径都拿同一个 specialOpts（不再各自拼字面量）',
      SPECIAL.every((f) => SRC.includes(f + '(specialOpts)')),
      SPECIAL.filter((f) => !SRC.includes(f + '(specialOpts)')));

    // ② 五条路径里不许再出现"自写响应"
    const bodies = SPECIAL.map((f) => sliceFn(f));
    const selfJson = bodies.map((b, i) => ({ f: SPECIAL[i], n: countOf(b, "res.writeHead(200, { 'Content-Type': 'application/json'") }));
    check('★ 五条路径里不再有"自写 200 JSON 响应"（非流式一律走 specialNonStreamOut）',
      selfJson.every((x) => x.n === 0), selfJson.filter((x) => x.n));
    const selfSse = bodies.map((b, i) => ({ f: SPECIAL[i], n: countOf(b, "'Content-Type': 'text/event-stream'") }));
    check('★ 五条路径里不再有"自写 SSE 响应头"（流式一律走 specialStreamHead）',
      selfSse.every((x) => x.n === 0), selfSse.filter((x) => x.n));
    const selfRaw = bodies.map((b, i) => ({ f: SPECIAL[i], n: countOf(b, 'res.write(') }));
    check('★ 五条路径里不再有裸 res.write（流式逐行一律走 specialStreamLine）',
      selfRaw.every((x) => x.n === 0), selfRaw.filter((x) => x.n));

    // ③ 调用点计数（改了任何一条路径却忘了收口，这里当场报错）
    check('specialNonStreamOut 调用 8 处（workbuddy 1 / genspark 2 / codex 1 / notion 2 / notion-agent 2）',
      countOf(SRC, 'await specialNonStreamOut(opts, candidate,') === 8, countOf(SRC, 'await specialNonStreamOut(opts, candidate,'));
    check('specialStreamHead 调用 5 处（每条路径恰好一次开场）', countOf(SRC, 'specialStreamHead(opts, candidate);') === 5, countOf(SRC, 'specialStreamHead(opts, candidate);'));
    check('specialStreamEnd 调用 5 处（每条路径恰好一次收尾）', countOf(SRC, 'specialStreamEnd(opts);') === 5, countOf(SRC, 'specialStreamEnd(opts);'));
    check('specialStreamLine 调用点 ≥ 20（逐行都过钩子）', countOf(SRC, 'specialStreamLine(opts, candidate,') >= 20, countOf(SRC, 'specialStreamLine(opts, candidate,'));

    // ④ 语义守卫：钩子在 = 钩子说了算（空串不许回退成原始 OpenAI 报文）
    const lineFn = sliceFn('specialStreamLine');
    const hookBranch = lineFn.slice(lineFn.indexOf('onStreamChunk'), lineFn.indexOf('rawFallback === undefined'));
    check('★ specialStreamLine：有钩子时只写钩子的返回、**绝不回退写原始行**',
      /if \(o\) opts\.res\.write\(o\);\s*return;/.test(hookBranch) && !/opts\.res\.write\(line/.test(hookBranch), hookBranch.slice(0, 220));
    check('★ specialStreamLine：没有钩子（OpenAI 客户端面）时才写原始行', /opts\.res\.write\(rawFallback === undefined \? line : rawFallback\)/.test(lineFn));
    const headFn = sliceFn('specialStreamHead');
    check('★ specialStreamHead 写头后立刻发 streamPrelude（Responses 的 response.created / Anthropic 的 message_start）',
      headFn.indexOf('streamPrelude') > headFn.indexOf('writeHead'));
    const endFn = sliceFn('specialStreamEnd');
    check('★ specialStreamEnd 先发 streamEpilogue 再 end()（补 finish_reason / [DONE] / message_stop）',
      endFn.indexOf('streamEpilogue') < endFn.indexOf('opts.res.end()'));
    check('specialNonStreamOut 有钩子就交给钩子、没有才自己写（OpenAI 面字节等价）',
      /if \(typeof opts\.onSuccessNonStream === 'function'\)/.test(sliceFn('specialNonStreamOut')));
  }

  /* ══════════ 2. 真链路：两条专用协议渠道 × 四套客户端面 ══════════ */
  const UP = await freePort(), UP2 = await freePort(), GW = await freePort();
  const wbfake = makeWbFake(), nfake = makeNotionFake();
  await new Promise((r) => wbfake.server.listen(UP, '127.0.0.1', r));
  await new Promise((r) => nfake.server.listen(UP2, '127.0.0.1', r));
  const cfgPath = path.join(TMP, 'c.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW,
    health: { intervalSec: 3600, timeoutMs: 8000 },
    channels: [
      {
        id: 'wb', name: 'WorkBuddy', protocol: 'workbuddy',
        baseUrl: `http://127.0.0.1:${UP}/v2`, apiKey: JWT,
        priority: 1, enabled: true, models: { 'seam-wb': 'deepseek-v4.1-flash' },
      },
      {
        id: 'nt', name: 'Notion', protocol: 'notion',
        baseUrl: `http://127.0.0.1:${UP2}`, apiKey: 'mock-token-v2',
        priority: 1, enabled: true, models: { 'seam-nt': 'gpt-5.6-sol' },
      },
    ],
  }));
  const env = { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'u.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' };
  const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: 'ignore' });
  const stop = () => new Promise((res) => {
    if (!gw || gw.exitCode !== null || gw.signalCode !== null) return res();
    gw.once('exit', () => res());
    try { gw.kill(); } catch { }
    setTimeout(res, 1500);
  });
  const base = `http://127.0.0.1:${GW}`;
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY };
  const post = async (p, body, headers = H) => {
    const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
    return { code: r.status, ct: r.headers.get('content-type') || '', text: await r.text() };
  };
  const jparse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const waitUp = async () => { for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/healthz')).ok) return true; } catch { } await sleep(150); } return false; };

  try {
    check('临时网关起来了（workbuddy + notion 两条专用协议渠道）', await waitUp());

    console.log('\n2. OpenAI Responses 面 × notion 渠道（公网现场就坏在这）');
    {
      const r = await post('/v1/responses', { model: 'seam-nt', input: 'ping', max_output_tokens: 64 });
      const j = jparse(r.text);
      check('HTTP 200', r.code === 200, { code: r.code, text: r.text.slice(0, 200) });
      check('★ 拿到的是 Responses 报文（object:"response"），不是 chat.completion',
        !!(j && j.object === 'response'), j && { object: j.object, id: j.id, keys: Object.keys(j).slice(0, 8) });
      check('★ id 是 resp_ 前缀（不是 chatcmpl-notion-…）', !!(j && /^resp_/.test(j.id || '')), j && j.id);
      check('★ 正文在 output_text', !!(j && j.output_text === 'pong'), j && j.output_text);
      check('output[] 里有 message item', !!(j && (j.output || []).some((o) => o.type === 'message')));
      check('不是裸 chat 报文（choices 不许出现）', !(j && j.choices));

      const sr = await post('/v1/responses', { model: 'seam-nt', input: 'ping', stream: true, max_output_tokens: 64 });
      const evs = parseSSE(sr.text);
      const types = evs.map((e) => e.event);
      check('流式 200 + text/event-stream', sr.code === 200 && /text\/event-stream/.test(sr.ct), sr.ct);
      check('★ 事件序列有 response.created（streamPrelude 真被调到了）', types.includes('response.created'), types.slice(0, 6));
      check('★ 事件序列有 response.output_text.delta', types.includes('response.output_text.delta'), types);
      check('★ 事件序列以 response.completed 收尾', types[types.length - 1] === 'response.completed', types.slice(-3));
      check('★ 每个 data 行都配一个 event 行（没有 chat 形态的裸 data 行漏进来）',
        evs.every((e) => e.event) && !/chatcmpl-notion/.test(sr.text), evs.filter((e) => !e.event).slice(0, 2));
      check('流里没有 chat.completion.chunk 字样', !/chat\.completion\.chunk/.test(sr.text));
    }

    console.log('\n3. OpenAI Responses 面 × workbuddy 渠道（另一条专用路径，上游只回 SSE）');
    {
      const r = await post('/v1/responses', { model: 'seam-wb', input: 'ping', max_output_tokens: 64 });
      const j = jparse(r.text);
      check('★ 同样是 Responses 报文（不是 chat.completion / 不是 chatcmpl-wb-…）',
        r.code === 200 && !!(j && j.object === 'response' && /^resp_/.test(j.id || '')), j && { object: j.object, id: j.id });
      check('★ 正文在 output_text（由上游 chat delta 拼出来）', !!(j && j.output_text === 'pong'), j && j.output_text);
      check('usage 按 Responses 口径（input_tokens）', !!(j && j.usage && typeof j.usage.input_tokens === 'number'), j && j.usage);

      const sr = await post('/v1/responses', { model: 'seam-wb', input: 'ping', stream: true, max_output_tokens: 64 });
      const types = parseSSE(sr.text).map((e) => e.event);
      check('★ 流式有 response.created + response.output_text.delta + response.completed',
        types.includes('response.created') && types.includes('response.output_text.delta') && types[types.length - 1] === 'response.completed', types);
      check('流里没有 chatcmpl-wb 字样', !/chatcmpl-wb/.test(sr.text));
    }

    console.log('\n4. Anthropic 面 × notion 渠道（此前会拿到 OpenAI 报文 / 流式没有 message_start）');
    {
      const r = await post('/anthropic/v1/messages', { model: 'seam-nt', max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] });
      const j = jparse(r.text);
      check('HTTP 200', r.code === 200, { code: r.code, text: r.text.slice(0, 200) });
      check('★ 拿到的是 Anthropic 报文（type:"message"），不是 chat.completion',
        !!(j && j.type === 'message'), j && { type: j.type, object: j.object, keys: Object.keys(j || {}).slice(0, 8) });
      check('★ 正文在 content[0].text', !!(j && j.content && j.content[0] && j.content[0].text === 'pong'), j && j.content);
      check('stop_reason 已映射（不是 finish_reason 原样漏出）', !!(j && j.stop_reason === 'end_turn'), j && j.stop_reason);
      check('不是裸 chat 报文（choices 不许出现）', !(j && j.choices));

      const sr = await post('/anthropic/v1/messages', { model: 'seam-nt', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'ping' }] });
      const types = parseSSE(sr.text).map((e) => e.event);
      check('★ 流式有 message_start（此前这条路径没有开场钩子，客户端一直等第一帧）', types.includes('message_start'), types.slice(0, 6));
      check('★ 流式有 content_block_delta 与 message_stop 收尾', types.includes('content_block_delta') && types.includes('message_stop'), types);
      check('流里没有 chat.completion.chunk 字样', !/chat\.completion\.chunk/.test(sr.text));
    }

    console.log('\n5. Gemini 面 × notion 渠道');
    {
      const r = await post('/gemini/v1beta/models/seam-nt:generateContent', { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] });
      const j = jparse(r.text);
      check('HTTP 200', r.code === 200, { code: r.code, text: r.text.slice(0, 200) });
      check('★ 拿到的是 Gemini 报文（candidates[0].content.parts[0].text）',
        !!(j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0].text === 'pong'),
        j && JSON.stringify(j).slice(0, 240));
      check('不是裸 chat 报文（choices 不许出现）', !(j && j.choices));
    }

    console.log('\n6. 对照：OpenAI 面一个字节都没变（钩子转发不得改变老路）');
    {
      const r = await post('/v1/chat/completions', { model: 'seam-nt', messages: [{ role: 'user', content: 'ping' }] });
      const j = jparse(r.text);
      check('★ notion 渠道的 OpenAI 面仍是 chat.completion（object/choices/id 前缀都在）',
        !!(j && j.object === 'chat.completion' && j.choices && /^chatcmpl-notion-/.test(j.id || '')), j && { object: j.object, id: j.id });
      check('正文仍是 pong', !!(j && j.choices[0].message.content === 'pong'), j && j.choices && j.choices[0]);

      const w = await post('/v1/chat/completions', { model: 'seam-wb', messages: [{ role: 'user', content: 'ping' }] });
      const wj = jparse(w.text);
      check('★ workbuddy 渠道的 OpenAI 面仍是 chat.completion + 正文 + usage',
        !!(wj && wj.object === 'chat.completion' && wj.choices[0].message.content === 'pong' && wj.usage && wj.usage.prompt_tokens === 3), wj && wj.object);

      const sr = await post('/v1/chat/completions', { model: 'seam-wb', stream: true, messages: [{ role: 'user', content: 'ping' }] });
      check('★ 流式仍是原始 OpenAI SSE（裸 data 行 + [DONE]，一个 event 行都没有）',
        sr.code === 200 && /^data: \{/m.test(sr.text) && sr.text.includes('data: [DONE]') && !/^event: /m.test(sr.text),
        sr.text.slice(0, 160));
      check('流式正文仍是 pong，且上游 id 原样透传（OpenAI 面是字节透传，不许被改写）',
        /"content":"pong"/.test(sr.text) && /"id":"wb"/.test(sr.text), sr.text.slice(0, 200));
    }

    console.log('\n7. 上游报文没被改动（收口只影响出口，不影响请求）');
    {
      check('workbuddy 上游收到强制流式的 OpenAI 报文（stream:true + 注入的 system 首条）',
        !!(wbfake.lastBody && wbfake.lastBody.stream === true && wbfake.lastBody.messages[0].role === 'system'),
        wbfake.lastBody && { stream: wbfake.lastBody.stream, first: wbfake.lastBody.messages[0].role });
      check('★ notion 上游收到的是 runInferenceTranscript 自己的报文（不是 OpenAI 报文）',
        !!(nfake.lastBody && nfake.transcripts >= 1 && !('messages' in nfake.lastBody)),
        nfake.lastBody && Object.keys(nfake.lastBody).slice(0, 8));
      check('notion 账号发现走的是 getSpaces（并只做一次，账号有缓存）', nfake.getSpaces === 1, nfake.getSpaces);
    }
  } finally {
    await stop();
    await new Promise((r) => wbfake.server.close(r));
    await new Promise((r) => nfake.server.close(r));
  }

  console.log('\n' + '─'.repeat(58));
  console.log((fail === 0 ? '✓ 全部通过' : '✗ 有失败') + `（${pass + fail} 项断言，通过 ${pass}，失败 ${fail}）`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
