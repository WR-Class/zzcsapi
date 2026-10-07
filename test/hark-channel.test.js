#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/hark-channel.test.js — hark.com 网页会话反代渠道（v1.18.47）
 *                                              （单元 + 真链路，零依赖）
 *
 * 背景：hark.com 的 Go 后端**没有** OpenAI 兼容面 —— `POST /v1/chat/completions`（带有效 cookie +
 * 标准 OpenAI 报文）回的是 200 **text/html**（Vite SPA 的壳）。真正的会话协议是网页客户端那套：
 *   发消息 REST（POST /api/messages/send?cid=…）→ 收回复 **SSE patch 流**（/api/sync/conversation）。
 * 三条实测事实决定了本渠道的形状（详见 hark.js 顶部与 docs/hark-reverse-proxy-research.md）：
 *   ① 回复正文**整段一次**下发（无 token 增量）→ 只能伪流式
 *   ② 上游工具全在服务端执行，流里没有任何 tool_add/tool_update → 客户端工具走 **tool-emu 文本仿真**
 *   ③ 本机直连被 CF 403 不是 IP 声誉问题，而是 Node/curl **不读系统代理** → 必须走 def.proxy
 *
 * §2/§3/§4 是**真链路**：临时网关 + 假「hark 上游兼 HTTP 代理」（照 test/genspark-tools.test.js 的招）：
 *   真网关配 baseUrl=http://hark.invalid（故意用不存在的主机）+ proxy=http://127.0.0.1:PORT，
 *   于是 curl 必须把请求交给我们的假代理（走代理不解析该主机名）—— 真 curl、真 HTTP、真 SSE，
 *   但零外网、零额度、零凭据。
 * 跑法：node test/hark-channel.test.js   （退出码非 0 表示有回归）
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
const HARK_SRC = fs.readFileSync(path.join(ROOT, 'hark.js'), 'utf8').replace(/\r\n/g, '\n');
const toolEmu = require(path.join(ROOT, 'tool-emu.js'));
const hark = require(path.join(ROOT, 'hark.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-hark-'));
const GW_KEY = 'hark-gw', AD_KEY = 'hark-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ─────────────────────────── 假「hark 上游兼 HTTP 代理」 ───────────────────────────
// 记录每一发请求，供断言「工具协议真的注进消息里了」「成功删会话 / 失败留证」
function startFakeUpstream(opts) {
  const seen = [];
  const o = opts || {};
  const srv = http.createServer((req, res) => {
    const full = req.url || '';
    const u = new URL(full.startsWith('http') ? full : 'http://hark.invalid' + full);
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      const rec = { method: req.method, path: u.pathname, query: u.search, body, headers: req.headers };
      seen.push(rec);
      const send = (code, obj, ctype) => { res.writeHead(code, { 'Content-Type': ctype || 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      if (u.pathname === '/api/auth/get-session') return send(200, { user: { id: 'u-test', hasAppAccess: true } });
      if (u.pathname === '/api/conversations' && req.method === 'POST') return send(200, { conversationId: o.convId || 'conv-1', success: true });
      if (u.pathname.startsWith('/api/conversations/') && req.method === 'DELETE') return send(200, { success: true });
      if (u.pathname === '/api/messages/send') {
        if (o.sendFail) return send(o.sendFail, { error: 'upstream refused' });
        return send(200, { agentId: 'agent-1', conversationId: o.convId || 'conv-1', messageId: o.msgId || 'msg-1', redirected: false, success: true });
      }
      if (u.pathname === '/api/sync/conversation') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(': ok\n\n');
        const convId = o.convId || 'conv-1';
        // 快照（空）→ 助手占位 → narration → 整段正文 → 完成（与真机实测的帧序一致）
        res.write(`data: ${JSON.stringify({ type: 'sync', conversationId: convId, event: { type: 'snapshot', data: { messages: {}, log: [] }, seq: 1 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'sync', conversationId: convId, event: { type: 'patches', data: [{ op: 'entry_add', entry: 'message', value: { id: 'a-1', role: 'assistant', content: '', isStreaming: true, jobStatus: 'running', triggeredByMessageId: o.msgId || 'msg-1' } }], patchSeq: 2 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'sync', conversationId: convId, event: { type: 'patches', data: [{ op: 'narration_update', fields: { narration: { line: 'Checking the time', lineKey: 'narration.time.current_time' } } }], patchSeq: 3 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'sync', conversationId: convId, event: { type: 'patches', data: [{ op: 'entry_add', entry: 'message', value: { id: 'a-1', role: 'assistant', content: o.reply || '渠道正常', isStreaming: true, jobStatus: 'running', triggeredByMessageId: o.msgId || 'msg-1' } }], patchSeq: 4 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'sync', conversationId: convId, event: { type: 'patches', data: [{ op: 'message_update', id: 'a-1', fields: { content: o.reply || '渠道正常', isStreaming: false, jobStatus: 'completed' } }], patchSeq: 5 } })}\n\n`);
        return;   // 不收流：模块拿到完成帧会自己杀 curl（这正是要验的行为）
      }
      send(404, { error: 'not found: ' + u.pathname });
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port, seen, close: () => new Promise((r) => srv.close(r)) })));
}

// ─────────────────────────── 临时网关实例 ───────────────────────────
async function startGateway(proxyPort, extra) {
  const port = await freePort();
  const cfg = Object.assign({
    port, gatewayKey: GW_KEY, adminKey: AD_KEY,
    channels: [{
      id: 'hark1', name: 'hark 网页会话', protocol: 'hark', baseUrl: 'http://hark.invalid',
      apiKey: 'fake-session-token', proxy: `http://127.0.0.1:${proxyPort}`, enabled: true, autoAlias: false,
      priority: 1, models: { 'hark-agent': 'hark' }, timeoutMs: 20000,
    }],
  }, extra || {});
  const cfgPath = path.join(TMP, `cfg-${port}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, `usage-${port}.json`) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d.toString(); });
  srv.stderr.on('data', (d) => { log += d.toString(); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/health'); if (r.status < 500) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return { base, srv, log: () => log, kill: () => { try { srv.kill(); } catch {} } };
}

const H = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${GW_KEY}` });
const chat = (base, body) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: H(), body: JSON.stringify(body) });

(async () => {
  console.log('══ §1 纯函数真值表（报文拍平 / cookie 归一） ══');
  // 上游只收**一条字符串** → 拍平必须保留角色、工具调用历史与空段跳过
  const flat = hark.flattenForHark([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '读文件' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_local_file', arguments: '{"path":"a"}' } }] },
    { role: 'tool', content: '内容X' },
    { role: 'user', content: '   ' },
  ]);
  check('拍平带角色标注', /【系统设定】/.test(flat) && /【用户】/.test(flat) && /【工具执行结果】/.test(flat), flat.slice(0, 80));
  check('拍平保留 assistant.tool_calls 历史', /read_local_file/.test(flat) && /\{"path":"a"\}/.test(flat));
  check('空白段落被跳过（不留空壳【用户】）', (flat.match(/【用户】/g) || []).length === 1);
  check('拍平结果不含数组/对象（必须是字符串）', typeof flat === 'string' && !/\[object/.test(flat));
  check('cookie 归一：只给值 → 补成 __Secure-hark.session_token=值', hark.harkCookie({ apiKey: 'abc' }) === '__Secure-hark.session_token=abc');
  check('cookie 归一：已带前缀 → 原样', hark.harkCookie({ apiKey: '__Secure-hark.session_token=x' }) === '__Secure-hark.session_token=x');
  check('cookie 归一：整段 cookie 串 → 原样', hark.harkCookie({ apiKey: 'a=1; b=2' }) === 'a=1; b=2');
  check('cookie 归一：空 → 空串（不伪造 cookie）', hark.harkCookie({}) === '');
  const hh = hark.harkHeaders({ apiKey: 'k', baseUrl: 'https://hark.com/' });
  check('请求头带 Cookie / Origin / Referer（去尾斜杠）', hh.Cookie === '__Secure-hark.session_token=k' && hh.Origin === 'https://hark.com' && hh.Referer === 'https://hark.com/chat');
  check('会话映射是有界的（LRU 上限与空闲上限都在）', hark.CONV_MAX === 64 && hark.CONV_IDLE_MS > 0);

  console.log('\n══ §2 真链路：纯文本回合（真网关 + 真 curl + 假上游） ══');
  const up1 = await startFakeUpstream({ reply: '渠道正常' });
  const gw1 = await startGateway(up1.port);
  try {
    const r = await chat(gw1.base, { model: 'hark-agent', messages: [{ role: 'user', content: '只回四个字' }] });
    const j = await r.json();
    check('HTTP 200', r.status === 200, r.status);
    check('渠道头标出 hark1（证明走的不是 openai 常规路径）', r.headers.get('x-zzcsapi-channel') === 'hark1');
    check('客户端拿到上游正文', j.choices && j.choices[0].message.content === '渠道正常', j.choices && j.choices[0].message.content);
    check('finish_reason=stop', j.choices && j.choices[0].finish_reason === 'stop');
    check('usage 照实记（估算，不假装有上游真值）', j.usage && j.usage.total_tokens > 0);
    const paths = up1.seen.map((s) => s.method + ' ' + s.path);
    const paths2 = () => up1.seen.map((s) => s.method + ' ' + s.path);
    check('上游收到建会话 POST /api/conversations', paths.includes('POST /api/conversations'), paths);
    check('建会话带 title + autoTitle:false（{} 会命中用户主会话，绝不能用）', (() => { const c = up1.seen.find((s) => s.path === '/api/conversations'); try { const b = JSON.parse(c.body); return b.title && b.autoTitle === false; } catch { return false; } })());
    check('上游收到 POST /api/messages/send?cid=conv-1', up1.seen.some((s) => s.path === '/api/messages/send' && /cid=conv-1/.test(s.query)), up1.seen.map((s) => s.query));
    check('上游收到 SSE 同步流（manager 是网关自己的值）', up1.seen.some((s) => s.path === '/api/sync/conversation' && /manager=zz-/.test(s.query)));
    // 删会话是**不阻塞响应**的（客户端不该为清理多等一个来回）→ 断言前给它一拍
    await new Promise((r) => setTimeout(r, 600));
    check('成功之后删掉上游会话（不给用户账号堆会话）', paths2().includes('DELETE /api/conversations/conv-1'), paths2());
    const sentMsg = (() => { const s = up1.seen.find((x) => x.path === '/api/messages/send'); try { return JSON.parse(s.body).message; } catch { return ''; } })();
    check('发给上游的是**拍平后的单条字符串**（不是 messages 数组）', typeof sentMsg === 'string' && /【用户】/.test(sentMsg), String(sentMsg).slice(0, 80));
    check('上游报文里带 idempotencyKey / responseMessageId（与真客户端一致）', (() => { const s = up1.seen.find((x) => x.path === '/api/messages/send'); const b = JSON.parse(s.body); return !!b.idempotencyKey && !!b.responseMessageId && b.conversationId === 'conv-1'; })());
  } finally { gw1.kill(); await up1.close(); }

  console.log('\n══ §3 真链路：工具仿真回合（客户端工具 → tool_calls） ══');
  const TOOL_CALL_REPLY = '[TOOL_CALL]\n{"name": "read_local_file", "arguments": {"path": "D:\\\\x\\\\a.txt"}}\n[/TOOL_CALL]';
  const up2 = await startFakeUpstream({ reply: TOOL_CALL_REPLY });
  const gw2 = await startGateway(up2.port);
  const TOOLS = [{ type: 'function', function: { name: 'read_local_file', description: '读取本机文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
  try {
    const r = await chat(gw2.base, { model: 'hark-agent', messages: [{ role: 'user', content: '读 D:\\x\\a.txt' }], tools: TOOLS });
    const j = await r.json();
    const m = j.choices && j.choices[0].message;
    check('HTTP 200', r.status === 200, r.status);
    check('★ finish_reason=tool_calls（客户端据此进入工具回合）', j.choices && j.choices[0].finish_reason === 'tool_calls', j.choices && j.choices[0].finish_reason);
    check('★ tool_calls 名字正确', m && m.tool_calls && m.tool_calls[0].function.name === 'read_local_file', m && m.tool_calls);
    check('★ tool_calls 参数是可解析 JSON 且值正确', (() => { try { return JSON.parse(m.tool_calls[0].function.arguments).path === 'D:\\x\\a.txt'; } catch { return false; } })(), m && m.tool_calls && m.tool_calls[0].function.arguments);
    check('工具调用的正文被清空（不把标记当正文回给客户端）', m.content === null || m.content === '');
    const sentMsg = (() => { const s = up2.seen.find((x) => x.path === '/api/messages/send'); try { return JSON.parse(s.body).message; } catch { return ''; } })();
    check('★ 工具协议真的注进了上游报文（工具名 + 参数 schema + 标记格式）', /read_local_file/.test(sentMsg) && /parameters|JSON Schema/i.test(sentMsg) && /\[TOOL_CALL\]/.test(sentMsg), String(sentMsg).slice(0, 120));
    check('尾部提醒也在（对抗超长上下文注意力稀释）', /\[提醒：若需调用工具/.test(sentMsg));
    check('历史工具结果会被渲染成文本（第二轮靠它把结果带回上游）', (() => { const f = hark.flattenForHark(toolEmu.emulateRequest({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', name: 'f', content: '结果Z' }], tools: TOOLS }).messages); return /结果Z/.test(f) && /f/.test(f); })());
  } finally { gw2.kill(); await up2.close(); }

  console.log('\n══ §4 真链路：失败不删会话（留证）+ 流式伪流式收口 ══');
  const up3 = await startFakeUpstream({ sendFail: 500 });
  const gw3 = await startGateway(up3.port);
  try {
    const r = await chat(gw3.base, { model: 'hark-agent', messages: [{ role: 'user', content: 'x' }] });
    check('上游 500 → 网关不假装成功', r.status >= 400, r.status);
    check('失败**不删**上游会话（留着给用户查那一轮发生了什么）', !up3.seen.some((s) => s.method === 'DELETE' && s.path.startsWith('/api/conversations/')), up3.seen.map((s) => s.method + ' ' + s.path));
  } finally { gw3.kill(); await up3.close(); }

  const up4 = await startFakeUpstream({ reply: '2' });
  const gw4 = await startGateway(up4.port);
  try {
    const r = await chat(gw4.base, { model: 'hark-agent', stream: true, messages: [{ role: 'user', content: '1+1' }] });
    const text = await r.text();
    const lines = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    check('流式 HTTP 200 + 是 SSE', r.status === 200 && lines.length > 0, r.status);
    check('末帧是 [DONE]', lines[lines.length - 1] === '[DONE]', lines[lines.length - 1]);
    const deltas = lines.filter((l) => l !== '[DONE]').map((l) => { try { return JSON.parse(l).choices[0].delta; } catch { return null; } }).filter(Boolean);
    check('首帧 role=assistant（Anthropic/Responses 面靠它开块）', deltas[0] && deltas[0].role === 'assistant', deltas[0]);
    check('★ 正文整段一次吐出（上游没有 token 增量，别假装逐字）', deltas.some((d) => d.content === '2'));
    check('末帧带 finish_reason=stop', lines.some((l) => { try { return JSON.parse(l).choices[0].finish_reason === 'stop'; } catch { return false; } }));
  } finally { gw4.kill(); await up4.close(); }

  console.log('\n══ §5 装配守卫（server.js 六处登记 + 前端两处字典 + 产物） ══');
  check('server.js 引入模块', /const hark = require\('\.\/hark\.js'\)/.test(SRC));
  check('协议白名单（validateChannelDef）含 hark', /\|genspark\|hark'/.test(SRC));
  check('协议白名单（渠道 POST）含 hark', /'genspark', 'hark'\]\.includes\(body\.protocol\)/.test(SRC));
  check('aggregateModels 的 aliasedProto 含 hark', /'genspark', 'hark'\]/.test(SRC));
  check('probeChannel 有 hark 分支', /=== 'hark'\) \{\n\s+const t0 = Date\.now\(\);[\s\S]{0,400}hark\.harkProbe/.test(SRC));
  check('probeDef 有 hark 分支（控制台"从上游探测"）', /hark\.harkProbe\(def, timeoutMs/.test(SRC));
  check('tryChannel 分发到 tryHarkChannel', /=== 'hark'\) \{\n\s+return await tryHarkChannel\(specialOpts\);/.test(SRC));
  check('OpenAI 类候选链（chat + responses 共用）挂上 hark', /channelsServing\(requested, 'hark'\)/.test(SRC));
  check('手动测试有 hark 分支（真发一条）', /ch\.def\.protocol === 'hark'[\s\S]{0,700}hark\.harkConversationFor/.test(SRC));
  check('手动测试走独立会话键（不占用客户端会话）', /harkConversationFor\(ch\.def, '__admin_test__'/.test(SRC));
  check('★ 工具仿真在渠道里真接上（请求侧 + 响应侧）', /toolEmu\.emulateRequest\(body\)/.test(SRC) && /toolEmu\.parseEmulatedToolCalls\(replyText\)/.test(SRC) && /hark\.flattenForHark/.test(SRC));
  check('★ 成功即删、失败留证（删除调用在成功分支之后）', /if \(!rep\.ok \|\| !String\(rep\.text \|\| ''\)\.trim\(\)\) \{[\s\S]{0,300}return[\s\S]{0,200}harkDeleteConversation/.test(SRC));
  check('hark.js 里没有把 apiKey 写进日志/错误串的地方', !/console\.log\([^)]*apiKey/.test(HARK_SRC) && !/JSON\.stringify\(def\)/.test(HARK_SRC));
  const CONSOLE_SRC = fs.readFileSync(path.join(ROOT, 'console-redesign.html'), 'utf8');
  const APP_SRC = fs.readFileSync(path.join(ROOT, 'build', 'app.js'), 'utf8');
  const BUILT = fs.readFileSync(path.join(ROOT, 'console.html'), 'utf8');
  for (const [name, txt] of [['console-redesign.html', CONSOLE_SRC], ['build/app.js', APP_SRC], ['console.html（产物，须已重建）', BUILT]]) {
    check(`${name} 的 PROTO_META 有 hark 条目`, /hark:\{label:'hark[^']*'/.test(txt), name);
    check(`${name} 的 PROTO_ORDER 含 hark`, /'genspark','hark'\]/.test(txt), name);
  }
  check('前端没有为 hark 新增字段（复用 proxy/apiKey → 无三态负担）', !/harkFreshConversation|harkConvMax/.test(APP_SRC));

  console.log(`\n══════ 通过 ${pass} · 失败 ${fail} ══════`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('!! 用例异常:', e && e.stack || e); process.exitCode = 1; });
