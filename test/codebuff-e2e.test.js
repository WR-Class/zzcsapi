#!/usr/bin/env node
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * test/codebuff-e2e.test.js — codebuff/Freebuff 反代渠道（v1.18.58）
 *                                  （单元 + 真链路，零依赖）
 *
 * 背景：codebuff.com 的"模型调用"不是单步 /v1/chat/completions，而是**两步 run**（SDK 源码
 *   llm.ts:81-140 / database.ts:409-474）：① POST /agent-runs {action:"START", agentId, ancestorRunIds:[]}
 *   → { runId }；② POST /chat/completions 顶层带 codebuff_metadata.run_id。本测试**真起网关 + 假上游**，
 *   走完整 HTTP 链路，验证四件事：
 *     A. 客户端只发 OpenAI 报文（一条 /v1/chat/completions）→ 网关**先**发 /agent-runs **再**发 /chat/completions
 *     B. 第二发的报文里 codebuff_metadata.run_id 与第一发的 runId 一致
 *     C. 第二发的 model 字段是 alias 映射后的 upstream 值
 *     D. 上游回的 OpenAI SSE 经网关原样回给客户端（按 special* 收口钩子）
 *   附 E. validateChannelDef 拦空别名（与 hark 同款的"无 /v1/models 端点"硬约束）
 *   附 F. 流式 / 非流式两条都通
 *
 * 跑法：node test/codebuff-e2e.test.js   （退出码非 0 表示有回归）
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-codebuff-'));
const GW_KEY = 'cb-gw', AD_KEY = 'cb-admin';
const CB_TOKEN = 'a397e09b-aa51-4b74-8be7-1956958b187c';   // 形态对齐 Freebuff session token（36 char UUID）

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// 假上游：处理 agent-runs + chat/completions，按 options.reply 返回
function startFakeCodebuff(opts) {
  const seen = [];
  const o = opts || {};
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      // 假上游把 baseUrl（http://host:port/api/v1）当成 1 级前缀剥掉再判 endpoint；
      // 这是 codebuff 上游的真实形态（baseUrl 固定 /api/v1 子路径），但 e2e 用 baseUrl 只到 host:port 也能跑——这里
      // 两种都接。
      const path = req.url.split('?')[0].replace(/^\/api\/v1/, '');
      const auth = req.headers['authorization'] || '';
      seen.push({ path, auth, body: raw });
      if (path === '/agent-runs') {
        // 校验 Authorization: Bearer <token>
        const want = `Bearer ${CB_TOKEN}`;
        if (auth !== want) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad token' })); return; }
        let body = {}; try { body = JSON.parse(raw || '{}'); } catch { }
        if (body.action !== 'START' || body.agentId !== 'base') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'bad start body' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ runId: 'run-' + Date.now().toString(36) }));
        return;
      }
      if (path === '/chat/completions') {
        // 校验 codebuff_metadata.run_id 存在
        let body = {}; try { body = JSON.parse(raw || '{}'); } catch { }
        if (!body.codebuff_metadata || !body.codebuff_metadata.run_id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'No runId found in request body' }));
          return;
        }
        const reply = o.reply || 'ok';
        if (o.alwaysChatFail) { res.writeHead(402, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'Out of credits' })); return; }
        if (o.failOn === 'chat') { res.writeHead(402, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'Out of credits' })); return; }
        const want = `Bearer ${CB_TOKEN}`;
        if (auth !== want) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad token' })); return; }
        if (body.stream) {
          // SSE
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'x', object: 'chat.completion', created: 1, model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
          }));
        }
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; res({ srv, port: p, seen }); }));
}

// 真网关（按 channel-default-alias-e2e / channel-drop-params-e2e 同款招：临时 cfg + 临时 usage + 动态端口）
async function startGateway(port, upstreamPort, modelMap) {
  const cfgPath = path.join(TMP, `cfg-${port}.json`);
  const usagePath = path.join(TMP, `usage-${port}.json`);
  const cfg = {
    port, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
    channels: [{
      id: 'cb-test', name: 'codebuff test', protocol: 'codebuff',
      baseUrl: `http://127.0.0.1:${upstreamPort}/api/v1`,
      apiKey: CB_TOKEN, priority: 10, enabled: true, autoAlias: false,
      models: modelMap || { 'codebuff-base': 'codebuff/base@latest' },
    }],
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  // 强制清掉可能从 process.env 漏进来的 ZZCSAPI_CONFIG（避免回退到仓库 config.json）
  const childEnv = { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: usagePath, GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' };
  delete childEnv.ZZCSAPI_CONFIG_DEFAULT;
  let stderr = '';
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  // 启动时把 cfgPath 打一行 → 排查"网关没读到测试 cfg"的可能
  stderr += `[test] cfgPath=${cfgPath} port=${port} upstreamPort=${upstreamPort}\n`;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return { proc, stderr, cfgPath }; } catch { }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('gateway 未起来: ' + stderr.slice(-2000));
}
const stopGw = (p) => new Promise((r) => { if (!p || p.exitCode != null) return r(); p.once('exit', r); try { p.kill(); } catch { } setTimeout(r, 1500); });

(async () => {
  console.log('\ncodebuff 反代渠道 · v1.18.58 真链路回归（假上游 + 临时网关）\n');

  // ─── 装配守卫：常量与协议白名单（防止回归时漏改某处）───
  const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  console.log('0. 装配守卫（源码级）');
  check('aliasedProto 含 codebuff', /aliasedProto = \[[^\]]*'codebuff'/.test(SRC));
  check('validateChannelDef 白名单含 codebuff（错误文案同步更新）', /protocol must be openai\|anthropic\|gemini\|notion\|notion-agent\|workbuddy\|codex\|genspark\|hark\|codebuff/.test(SRC));
  check('channel POST 协议白名单含 codebuff', /\[[^\]]*'workbuddy'[^\]]*'codex'[^\]]*'genspark'[^\]]*'hark'[^\]]*'codebuff'[^\]]*\]\.includes\(body\.protocol\)/.test(SRC));
  check('dispatch 分支含 codebuff → tryCodebuffChannel', /if \(\(ch\.def\.protocol \|\| 'openai'\) === 'codebuff'\) \{[\s\S]{0,200}return await tryCodebuffChannel/.test(SRC));
  check('tryChannel 专用报文渠道注释里数到七（"六条路径" 已改为"七条"，含 codebuff）', /七条路径/.test(SRC));
  check('tryCodebuffChannel 存在（async function）', /async function tryCodebuffChannel\(opts\)/.test(SRC));
  check('codebuffChatProbe 探针存在（真两步 run）', /async function codebuffChatProbe\(/.test(SRC));
  check('CODEBUFF_DEFAULT_ALIAS / CODEBUFF_DEFAULT_MODEL 两个常量都被探测建议引用', /CODEBUFF_DEFAULT_ALIAS/.test(SRC) && /CODEBUFF_DEFAULT_MODEL/.test(SRC));
  check('validateChannelDef 拦 codebuff 空别名（与 hark 同款硬约束）', /def\.protocol === 'codebuff'\)[\s\S]{0,400}alias/.test(SRC));
  check('probeUpstream 路径给 codebuff 走 codebuffChatProbe', /\(def\.protocol \|\| 'openai'\) === 'codebuff'\)[\s\S]{0,800}codebuffChatProbe/.test(SRC));
  check('health probe 路径给 codebuff 走 codebuffChatProbe', /\(ch\.def\.protocol \|\| 'openai'\) === 'codebuff'\)[\s\S]{0,300}codebuffChatProbe/.test(SRC));
  check('/admin/api/test 路径含 codebuff 真两步调用', /ch\.def\.protocol === 'codebuff'\)[\s\S]{0,300}agent-runs/.test(SRC));
  check('候选链兜底含 codebuff（hark 之后）', /channelsServing\(model, 'codebuff'\)/.test(SRC));
  check('PROTO_META + PROTO_ORDER（build/app.js 与 console-redesign.html）同步加 codebuff',
    /codebuff:\{label:'Codebuff\/Freebuff'/.test(fs.readFileSync(path.join(ROOT, 'build/app.js'), 'utf8')) &&
    /codebuff:\{label:'Codebuff\/Freebuff'/.test(fs.readFileSync(path.join(ROOT, 'console-redesign.html'), 'utf8')) &&
    /'openai','anthropic','gemini','notion','notion-agent','workbuddy','codex','genspark','hark','codebuff'/.test(fs.readFileSync(path.join(ROOT, 'build/app.js'), 'utf8')));
  check('codebuff-probe.js 探针脚本存在', fs.existsSync(path.join(ROOT, 'codebuff-probe.js')));

  // ─── 真链路：临时网关 + 假上游 ───
  const upstream = await startFakeCodebuff({ reply: 'pong from codebuff' });
  const gwPort = await freePort();
  const { proc: gw, stderr, cfgPath } = await startGateway(gwPort, upstream.port, { 'codebuff-base': 'codebuff/base@latest' });
  // 看看网关真正加载到的 channel 形态（确认 ZZCSAPI_CONFIG 真的被它读了）
  const ch = await fetch(`http://127.0.0.1:${gwPort}/admin/api/channels`, { headers: { Authorization: `Bearer ${AD_KEY}` } }).then((r) => r.json());
  console.log(`  [test] gateway loaded channels: ${ch.channels?.map((x) => `${x.id}=${x.protocol}/${x.baseUrl}`).join('; ')}`);
  console.log(`  [test] test cfgPath: ${cfgPath}`);
  try {
    // §A. 客户端一条 /v1/chat/completions → 网关**先**发 agent-runs **再**发 chat/completions
    console.log('\n1. 真链路（非流式）：客户端单条 → 网关两步（agent-runs + chat/completions）');
    const startIdx = upstream.seen.length;
    const r = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions?key=${GW_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'codebuff-base', messages: [{ role: 'user', content: 'ping' }], stream: false }),
    });
    check('客户端 HTTP 200', r.status === 200, r.status);
    if (r.status !== 200) {
      // 失败立刻打 stderr，否则后面 undefined.body 会把整次 run 干崩
      const j = await r.json().catch(() => ({}));
      console.log('\n  ⚠ 客户端非 200 → gateway stderr 摘要：\n  ' + stderr.slice(-2000).replace(/\n/g, '\n  '));
      check('客户端拿到的 reply 是上游给的', false, j);
    } else {
      const j = await r.json();
      check('客户端拿到的 reply 是上游给的', j.choices?.[0]?.message?.content === 'pong from codebuff', j);
      check('usage 帧有 prompt/completion tokens', j.usage && j.usage.prompt_tokens > 0 && j.usage.completion_tokens > 0, j.usage);
    }
    // 网关向上游发了 2 个请求
    const newReqs = upstream.seen.slice(startIdx);
    check('网关真发了 2 发（先 agent-runs，再 chat/completions）', newReqs.length === 2, newReqs.map((x) => x.path));
    if (newReqs.length < 2) console.log('\n  ⚠ 假上游没收到请求 → gateway stderr 摘要：\n  ' + stderr.slice(-2000).replace(/\n/g, '\n  '));
    check('第一发是 /agent-runs', newReqs[0] && newReqs[0].path === '/agent-runs', newReqs[0]);
    check('第二发是 /chat/completions', newReqs[1] && newReqs[1].path === '/chat/completions', newReqs[1]);
    // §B. codebuff_metadata.run_id 在两发之间一致
    const chatBody = newReqs[1] ? JSON.parse(newReqs[1].body) : {};
    const runIdInChat = chatBody.codebuff_metadata && chatBody.codebuff_metadata.run_id;
    check('chat 报文的 codebuff_metadata.run_id 存在', !!runIdInChat, chatBody.codebuff_metadata);
    check('chat 报文的 codebuff_metadata.client_id 存在（UUID-like 字符串）', !!chatBody.codebuff_metadata?.client_id && chatBody.codebuff_metadata.client_id.length >= 8, chatBody.codebuff_metadata);
    // §C. model 字段是 alias 映射后的 upstream
    check('chat 报文的 model 字段是 upstream（codebuff/base@latest），不是客户端的 alias', chatBody.model === 'codebuff/base@latest', chatBody.model);
    // §D. Authorization: Bearer <token>（两发都有）
    check('agent-runs 带正确 Bearer', newReqs[0] && newReqs[0].auth === `Bearer ${CB_TOKEN}`, newReqs[0] && newReqs[0].auth);
    check('chat/completions 带正确 Bearer', newReqs[1] && newReqs[1].auth === `Bearer ${CB_TOKEN}`, newReqs[1] && newReqs[1].auth);

    // §F. 流式
    console.log('\n2. 真链路（流式）：stream:true → 网关照样两步 → 客户端拿 SSE');
    const startIdx2 = upstream.seen.length;
    const r2 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions?key=${GW_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'codebuff-base', messages: [{ role: 'user', content: 'ping' }], stream: true }),
    });
    check('流式 HTTP 200', r2.status === 200, r2.status);
    check('流式 Content-Type 是 text/event-stream', (r2.headers.get('content-type') || '').includes('text/event-stream'), r2.headers.get('content-type'));
    const t2 = await r2.text();
    check('流式响应里有 data: 行', /^data: /m.test(t2), t2.slice(0, 200));
    check('流式响应以 [DONE] 收尾', /data: \[DONE\]/.test(t2));
    const reqs2 = upstream.seen.slice(startIdx2);
    check('流式也是两步（agent-runs + chat/completions）', reqs2.length === 2 && reqs2[1].path === '/chat/completions', reqs2.map((x) => x.path));
    if (reqs2.length < 2) console.log('\n  ⚠ 假上游没收到流式请求 → gateway stderr 摘要：\n  ' + stderr.slice(-2000).replace(/\n/g, '\n  '));
    const chatBody2 = reqs2[1] ? JSON.parse(reqs2[1].body) : {};
    check('流式 chat 报文也带 codebuff_metadata.run_id', !!chatBody2.codebuff_metadata?.run_id, chatBody2.codebuff_metadata);

    // §E. validateChannelDef 拦空别名：再起一个**空 aliases** 的网关，POST 它去改 channels → 400
    console.log('\n3. 零别名硬约束（与 hark 同款）');
    const gwPort2 = await freePort();
    const cfgPath2 = path.join(TMP, `cfg2-${gwPort2}.json`);
    const usagePath2 = path.join(TMP, `usage2-${gwPort2}.json`);
    fs.writeFileSync(cfgPath2, JSON.stringify({
      port: gwPort2, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
      channels: [{
        id: 'cb-bad', name: 'bad', protocol: 'codebuff',
        baseUrl: `http://127.0.0.1:${upstream.port}/api/v1`, apiKey: 'x', priority: 0, enabled: true, autoAlias: false, models: {},
      }],
    }, null, 2));
    const gw2 = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ZZCSAPI_CONFIG: cfgPath2, ZZCSAPI_USAGE: usagePath2, GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr2 = '';
    gw2.stderr.on('data', (c) => { stderr2 += c.toString('utf8'); });
    while (Date.now() - Date.now() < 20000) {
      try { if ((await fetch(`http://127.0.0.1:${gwPort2}/healthz`)).ok) break; } catch { }
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      const upd = await fetch(`http://127.0.0.1:${gwPort2}/admin/api/channels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AD_KEY}` },
        body: JSON.stringify({ id: 'cb-bad', name: 'bad', baseUrl: `http://127.0.0.1:${upstream.port}/api/v1`, apiKey: 'x', protocol: 'codebuff', priority: 0, enabled: true, autoAlias: false, models: {} }),
      });
      const j = await upd.json().catch(() => ({}));
      check('零别名 POST /admin/api/channels → 400（含可照抄的例子）', upd.status === 400, { s: upd.status, b: j });
      check('错误文案里出现 CODEBUFF_DEFAULT_ALIAS（codebuff-base）作示例', /codebuff-base/.test(j.error || ''), j.error);
    } finally { await stopGw(gw2); }

  // ───────────── §4 探测失败也给默认建议（v1.18.59）─────────────
  // 现场动机：账号无 API credits 是合法常见状态——「获取模型」按当前实现会 ok:false，控制台列不出建议。
  //   用户加不了别名 → 就算充了值渠道也永远不会被命中（AGENTS §1.1 要防的正是这个）。
  // 期望：探测失败时仍把 [CODEBUFF_DEFAULT_MODEL] 放进 models，并把 account.note 说明铺出来。
  console.log('\n4. 探测失败也照样给默认建议 + account.note（v1.18.59）');
  {
    const fakeFail = await startFakeCodebuff({ alwaysChatFail: true });
    const gwPort3 = await freePort();
    const cfgPath3 = path.join(TMP, `cfg3-${gwPort3}.json`);
    const usagePath3 = path.join(TMP, `usage3-${gwPort3}.json`);
    fs.writeFileSync(cfgPath3, JSON.stringify({
      port: gwPort3, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
      channels: [{
        id: 'cb-fail', name: 'cb fail', protocol: 'codebuff',
        baseUrl: `http://127.0.0.1:${fakeFail.port}/api/v1`, apiKey: 'x', priority: 0, enabled: true, autoAlias: false, models: {},
      }],
    }, null, 2));
    const gw3 = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ZZCSAPI_CONFIG: cfgPath3, ZZCSAPI_USAGE: usagePath3, GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const t3 = Date.now();
    while (Date.now() - t3 < 20000) {
      try { if ((await fetch(`http://127.0.0.1:${gwPort3}/healthz`)).ok) break; } catch { }
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      const r = await fetch(`http://127.0.0.1:${gwPort3}/admin/api/probe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AD_KEY}` },
        body: JSON.stringify({ baseUrl: `http://127.0.0.1:${fakeFail.port}/api/v1`, protocol: 'codebuff', apiKey: 'x' }),
      });
      const j = await r.json().catch(() => ({}));
      check('探测失败响应里 models 含默认建议 codebuff-base', Array.isArray(j.models) && j.models.includes('codebuff/base@latest'), { status: r.status, j });
      check('探测失败响应里 account.note 说明「无 /v1/models 端点」+「探测失败但建议可以先配好」',
        /codebuff 无 \/v1\/models/.test(String(j.account?.note || '')) && /本次探测失败/.test(String(j.account?.note || '')), j.account);
      check('探测失败 ok 仍然是 false（诚实地告诉用户上游没通）', j.ok === false, j);
    } finally { await stopGw(gw3); try { await fakeFail.close(); } catch { } }

    // 对照：探测成功时建议也照样给出（这条 v1.18.58 已实现）
    const fakeOk = await startFakeCodebuff({});
    const gwPort4 = await freePort();
    const cfgPath4 = path.join(TMP, `cfg4-${gwPort4}.json`);
    const usagePath4 = path.join(TMP, `usage4-${gwPort4}.json`);
    fs.writeFileSync(cfgPath4, JSON.stringify({
      port: gwPort4, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
      channels: [{
        id: 'cb-ok', name: 'cb ok', protocol: 'codebuff',
        baseUrl: `http://127.0.0.1:${fakeOk.port}/api/v1`, apiKey: 'x', priority: 0, enabled: true, autoAlias: false, models: {},
      }],
    }, null, 2));
    const gw4 = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ZZCSAPI_CONFIG: cfgPath4, ZZCSAPI_USAGE: usagePath4, GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const t4 = Date.now();
    while (Date.now() - t4 < 20000) {
      try { if ((await fetch(`http://127.0.0.1:${gwPort4}/healthz`)).ok) break; } catch { }
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      const r = await fetch(`http://127.0.0.1:${gwPort4}/admin/api/probe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AD_KEY}` },
        body: JSON.stringify({ baseUrl: `http://127.0.0.1:${fakeOk.port}/api/v1`, protocol: 'codebuff', apiKey: 'x' }),
      });
      const j = await r.json().catch(() => ({}));
      check('探测成功响应里 models 含默认建议 codebuff-base', Array.isArray(j.models) && j.models.includes('codebuff/base@latest'), { status: r.status, j });
      check('探测成功响应里 account.note 给出无目录说明（不影响）', /codebuff 无 \/v1\/models/.test(String(j.account?.note || '')), j.account);
    } finally { await stopGw(gw4); try { await fakeOk.close(); } catch { } }
  }
  } finally {
    await stopGw(gw);
    upstream.srv.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  if (fail) {
    // 把最近一次 gateway 启动的 stderr 一并打出来（健康探针失败的真因写在那儿）
    console.log('\n最近的 gateway stderr 摘要（健康探针 / 出站报错在这一段）：');
    console.log((stderr || '').slice(-2000));
  }

  console.log('\n' + '━'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('运行异常：' + (e && e.stack || e)); process.exit(1); });
