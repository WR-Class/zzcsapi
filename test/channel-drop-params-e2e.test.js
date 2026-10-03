#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/channel-drop-params-e2e.test.js — 渠道级「不发这些参数」真链路 e2e（v1.18.33，真起进程，零依赖）
 *
 * 现场（本用例存在的唯一理由）：
 *   `agentrouter` 每天固定开放额度，但它对「`tools` + `reasoning_effort`」这个组合直接 400 ——
 *   `Function tools with reasoning_effort are not supported for gpt-6-astra`，
 *   而 DSH 每次请求都同时带这两样 → 这个渠道对我们 **19 行 0 成功**。
 *   客户端不由我们控制，所以开关必须做在**渠道**上：`dropParams`（白名单内、只在出站副本上剔）。
 *
 * 覆盖（每条都对应一条纪律，不是"顺手测一下"）：
 *   ① 纯函数真值表（现抠 server.js 的 DROP_PARAM_WHITELIST / normDropParams / dropParamsFrom）：
 *      白名单不含结构性字段、文本形态也认、白名单外静默丢弃、**没配时零拷贝（同一引用）**、
 *      **配了也不原地改入参对象**（只浅拷贝再删）；
 *   ② 真链路 ★ 主用例：渠道配 `['reasoning_effort']`，客户端带 tools + reasoning_effort →
 *      上游**收不到** reasoning_effort，但 **tools / tool_choice / temperature / messages 原样**，
 *      客户端仍拿到正常回复；
 *   ③ 真链路 对照组：没配 dropParams 的渠道 → 上游**照样收到** reasoning_effort（老配置行为一个字节不变）；
 *   ④ 真链路 ★ 不串味：候选链第一家配了 dropParams、第二家没配，**让第一家 500** →
 *      第二家收到的报文里 reasoning_effort **还在**（这是"绝不原地改共享 body"的唯一实证方式：
 *      body 是同一个对象引用，被整条候选链共用，原地删就会把 A 家的怪癖串味给 B 家）；
 *   ⑤ 真链路 ★ 同协议直通也生效：anthropic 客户端 → anthropic 渠道走直通，渠道配 `['top_k']` →
 *      上游原始报文里没有 top_k，而 thinking / metadata / stop_sequences / max_tokens / messages
 *      逐字仍在（证明只删了指定的那一个，没有整份重造报文），且响应与上游逐字节一致；
 *   ⑥ 校验：白名单外的名字 → 400，文案带「只接受这些参数名」与那个不认识的名字；
 *      `messages` / `model` / `tools` / `stream` 这类结构性字段**必须被拒**（白名单存在的意义）；
 *   ⑦ 落库往返 + PT29：POST → 临时 config.json 真有它 → GET 读得回 → 再保存**另一个**渠道 /
 *      走轻量路径改**本渠道** priority 之后**仍在**（persistConfig 是显式字段清单，漏一行就被静默抹掉）；
 *   ⑧ 清空/沿用语义：显式空数组或空串 = 真清空；不传这个字段 = 沿用旧值；文本形态归一成数组；
 *   ⑨ `GET /admin/api/config` 下发 `dropParamWhitelist`（前端靠它渲染，不能漂移）；
 *   ⑩ 结构性守卫：装配点（常规链路 + 直通链路）、白名单纪律、三处字段接线都在；
 *   ⑪ ★ 边界（真链路 + 结构守卫）：`dropParams` 只覆盖**常规链路**与**同协议直通**。
 *      workbuddy / codex / genspark / notion-agent 自带专用报文构造、压根不经过那两处 →
 *      **配了也不生效**（字段照样保存、照样显示，报文里那几个参数不会被删）。这条边界刻意写成
 *      "断言这个事实"而不是"断言它生效"：静默不生效正是本次现场的病根之一，宁可钉死边界。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/channel-drop-params-e2e.test.js     （退出码非 0 表示有回归）
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-dropparam-e2e-'));
const CFG_PATH = path.join(TMP, 'config.json');
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// 现抠 server.js 里的一个实现块（与其它用例同一套纪律：跑真源码，不抄一份）
function sliceBetween(startMarker, endMarker) {
  const i = SRC.indexOf(startMarker);
  const j = SRC.indexOf(endMarker);
  if (i < 0 || j < 0 || j <= i) throw new Error(`extract: 找不到 ${startMarker} .. ${endMarker}`);
  return SRC.slice(i, j);
}

/* ── 假上游：按 apiKey 区分角色，并把每次收到的报文原样记下来 ── */
const seen = [];
const ANT_JSON = JSON.stringify({
  id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-up',
  content: [{ type: 'text', text: 'ant-ok' }], stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 2 },
});
const upstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
    const raw = Buffer.concat(cs).toString('utf8');
    const key = String(req.headers['x-api-key'] || String(req.headers.authorization || '').replace('Bearer ', ''));
    if (req.method === 'GET' && /models/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock' }], models: [{ name: 'models/mock' }] }));
    }
    let body = null; try { body = JSON.parse(raw); } catch { }
    seen.push({ key, url: req.url, body, raw });
    const mk = (payload, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); };
    if (/\/v1\/messages/.test(req.url)) return mk(ANT_JSON);
    // workbuddy（§11 边界用例）：/v2 下没有 /models，探测与对话都是这一条 SSE
    if (/\/v2\/chat\/completions/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n');
      res.write('data: {"id":"x","choices":[{"index":0,"delta":{"content":"pong"}}]}\n\n');
      res.write('data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
      return res.end('data: [DONE]\n\n');
    }
    if (key === 'sk-boom') return mk({ error: { message: 'Function tools with reasoning_effort are not supported for gpt-6-astra' } }, 500);
    return mk({ id: 'c', object: 'chat.completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  });
});
const lastFor = (key) => seen.filter((s) => s.key === key).pop() || null;

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
const readCfg = () => JSON.parse(fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, ''));

/* ═══════════════════════════════════════════════════════════════════════════ */
(async () => {
  /* ══════════ 1. 纯函数真值表（现抠真源码：白名单 / 归一 / 出站剔除） ══════════ */
  console.log('\n1. DROP_PARAM_WHITELIST / normDropParams / dropParamsFrom（现抠真源码）');
  const DP = new Function(sliceBetween('const DROP_PARAM_WHITELIST = [', '// ── OpenAI 请求')
    + '\nreturn { DROP_PARAM_WHITELIST, normDropParams, dropParamsFrom };')();
  const WL = DP.DROP_PARAM_WHITELIST;

  check('白名单含 reasoning_effort / temperature / top_k', ['reasoning_effort', 'temperature', 'top_k'].every((k) => WL.includes(k)));
  check('★ 白名单刻意不含结构性字段 messages / model / stream / tools',
    !['messages', 'model', 'stream', 'tools'].some((k) => WL.includes(k)), WL.filter((k) => ['messages', 'model', 'stream', 'tools'].includes(k)));

  check('数组形态：原样保留', eq(DP.normDropParams(['reasoning_effort']), ['reasoning_effort']));
  check('文本形态（逗号）："reasoning_effort, temperature" → 两项', eq(DP.normDropParams('reasoning_effort, temperature'), ['reasoning_effort', 'temperature']));
  check('文本形态（空白）：也能切', eq(DP.normDropParams('reasoning_effort temperature'), ['reasoning_effort', 'temperature']));
  check('去重：重复的名字只留一个', eq(DP.normDropParams(['temperature', 'temperature', 'temperature']), ['temperature']));
  check('白名单外的名字被静默丢弃（校验层会 400，运行时永远拿到干净数组）', eq(DP.normDropParams(['messages', 'foo', 'temperature']), ['temperature']));
  check('空数组 / 空串 / null / 缺省 → undefined（表示"没配"）',
    DP.normDropParams([]) === undefined && DP.normDropParams('') === undefined && DP.normDropParams(null) === undefined && DP.normDropParams(undefined) === undefined);

  const noCfg = { id: 'x', def: {} };
  const emptyCfg = { id: 'y', def: { dropParams: [] } };
  const body0 = { model: 'm', messages: [], reasoning_effort: 'high' };
  check('★ 没配 dropParams 的渠道：dropParamsFrom 返回**同一个对象引用**（零拷贝，老配置行为一字不变）',
    DP.dropParamsFrom(body0, noCfg) === body0 && DP.dropParamsFrom(body0, emptyCfg) === body0);
  check('非对象 body 原样返回（不炸）', DP.dropParamsFrom(null, { def: { dropParams: ['temperature'] } }) === null);

  const srcBody = { model: 'm', reasoning_effort: 'high', tools: [{ type: 'function' }], messages: [{ role: 'user', content: 'hi' }] };
  const outBody = DP.dropParamsFrom(srcBody, { def: { dropParams: ['reasoning_effort'] } });
  check('★ 配了则返回浅拷贝（不是同一个对象）', outBody !== srcBody);
  check('★ 绝不原地改入参：原对象里 reasoning_effort 还在（候选链共用的就是它）',
    srcBody.reasoning_effort === 'high' && !('reasoning_effort' in outBody));
  check('副本里其余键逐字保留（浅拷贝：嵌套引用共享）',
    eq(outBody.tools, srcBody.tools) && eq(outBody.messages, srcBody.messages) && outBody.model === 'm');

  /* ══════════ 2~5. 真链路 ══════════ */
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const UP = upstream.address().port;
  const port = await freePort();
  const base = `http://127.0.0.1:${UP}`;
  fs.writeFileSync(CFG_PATH, JSON.stringify({
    port, health: { intervalSec: 3600, timeoutMs: 3000 },
    channels: [
      // 主用例：配了 dropParams
      { id: 'dp', name: 'dp', protocol: 'openai', baseUrl: base, apiKey: 'sk-drop', enabled: true, priority: 10, models: { 'm-drop': 'mock-up' }, dropParams: ['reasoning_effort'] },
      // 对照组：没配
      { id: 'nodp', name: 'nodp', protocol: 'openai', baseUrl: base, apiKey: 'sk-keep', enabled: true, priority: 10, models: { 'm-keep': 'mock-up' } },
      // 不串味：同一别名的两家，第一家（配了）会 500，第二家（没配）接住
      { id: 'chain-a', name: 'chain-a', protocol: 'openai', baseUrl: base, apiKey: 'sk-boom', enabled: true, priority: 10, models: { 'm-chain': 'mock-up' }, dropParams: ['reasoning_effort'] },
      { id: 'chain-b', name: 'chain-b', protocol: 'openai', baseUrl: base, apiKey: 'sk-good', enabled: true, priority: 5, models: { 'm-chain': 'mock-up' } },
      // 同协议直通：anthropic 渠道
      { id: 'ant-pass', name: 'ant-pass', protocol: 'anthropic', baseUrl: base, apiKey: 'sk-ant', enabled: true, priority: 10, models: { 'claude-drop': 'claude-up' }, dropParams: ['top_k'] },
    ],
  }));
  const gw = startGateway(CFG_PATH, port);

  const post = async (p, body, headers) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST',
      headers: headers || { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { }
    return { status: r.status, text, json, headers: r.headers };
  };
  const ADMIN = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AD_KEY };
  const adminPost = (p, body) => post(p, body, ADMIN);
  const adminGet = async (p) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: 'Bearer ' + AD_KEY } });
    return { status: r.status, json: await r.json() };
  };
  const channelsById = async (id) => ((await adminGet('/admin/api/channels')).json.channels || []).find((c) => c.id === id) || null;

  const TOOLS = [{ type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
  const MSGS = [{ role: 'user', content: '帮我看下这个文件' }];
  const chatBody = (model) => ({ model, messages: MSGS, temperature: 0.42, tool_choice: 'auto', tools: TOOLS, reasoning_effort: 'high' });

  try {
    check('网关启动', await waitUp(port));

    /* ══════════ 2. ★ 主用例 ══════════ */
    console.log('\n2. ★ 主用例（openai 渠道配 dropParams:["reasoning_effort"]，客户端带 tools + reasoning_effort）');
    const r1 = await post('/v1/chat/completions', chatBody('m-drop'));
    check('客户端仍拿到正常回复（200 + 正文 ok）', r1.status === 200 && r1.json?.choices?.[0]?.message?.content === 'ok', { status: r1.status, text: r1.text.slice(0, 160) });
    check('响应头标出落点渠道 = dp', r1.headers.get('x-zzcsapi-channel') === 'dp', r1.headers.get('x-zzcsapi-channel'));
    const g1 = lastFor('sk-drop');
    check('上游确实收到了这一发', !!g1, seen.map((s) => s.key));
    check('★ 上游收到的报文里**没有** reasoning_effort', g1 && !('reasoning_effort' in g1.body), g1 && g1.body);
    check('★ tools 仍在（剔掉的是那个参数，不是工具能力）', g1 && eq(g1.body.tools, TOOLS));
    check('tool_choice 也还在（没配剔它，就不许动）', g1 && g1.body.tool_choice === 'auto');
    check('temperature 原样', g1 && g1.body.temperature === 0.42);
    check('messages 原样', g1 && eq(g1.body.messages, MSGS));
    check('model 换成上游名（链路其余行为不变）', g1 && g1.body.model === 'mock-up');

    /* ══════════ 3. 对照组 ══════════ */
    console.log('\n3. 对照组（没配 dropParams 的渠道：老配置行为一个字节不变）');
    const r2 = await post('/v1/chat/completions', chatBody('m-keep'));
    check('对照组请求成功', r2.status === 200 && r2.json?.choices?.[0]?.message?.content === 'ok', r2.status);
    const g2 = lastFor('sk-keep');
    check('★ 上游**照样收到** reasoning_effort', g2 && g2.body.reasoning_effort === 'high', g2 && g2.body);
    check('对照组 tools 也在', g2 && eq(g2.body.tools, TOOLS));
    const stripKey = (o) => { const c = { ...o }; delete c.reasoning_effort; return c; };
    check('★ 两组报文除 reasoning_effort 外**逐字段相同**（唯一差别就是那个开关）',
      g1 && g2 && eq(stripKey(g1.body), stripKey(g2.body)), { a: g1 && g1.body, b: g2 && g2.body });

    /* ══════════ 4. ★ 不串味（共享 body 绝不被原地改） ══════════ */
    console.log('\n4. ★ 不串味（第一家配了 dropParams 且失败 → 第二家仍须收到 reasoning_effort）');
    const mark = seen.length;
    const r3 = await post('/v1/chat/completions', chatBody('m-chain'));
    const hop = seen.slice(mark);
    const iA = hop.findIndex((s) => s.key === 'sk-boom');
    const iB = hop.findIndex((s) => s.key === 'sk-good');
    check('失败的第一家确实先被尝试，第二家后接住（iA < iB）', iA >= 0 && iB >= 0 && iA < iB, hop.map((s) => s.key));
    check('★ 第一家（配了 dropParams）收到时 reasoning_effort 已被剔掉', iA >= 0 && !('reasoning_effort' in hop[iA].body), hop[iA] && hop[iA].body);
    check('★ 第二家（没配）收到的报文里 reasoning_effort **还在**——共享 body 没被上一家改坏', iB >= 0 && hop[iB].body.reasoning_effort === 'high', hop[iB] && hop[iB].body);
    check('★ 第二家的 tools 也在（没有整份报文被打残）', iB >= 0 && eq(hop[iB].body.tools, TOOLS));
    check('客户端拿到第二家的正常回复（500 之后自动换家）',
      r3.status === 200 && r3.headers.get('x-zzcsapi-channel') === 'chain-b' && r3.json?.choices?.[0]?.message?.content === 'ok',
      { status: r3.status, ch: r3.headers.get('x-zzcsapi-channel') });

    /* ══════════ 5. ★ 同协议直通也生效 ══════════ */
    console.log('\n5. ★ 同协议直通（anthropic 客户端 → anthropic 渠道，配 dropParams:["top_k"]）');
    const THINKING = { type: 'enabled', budget_tokens: 1024 };
    const ANT_MSGS = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const antBody = {
      model: 'claude-drop', max_tokens: 64, top_k: 40, thinking: THINKING,
      metadata: { user_id: 'u-1' }, stop_sequences: ['\n\n', 'STOP'], messages: ANT_MSGS,
    };
    const r4 = await post('/anthropic/v1/messages', antBody, { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY, 'anthropic-version': '2023-06-01' });
    check('直通请求成功', r4.status === 200, { status: r4.status, text: r4.text.slice(0, 160) });
    check('★ 客户端拿到的响应与上游**逐字节一致**（直通保真没被这条新逻辑弄坏）', r4.text === ANT_JSON, r4.text.slice(0, 200));
    const g4 = lastFor('sk-ant');
    check('直通走的是原生 URL /v1/messages + x-api-key 头', g4 && g4.url === '/v1/messages' && g4.key === 'sk-ant', g4 && { url: g4.url, key: g4.key });
    check('★ 上游原始报文里**没有** top_k', g4 && !('top_k' in g4.body), g4 && g4.body);
    check('★ thinking 逐字在（只删了指定的那一个，没有整份重造报文）', g4 && eq(g4.body.thinking, THINKING));
    check('metadata 逐字在', g4 && eq(g4.body.metadata, { user_id: 'u-1' }));
    check('stop_sequences 逐字在', g4 && eq(g4.body.stop_sequences, ['\n\n', 'STOP']));
    check('messages / max_tokens 原样', g4 && eq(g4.body.messages, ANT_MSGS) && g4.body.max_tokens === 64);
    check('model 换成上游名', g4 && g4.body.model === 'claude-up');
    check('报文只少了 top_k 这一个键（键集合差集恰为 [top_k]）',
      g4 && eq(Object.keys(antBody).filter((k) => !(k in g4.body)), ['top_k']) && eq(Object.keys(g4.body).filter((k) => !(k in antBody)), []),
      g4 && Object.keys(g4.body));

    /* ══════════ 6. 校验 ══════════ */
    console.log('\n6. 校验（白名单外的名字必须 400，不静默忽略）');
    const badDef = (id, dp) => ({ id, name: id, baseUrl: base, apiKey: 'sk-x', protocol: 'openai', priority: 1, models: { 'm-bad': 'mock' }, dropParams: dp });
    for (const bad of ['messages', 'model', 'tools', 'stream', 'foo']) {
      const r = await adminPost('/admin/api/channels', badDef('bad-1', [bad]));
      check(`dropParams ['${bad}'] → 400`, r.status === 400, { status: r.status, text: r.text.slice(0, 200) });
      check(`文案带「只接受这些参数名」+「不认识：${bad}」`,
        /只接受这些参数名/.test(String(r.json?.error || '')) && new RegExp('（不认识：' + bad + '）').test(String(r.json?.error || '')),
        r.json && r.json.error);
    }
    check('被拒的渠道一个都没被创建', (await channelsById('bad-1')) === null);
    const rOk = await adminPost('/admin/api/channels', badDef('ok-1', ['reasoning_effort']));
    check('正对照：白名单内的名字 → 200 且真落库', rOk.status === 200 && eq((await channelsById('ok-1'))?.dropParams, ['reasoning_effort']), { status: rOk.status, ch: await channelsById('ok-1') });

    /* ══════════ 7. 落库往返 + PT29 ══════════ */
    console.log('\n7. 落库往返 + PT29（persistConfig 是显式字段清单，漏一行就被静默抹掉）');
    const rtDef = (extra) => ({ id: 'rt', name: 'rt', baseUrl: base, apiKey: 'sk-rt', protocol: 'openai', priority: 2, models: { 'm-rt': 'mock' }, ...extra });
    const r7 = await adminPost('/admin/api/channels', rtDef({ dropParams: ['temperature', 'seed'] }));
    check('POST 带 dropParams → 200', r7.status === 200, r7.text.slice(0, 160));
    check('临时 config.json 里真有它', eq((readCfg().channels || []).find((c) => c.id === 'rt')?.dropParams, ['temperature', 'seed']),
      (readCfg().channels || []).find((c) => c.id === 'rt'));
    check('GET /admin/api/channels 能读回', eq((await channelsById('rt'))?.dropParams, ['temperature', 'seed']));
    const r7b = await adminPost('/admin/api/channels', { id: 'rt2', name: 'rt2', baseUrl: base, apiKey: 'sk-rt2', protocol: 'openai', priority: 2, models: { 'm-rt2': 'mock' } });
    check('再保存**另一个**渠道 → 200', r7b.status === 200, r7b.text.slice(0, 160));
    check('★ PT29：另一个渠道保存后，rt 的 dropParams 仍在 config.json 里', eq((readCfg().channels || []).find((c) => c.id === 'rt')?.dropParams, ['temperature', 'seed']));
    check('★ PT29：GET 读回也仍在', eq((await channelsById('rt'))?.dropParams, ['temperature', 'seed']));
    const r7c = await adminPost('/admin/api/channel', { id: 'rt', priority: 3 });
    check('轻量路径改 priority → 200', r7c.status === 200, r7c.text.slice(0, 160));
    check('★ PT29：走轻量路径改本渠道 priority 之后 dropParams 仍在（config.json + GET 两处）',
      eq((readCfg().channels || []).find((c) => c.id === 'rt')?.dropParams, ['temperature', 'seed'])
      && eq((await channelsById('rt'))?.dropParams, ['temperature', 'seed']));

    /* ══════════ 8. 清空 / 沿用 / 文本形态 ══════════ */
    console.log('\n8. 清空语义 / 沿用语义 / 文本形态');
    await adminPost('/admin/api/channels', rtDef({ dropParams: [] }));
    check('显式空数组 = 真的清空（GET 里没有它，config.json 里也没有）',
      !(await channelsById('rt'))?.dropParams && !(readCfg().channels || []).find((c) => c.id === 'rt')?.dropParams,
      await channelsById('rt'));
    await adminPost('/admin/api/channels', rtDef({ dropParams: ['temperature'] }));
    check('先配上 ["temperature"]', eq((await channelsById('rt'))?.dropParams, ['temperature']));
    await adminPost('/admin/api/channels', rtDef({ priority: 4 }));   // 刻意不带 dropParams 字段
    check('不传这个字段 = 沿用旧值（与 weight 同款语义）', eq((await channelsById('rt'))?.dropParams, ['temperature']), await channelsById('rt'));
    await adminPost('/admin/api/channels', rtDef({ dropParams: 'reasoning_effort, temperature' }));
    check('文本形态 "reasoning_effort, temperature" → 归一成两项数组', eq((await channelsById('rt'))?.dropParams, ['reasoning_effort', 'temperature']), await channelsById('rt'));
    await adminPost('/admin/api/channels', rtDef({ dropParams: '' }));
    check('空串 = 清空', !(await channelsById('rt'))?.dropParams, await channelsById('rt'));

    /* ══════════ 9. GET /admin/api/config 下发白名单 ══════════ */
    console.log('\n9. GET /admin/api/config 下发 dropParamWhitelist（前端靠它渲染）');
    const cfgView = await adminGet('/admin/api/config');
    const wl = cfgView.json?.dropParamWhitelist;
    check('下发了 dropParamWhitelist 且是数组', Array.isArray(wl) && wl.length > 0, wl);
    check('★ 它含 reasoning_effort / top_k', Array.isArray(wl) && wl.includes('reasoning_effort') && wl.includes('top_k'));
    check('★ 它不含 messages / model / stream / tools（前端选项里就不该出现它们）',
      Array.isArray(wl) && !['messages', 'model', 'stream', 'tools'].some((k) => wl.includes(k)), wl && wl.filter((k) => ['messages', 'model', 'stream', 'tools'].includes(k)));
    check('下发的清单与运行时用的白名单逐字一致（同一份，不许漂移）', eq(wl, WL));

    /* ══════════ 10. 结构性守卫（防回潮） ══════════ */
    console.log('\n10. 结构性守卫（装配点）');
    check('常规链路装配点：encodeOutgoing(dropParamsFrom(body, ch), candidate)',
      /const outgoing = encodeOutgoing\(dropParamsFrom\(body, ch\), candidate\);/.test(SRC));
    check('直通链路装配点：passthroughChannelOpts 收到 chDef.dropParams',
      /: null\) \|\| opts\.rawClientBody, chDef && chDef\.dropParams\)/.test(SRC));
    check('直通链路内部只浅拷贝再删（strip 里是 { ...o } + delete，没有原地改）',
      /const strip = \(o\) => \{\s*\n\s*if \(!drops\.length\) return o;\s*\n\s*const c = \{ \.\.\.o \};/.test(SRC));
    check('字段接线三处齐全（persistConfig / GET channels / POST def 构造）',
      (SRC.match(/dropParams: ch\.def\.dropParams && ch\.def\.dropParams\.length \? ch\.def\.dropParams : undefined,/g) || []).length === 2
      && /dropParams: body\.dropParams !== undefined \? normDropParams\(body\.dropParams\) : \(prevDef \? prevDef\.dropParams : undefined\),/.test(SRC));
    check('校验层用的是同一个白名单常量（不是抄一份）',
      /const bad = raw\.map\(\(x\) => String\(x\)\.trim\(\)\)\.filter\(Boolean\)\.filter\(\(x\) => !DROP_PARAM_WHITELIST\.includes\(x\)\);/.test(SRC)
      && /dropParams 只接受这些参数名：\$\{DROP_PARAM_WHITELIST\.join\(', '\)\}（不认识：\$\{bad\.join\(', '\)\}）/.test(SRC));
    check('运行时剔除只此一处（dropParamsFrom 是唯一的 delete 出口）',
      (SRC.match(/function dropParamsFrom\(/g) || []).length === 1 && /const list = \(ch && ch\.def && ch\.def\.dropParams\) \|\| null;/.test(SRC));

    /* ══════════ 11. ★ 边界：自带专用报文构造的协议「配了也不生效」 ══════════ */
    console.log('\n11. ★ 边界（workbuddy / codex / genspark / notion-agent 自带专用报文构造，dropParams 不适用）');
    // 真链路：另起一个**只装 workbuddy 渠道**的实例——否则其它 openai 渠道的"冷启动兜底候选"
    // （channelsServing 在无显式/自动别名时会把所有同协议渠道塞进候选链）会抢走这一发。
    const wbCfg = path.join(TMP, 'cfg-wb.json');
    const wbPort = await freePort();
    fs.writeFileSync(wbCfg, JSON.stringify({
      port: wbPort, health: { intervalSec: 3600, timeoutMs: 8000 },
      channels: [{
        id: 'wb', name: 'wb', protocol: 'workbuddy', baseUrl: `${base}/v2`, apiKey: 'sk-wb',
        enabled: true, priority: 10, models: { 'wb-model': 'deepseek-v4.1-flash' },
        dropParams: ['reasoning_effort'],   // ← 配了，但这条链路不经过剔除点
      }],
    }));
    const gw2 = startGateway(wbCfg, wbPort);
    try {
      check('边界实例启动', await waitUp(wbPort));
      // 先等启动探测那一发落定（探测报文里本来就没有 reasoning_effort，混进来会污染下面的断言）
      for (let i = 0; i < 100 && !lastFor('sk-wb'); i++) await sleep(200);
      check('workbuddy 启动探测真打通了（证明这条链路是活的，不是被别的原因挡住）', !!lastFor('sk-wb'));
      const mark2 = seen.length;
      const r5 = await fetch(`http://127.0.0.1:${wbPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
        body: JSON.stringify(chatBody('wb-model')),
      });
      const t5 = await r5.text();
      check('边界：客户端仍拿到正常回复（渠道是好的，只是这个开关对它无效）', r5.status === 200 && /pong/.test(t5), { status: r5.status, text: t5.slice(0, 160) });
      const hops2 = seen.slice(mark2).filter((s) => s.key === 'sk-wb');
      check('边界：这一发确实走了 workbuddy 专用路径（上游收到 system 首条 + 被强制 stream:true）',
        hops2.length === 1 && hops2[0].body.stream === true && hops2[0].body.messages[0].role === 'system',
        hops2.map((s) => s.body));
      check('★ 边界：workbuddy 渠道**配了 dropParams 也不生效**——上游照样收到 reasoning_effort（专用报文构造不经过剔除点）',
        hops2.length === 1 && hops2[0].body.reasoning_effort === 'high', hops2[0] && hops2[0].body);
      check('边界：tools 也照样带出去（同上：整份报文都不经过剔除点）', hops2.length === 1 && eq(hops2[0].body.tools, TOOLS));
    } finally { gw2.kill('SIGKILL'); }

    const dedicated = ['tryWorkbuddyChannel', 'tryGensparkChannel', 'tryCodexChannel', 'tryNotionAgentChannel'];
    /* 取"函数体"不用括号配对：这几个处理器体内有模板串/正则里的花括号，朴素配对会当场抛
       "括号不配对"（本用例第一版就栽在这）。改用**从定义处到下一个顶层 async function 之间**的窗口——
       这四个都是顶层函数，窗口足以覆盖整个函数体，且不会因为内部格式变化而脆断。 */
    const windowOf = (name) => {
      const i = SRC.indexOf('async function ' + name + '(');
      if (i < 0) throw new Error('extract: 找不到 ' + name);
      const j = SRC.indexOf('\nasync function ', i + 1);
      return SRC.slice(i, j < 0 ? SRC.length : j);
    };
    const leaked = dedicated.filter((n) => /dropParams/.test(windowOf(n)));
    check('★ 四个自带专用报文构造的处理器里**都没有** dropParams（配了不生效的机制就在这）',
      leaked.length === 0, leaked);
    check('全仓 dropParamsFrom 只有「定义 + 唯一调用点」两处（没有第二个人偷偷剔除）',
      (SRC.match(/dropParamsFrom\(/g) || []).length === 2, (SRC.match(/dropParamsFrom\(/g) || []).length);
  } finally { gw.kill('SIGKILL'); }
  // 收尾纪律：不用硬 process.exit——kill 子进程与关假上游会和 Windows 上的 libuv 句柄关闭竞态，
  // 撞 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" 而让退出码变成 0xC0000409，
  // 全套件就会把一个全过的用例报成失败。先让句柄落定，再按 exitCode 自然退出。
  try { upstream.closeAllConnections(); } catch { }
  upstream.close();

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;
  await sleep(250);
})();
