#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/channel-default-alias-e2e.test.js — 「上游没有模型目录的协议」必须仍然可用（v1.18.49，零依赖）
 *
 * 现场（用户报）：hark 渠道「获取模型」拿到**空列表** → 顺手保存 → 渠道是启用的，但任何请求都命中不了它
 * （别名是唯一能把请求路由到某个渠道的东西）→ 表现为"渠道加上了却用不了"。
 * 根因不是协议问题：`probeDef` 的 hark 分支直接返回 `def.models`，而探测时表单**还没有**别名配置，
 * 于是必然空；而同类协议（workbuddy / genspark / codex）早就有约定——**别名表为空时给一条默认建议 +
 * account.note 说明为什么没有目录**，只有 hark 漏了这条约定。
 *
 * 本用例守两件事：
 *   ① 「无模型目录的协议」探测必须给默认建议（别再漏第四家），且控制台真能把它加进别名表；
 *   ② 这种协议**空别名的保存要被拦下**（400 + 可照抄的例子），同时**不误伤** openai 这类
 *      有 /v1/models 或 autoAlias 的协议（它们允许"先存渠道、再让探测补别名"）。
 *
 * §1 是**装配守卫**（现读源码，防回潮）；§2/§3 是**真链路**（临时网关 + 假「hark 上游兼 HTTP 代理」，
 * 照 test/hark-channel.test.js 的招：baseUrl=http://hark.invalid + proxy=127.0.0.1:PORT，
 * 于是 curl 必然把请求交给假代理 —— 零外网、零额度、零凭据）。
 *
 * 跑法：node test/channel-default-alias-e2e.test.js   （退出码非 0 表示有回归）
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
const APP_SRC = fs.readFileSync(path.join(ROOT, 'build', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const CONSOLE_HTML = fs.readFileSync(path.join(ROOT, 'console.html'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-alias-'));
const GW_KEY = 'alias-gw', AD_KEY = 'alias-admin';
const DEFAULT_ALIAS = 'hark-agent';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── 假「hark 上游兼 HTTP 代理」 ───────────────────────────
function startFakeUpstream(opts) {
  const o = opts || {};
  const seen = [];
  const srv = http.createServer((req, res) => {
    const full = req.url || '';
    const u = new URL(full.startsWith('http') ? full : 'http://hark.invalid' + full);
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      seen.push({ method: req.method, path: u.pathname, body });
      const send = (code, obj, ctype) => { res.writeHead(code, { 'Content-Type': ctype || 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      // 凭据探测：Better Auth 的 get-session（有效 → {user}；失效 → 200 + null）
      if (u.pathname === '/api/auth/get-session') return o.expired ? send(200, 'null', 'application/json') : send(200, { user: { id: 'u-test', hasAppAccess: true } });
      if (u.pathname === '/api/conversations' && req.method === 'POST') return send(200, { conversationId: 'conv-1', success: true });
      if (u.pathname.startsWith('/api/conversations/') && req.method === 'DELETE') return send(200, { success: true });
      if (u.pathname === '/api/messages/send') return send(200, { agentId: 'a1', conversationId: 'conv-1', messageId: 'msg-1', redirected: false, success: true });
      if (u.pathname === '/api/sync/conversation') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(': ok\n\n');
        res.write(`data: ${JSON.stringify({ type: 'sync', conversationId: 'conv-1', event: { type: 'snapshot', data: { messages: {}, log: [] }, seq: 1 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'sync', conversationId: 'conv-1', event: { type: 'patches', data: [{ op: 'entry_add', entry: 'message', value: { id: 'a-1', role: 'assistant', content: o.reply || '渠道正常', isStreaming: false, jobStatus: 'completed', triggeredByMessageId: 'msg-1' } }], patchSeq: 2 } })}\n\n`);
        return;
      }
      send(404, { error: 'not found: ' + u.pathname });
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port, seen, close: () => new Promise((r) => srv.close(r)) })));
}

async function startGateway(proxyPort, channels) {
  const port = await freePort();
  const cfgPath = path.join(TMP, `cfg-${port}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ port, gatewayKey: GW_KEY, adminKey: AD_KEY, channels: channels(proxyPort) }, null, 2));
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, `usage-${port}.json`) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d.toString(); });
  srv.stderr.on('data', (d) => { log += d.toString(); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(base + '/health'); if (r.status < 500) break; } catch {} await sleep(150); }
  return { base, log: () => log, stop: async () => { try { srv.kill(); } catch {} await sleep(300); } };
}
const jpost = (base, path_, body, key) => fetch(base + path_, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body) });
const jget = (base, path_, key) => fetch(base + path_, { headers: { Authorization: 'Bearer ' + key } });

(async () => {
  // ───────────── §1 装配守卫（现读源码）─────────────
  console.log('══ §1 装配守卫：无目录协议必须有「默认别名建议」且空别名保存被拦 ══');
  const defs = SRC.match(/const HARK_DEFAULT_ALIAS = '([^']+)'/g) || [];
  check('默认别名只有一处定义（单一真源，改名只改这里）', defs.length === 1, defs);
  check(`默认别名是 ${DEFAULT_ALIAS}（与文档/错误文案一致）`, new RegExp(`const HARK_DEFAULT_ALIAS = '${DEFAULT_ALIAS}'`).test(SRC));
  const uses = (SRC.match(/HARK_DEFAULT_ALIAS/g) || []).length;
  check('默认别名被探测分支与保存校验共用（引用 ≥3 次：定义 + 两处使用）', uses >= 3, uses);
  check('★ hark 探测分支在别名表为空时给默认建议（v1.18.49 修的就是这一处）', /if \(!models\.length\) models = \[HARK_DEFAULT_ALIAS\]/.test(SRC));
  check('hark 探测分支带 account.note 说明「上游没有 /v1/models」', /hark 没有 \/v1\/models 端点/.test(SRC));
  // 同类协议（workbuddy/genspark/codex）原本就有这条约定——守它别再被"顺手删掉"，也守第四家别再漏
  for (const [name, kw] of [['workbuddy', /workbuddy 无 \/models 端点/], ['genspark', /网页端无 models 接口/], ['codex', /codex 无 \/models 端点/]]) {
    check(`${name} 的探测分支仍带「无目录」说明（既有约定没被改坏）`, kw.test(SRC));
  }
  // 数量守卫：四个站点（hark/workbuddy/genspark/codex）**每一个**的下一行都必须有默认建议。
  // 用"相邻"正则而不是单纯数个数——只数个数时，加第五家漏了建议照样能蒙过去。
  const sites = (SRC.match(/let models = Object\.values\(def\.models \|\| \{\}\)\.filter\(Boolean\);\s*\n\s*if \(!models\.length\) models = \[/g) || []).length;
  check('★ 四个无目录协议「取配置别名」的下一行都有默认建议（相邻守卫：加第五家漏了就报错）', sites === 4, sites);
  check('★ 探测端点真的把表单别名表传进 def（否则那四处 `def.models` 是死代码，永远只能回默认建议）', /models: \(body\.models && typeof body\.models === 'object'\) \? body\.models : undefined/.test(SRC));
  check('★ 渠道校验拦下「hark 空别名」并给出可照抄的例子', /if \(def\.protocol === 'hark'\)/.test(SRC) && /别名表空 = 这个渠道不会被任何请求命中/.test(SRC));
  check('拦截只 scoped 到 hark（不波及 openai 等可自动补别名的协议）', !/protocol === 'openai'\)\s*\{\s*const aliases/.test(SRC));
  check('前端把 account.note 显示在探测状态行（Vue… 不，原生模板；就地改一行保行数）', /r\.account&&r\.account\.note\?/.test(APP_SRC));
  check('产物 console.html 已重建（含同一段注释）', CONSOLE_HTML.includes('r.account&&r.account.note?'));

  // ───────────── §2 真链路：探测建议 + 保存拦空 + 不误伤 ─────────────
  console.log('\n══ §2 真链路（临时网关 + 假 hark 上游兼代理）══');
  const fake = await startFakeUpstream({});
  const gw = await startGateway(fake.port, (p) => [{
    id: 'hark1', name: 'hark 网页会话', protocol: 'hark', baseUrl: 'http://hark.invalid',
    apiKey: 'fake-session-token', proxy: `http://127.0.0.1:${p}`, enabled: true, autoAlias: false,
    priority: 1, models: {}, timeoutMs: 20000,   // ★ 故意空别名：这就是用户点「获取模型」之前的表单状态
  }]);
  try {
    // ① 探测（表单此刻没有别名）→ 必须给出默认建议，而不是空列表
    let r = await jpost(gw.base, '/admin/api/probe', { baseUrl: 'http://hark.invalid', apiKey: 'fake-session-token', protocol: 'hark', proxy: `http://127.0.0.1:${fake.port}` }, AD_KEY);
    let j = await r.json();
    check('★ 探测（无别名）ok:true 且给出默认建议（旧行为是空列表 → 用户无从下手）', r.status === 200 && j.ok === true && Array.isArray(j.models) && j.models.includes(DEFAULT_ALIAS), j);
    check('探测响应带 account.note，说明为什么没有模型目录', !!(j.account && /hark 没有 \/v1\/models 端点/.test(String(j.account.note))), j.account);
    check('探测只是只读（假上游只被打了 get-session）', fake.seen.every((s) => s.path === '/api/auth/get-session'), fake.seen.map((s) => s.path));

    // ② 对照：已经配了别名的渠道再探测 → 回报**上游模型名**（四条无目录分支既有约定 `Object.values`），
    //    不再推默认建议；前端 `renderProbeList` 的 have 集合同时收 alias 与 upstream，所以这条会被标成"已在表里"、
    //    不会诱导用户加一条重复别名。
    r = await jpost(gw.base, '/admin/api/probe', { baseUrl: 'http://hark.invalid', apiKey: 'fake-session-token', protocol: 'hark', proxy: `http://127.0.0.1:${fake.port}`, models: { 'my-hark': 'hark' } }, AD_KEY);
    j = await r.json();
    check('对照：带别名的探测回报上游模型名、不再推默认建议（且该名前端会判成"已在表里"）', j.ok === true && j.models.includes('hark') && !j.models.includes(DEFAULT_ALIAS), j.models);

    // ③ 凭据失效时如实失败（200 + null 不许被当成"非 JSON/CF 拦截"）
    const fakeDead = await startFakeUpstream({ expired: true });
    r = await jpost(gw.base, '/admin/api/probe', { baseUrl: 'http://hark.invalid', apiKey: 'stale', protocol: 'hark', proxy: `http://127.0.0.1:${fakeDead.port}` }, AD_KEY);
    j = await r.json();
    check('★ 过期凭据被判成「cookie 已失效」（Better Auth 回 200 + null；旧判据会误报成"疑似 CF 拦截页"）', j.ok === false && /已失效/.test(String(j.error)) && !/CF/.test(String(j.error)), j.error);
    await fakeDead.close();

    // ④ 保存空别名 → 400（让"存得下却永不命中"的渠道不可能产生）
    r = await jpost(gw.base, '/admin/api/channels', { id: 'hark-empty', name: 'x', baseUrl: 'http://hark.invalid', apiKey: 'k', protocol: 'hark', models: {} }, AD_KEY);
    j = await r.json();
    check('★ hark 空别名保存被 400 拦下', r.status === 400, { status: r.status, j });
    check('错误文案给出可照抄的例子与控制台里的下一步', /hark-agent/.test(String(j.error)) && /获取模型/.test(String(j.error)), j.error);

    // ⑤ 按建议保存 → 200，且网关对外真暴露该模型名
    r = await jpost(gw.base, '/admin/api/channels', { id: 'hark-ok', name: 'hark ok', baseUrl: 'http://hark.invalid', apiKey: 'k', protocol: 'hark', proxy: `http://127.0.0.1:${fake.port}`, models: { [DEFAULT_ALIAS]: 'hark' } }, AD_KEY);
    check('按默认建议保存成功', r.status === 200, r.status);
    j = await (await jget(gw.base, '/admin/api/channels', AD_KEY)).json();
    const saved = (j.channels || []).find((c) => c.id === 'hark-ok');
    check('回读该渠道带上了别名', !!(saved && saved.models && saved.models[DEFAULT_ALIAS]), saved && saved.models);
    const models = await (await fetch(gw.base + '/v1/models', { headers: { Authorization: 'Bearer ' + GW_KEY } })).json();
    check('★ /v1/models 真出现该别名（＝这个渠道终于会被命中了）', (models.data || []).some((m) => m.id === DEFAULT_ALIAS), (models.data || []).map((m) => m.id).slice(0, 8));

    // ⑥ 对照：openai 渠道空别名仍可保存（不误伤"先存渠道、后补别名"的既有姿势）
    r = await jpost(gw.base, '/admin/api/channels', { id: 'openai-empty', name: 'y', baseUrl: 'http://hark.invalid', apiKey: 'k', protocol: 'openai', models: {} }, AD_KEY);
    check('对照：openai 空别名仍可保存（拦截只对着无目录协议）', r.status === 200, r.status);

    // ⑦ 端到端：按建议配好后真能对话
    r = await jpost(gw.base, '/v1/chat/completions', { model: DEFAULT_ALIAS, messages: [{ role: 'user', content: 'ping' }] }, GW_KEY);
    j = await r.json();
    check('★ 端到端：按建议配好别名后真能打通（正文回来了）', r.status === 200 && j.choices && j.choices[0].message.content === '渠道正常', j);
    check('对话确实建了自己的上游会话（不是往主会话发）', fake.seen.some((s) => s.path === '/api/conversations' && /autoTitle/.test(s.body)), fake.seen.map((s) => s.path));
  } finally {
    await gw.stop();
    await fake.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n══════ 通过 ${pass} · 失败 ${fail} ══════`);
  process.exit(fail ? 1 : 0);
})();
