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
const crypto = require('crypto');

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
  // §6 专用：ownerCheck = 像真 hark 那样**按 cookie 归属会话**（谁的 cookie 只能发/收自己的会话，
  //   否则 404 conversation not found）。这正是"两条渠道共用会话键"必须被抓住的前提；
  //   默认关，§2–§4 的行为一字不变。
  const convOwner = new Map();   // convId -> cookie
  const dead = new Set();        // 已"被删"的会话（模拟用户在 hark 里删掉了缓存里那条）
  // §9 专用：replies = [第1发正文, 第2发正文, ...] —— 验"上游偶发 canned 道歉时，网关必须重试"。
  //   真机实测约 25% 偶发（同一发载荷 8 次里 2 次回固定道歉），所以这里按**发次**给不同正文。
  let replySeq = 0;
  const nextReply = () => (Array.isArray(o.replies) && o.replies.length
    ? o.replies[Math.min(replySeq++, o.replies.length - 1)]
    : (o.reply || '渠道正常'));
  const srv = http.createServer((req, res) => {
    const full = req.url || '';
    const u = new URL(full.startsWith('http') ? full : 'http://hark.invalid' + full);
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      const rec = { method: req.method, path: u.pathname, query: u.search, body, headers: req.headers, status: 0 };
      seen.push(rec);
      const ck = () => String(req.headers.cookie || '');
      const owned = (cid) => !o.ownerCheck || (convOwner.get(cid) === ck() && !dead.has(cid));
      // record 状态码：§6 靠"这一发是不是打到别人的会话（404）"来判别键有没有按身份分——
      //   只看"最终通过"是不够的，**自愈会把键的错误掩盖过去**（旧键 + 自愈也能测过）。
      const send = (code, obj, ctype) => { rec.status = code; res.writeHead(code, { 'Content-Type': ctype || 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      if (u.pathname === '/api/auth/get-session') return send(200, { user: { id: 'u-test', hasAppAccess: true } });
      if (u.pathname === '/api/conversations' && req.method === 'POST') {
        if (!o.ownerCheck) return send(200, { conversationId: o.convId || 'conv-1', success: true });
        const cid = 'conv-' + (convOwner.size + 1) + '-' + crypto.createHash('sha1').update(ck()).digest('hex').slice(0, 6);
        convOwner.set(cid, ck());
        if (o.staleFirstConv && convOwner.size === 1) dead.add(cid);   // 第一条会话"已被删"→ 首发必 404
        return send(200, { conversationId: cid, success: true });
      }
      if (u.pathname.startsWith('/api/conversations/') && req.method === 'DELETE') return send(200, { success: true });
      if (u.pathname === '/api/messages/send') {
        const cid = u.searchParams.get('cid') || '';
        if (!owned(cid)) return send(404, { error: 'conversation not found' });
        if (o.sendFail) return send(o.sendFail, { error: 'upstream refused' });
        return send(200, { agentId: 'agent-1', conversationId: cid || o.convId || 'conv-1', messageId: o.msgId || 'msg-1', redirected: false, success: true });
      }
      if (u.pathname === '/api/sync/conversation') {
        const cid = u.searchParams.get('conversationId') || '';
        if (!owned(cid)) return send(404, { error: 'conversation not found' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(': ok\n\n');
        const convId = cid || o.convId || 'conv-1';
        // 快照（空）→ 助手占位 → narration → 整段正文 → 完成（与真机实测的帧序一致）
        res.write(`data: ${JSON.stringify({ type: 'sync', conversationId: convId, event: { type: 'snapshot', data: { messages: {}, log: [] }, seq: 1 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'sync', conversationId: convId, event: { type: 'patches', data: [{ op: 'entry_add', entry: 'message', value: { id: 'a-1', role: 'assistant', content: '', isStreaming: true, jobStatus: 'running', triggeredByMessageId: o.msgId || 'msg-1' } }], patchSeq: 2 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'sync', conversationId: convId, event: { type: 'patches', data: [{ op: 'narration_update', fields: { narration: { line: 'Checking the time', lineKey: 'narration.time.current_time' } } }], patchSeq: 3 } })}\n\n`);
        const REPLY = nextReply();
        res.write(`data: ${JSON.stringify({ type: 'sync', conversationId: convId, event: { type: 'patches', data: [{ op: 'entry_add', entry: 'message', value: { id: 'a-1', role: 'assistant', content: REPLY, isStreaming: true, jobStatus: 'running', triggeredByMessageId: o.msgId || 'msg-1' } }], patchSeq: 4 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'sync', conversationId: convId, event: { type: 'patches', data: [{ op: 'message_update', id: 'a-1', fields: { content: REPLY, isStreaming: false, jobStatus: 'completed' } }], patchSeq: 5 } })}\n\n`);
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
    check('★ 尾部提醒自包含（带工具名 + 明说"你没有执行能力、别回答执行不了"）', /\[提醒：工具由调用方执行/.test(sentMsg) && /本次可用工具：read_local_file/.test(sentMsg) && /不要回答"我无法执行工具/.test(sentMsg), String(sentMsg).slice(-260));
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
  // v1.18.60：撤掉 codebuff 后 hark 成了白名单末位，错误文案里 `|hark` 后面不再跟竖线——正则别再要求尾随 `|`
  check('协议白名单（validateChannelDef）含 hark', /\|genspark\|hark/.test(SRC));
  check('协议白名单（渠道 POST）含 hark', /'genspark',\s*'hark'/.test(SRC));
  check('aggregateModels 的 aliasedProto 含 hark', /'genspark',\s*'hark'/.test(SRC));
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
    check(`${name} 的 PROTO_ORDER 含 hark`, /'genspark',\s*'hark'/.test(txt), name);
  }
  check('前端没有为 hark 新增字段（复用 proxy/apiKey → 无三态负担）', !/harkFreshConversation|harkConvMax/.test(APP_SRC));

  console.log('\n══ §6 两条同类渠道：会话键按「渠道+凭据」隔离 + 死缓存自愈（v1.18.49） ══');
  // 现场（用户报「两个 hark 渠道，一个测试没问题一个测试有问题」）：手动测试的会话键是**常量**
  //   '__admin_test__'，而 convMap 只用这个字符串做键 → 第二条渠道命中第一条建的会话，
  //   拿 B 的 cookie 去访问 A 账号下的会话 → 上游 404 conversation not found。
  //   规律是"谁先测谁过"，极易被读成"第二条渠道坏了"。
  check('★ hark.js 有 convKeyOf（键 = 渠道 id + 凭据指纹 + sessionKey）', /function convKeyOf\(def, sessionKey\) \{[\s\S]{0,200}createHash\('sha256'\)[\s\S]{0,200}def && def\.id[\s\S]{0,200}sessionKey/.test(HARK_SRC));
  check('★ 会话映射不再只用 sessionKey 当键（旧写法必须消失）', !/const key = String\(sessionKey \|\| 'default'\)/.test(HARK_SRC));
  check('convKeyOf 真的被 harkConversationFor 用上（不是写了没用）', /harkConversationFor\(def, sessionKey, timeoutMs, forceNew\) \{\s*\n\s*const key = convKeyOf\(def, sessionKey\);/.test(HARK_SRC));
  check('凭据指纹变了 → 键就变了（换 cookie 不继承旧账号的死会话）', hark._convKeyOf
    ? hark._convKeyOf({ id: 'c1', apiKey: 'A' }, 'k') !== hark._convKeyOf({ id: 'c1', apiKey: 'B' }, 'k')
    : null, '需要导出 _convKeyOf');
  check('渠道标识变了 → 键就变了', hark._convKeyOf
    ? hark._convKeyOf({ id: 'c1', apiKey: 'A' }, 'k') !== hark._convKeyOf({ id: 'c2', apiKey: 'A' }, 'k')
    : null);
  check('sessionKey 仍然参与（同一渠道的不同会话不互相顶掉）', hark._convKeyOf
    ? hark._convKeyOf({ id: 'c1', apiKey: 'A' }, 's1') !== hark._convKeyOf({ id: 'c1', apiKey: 'A' }, 's2')
    : null);

  const twoChans = (port) => [
    { id: 'harkA', name: 'A', protocol: 'hark', baseUrl: 'http://hark.invalid', apiKey: 'cookie-AAA', proxy: `http://127.0.0.1:${port}`, enabled: true, autoAlias: false, priority: 1, models: { 'hark-agent': 'hark' }, timeoutMs: 20000 },
    { id: 'harkB', name: 'B', protocol: 'hark', baseUrl: 'http://hark.invalid', apiKey: 'cookie-BBB', proxy: `http://127.0.0.1:${port}`, enabled: true, autoAlias: false, priority: 1, models: { 'hark-agent': 'hark' }, timeoutMs: 20000 },
  ];
  const manualTest = async (base, channelId) => {
    const r = await fetch(base + '/admin/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AD_KEY}` }, body: JSON.stringify({ channelId, model: 'hark-agent' }) });
    const j = await r.json().catch(() => ({}));
    return (j.results || [])[0] || {};
  };
  const up6 = await startFakeUpstream({ reply: 'ok', ownerCheck: true });
  const gw6 = await startGateway(up6.port, { channels: twoChans(up6.port) });
  try {
    const a = await manualTest(gw6.base, 'harkA');
    check('第一条渠道手动测试通过', a.ok === true && a.reply === 'ok', a);
    const b = await manualTest(gw6.base, 'harkB');
    check('第二条渠道手动测试也通过', b.ok === true && b.reply === 'ok', b);
    // ★ 判别性断言：**从来没打到过别人的会话**。只断言"最终通过"是不够的——自愈会把键的错误掩盖掉
    //   （旧键 + 自愈同样能测过），所以这里盯的是"有没有出现过 404 conversation not found"。
    const crossHits = up6.seen.filter((s) => s.path === '/api/messages/send' && s.status === 404);
    check('★ 全程没有任何一发打到过别人的会话（旧键在这里必然出现 404 → 这就是判别点）', crossHits.length === 0, crossHits.map((s) => s.query));
    check('两条渠道各建了自己的上游会话（2 次 POST /api/conversations）', up6.seen.filter((s) => s.path === '/api/conversations').length === 2, up6.seen.filter((s) => s.path === '/api/conversations').length);
    const a2 = await manualTest(gw6.base, 'harkA');
    check('回头再测第一条仍然通过（会话可复用，不互相顶掉）', a2.ok === true && a2.reply === 'ok', a2);
  } finally { gw6.kill(); await up6.close(); }

  // 对调顺序：先 B 后 A，两条同样都必须过（顺序无关 = 键真的按身份分了）
  const up6b = await startFakeUpstream({ reply: 'ok', ownerCheck: true });
  const gw6b = await startGateway(up6b.port, { channels: twoChans(up6b.port) });
  try {
    const b1 = await manualTest(gw6b.base, 'harkB');
    const a1 = await manualTest(gw6b.base, 'harkA');
    check('★ 对调顺序同样两条都过（旧代码是"谁先谁过、后测必挂"）', b1.ok === true && a1.ok === true, { b: b1.error || b1.reply, a: a1.error || a1.reply });
    check('★ 对调顺序也一样：全程零"打到别人会话"', up6b.seen.filter((s) => s.path === '/api/messages/send' && s.status === 404).length === 0, up6b.seen.filter((s) => s.path === '/api/messages/send' && s.status === 404).length);
  } finally { gw6b.kill(); await up6b.close(); }

  // 死缓存自愈：缓存里那条会话已被删（用户在 hark 里删掉 / 上游回收）→ 首发 404，
  //   网关必须**丢掉缓存重建一条、只重试一次**，而不是把这个渠道钉死到空闲过期。
  const up6c = await startFakeUpstream({ reply: 'ok', ownerCheck: true, staleFirstConv: true });
  const gw6c = await startGateway(up6c.port, { channels: twoChans(up6c.port) });
  try {
    const c1 = await manualTest(gw6c.base, 'harkA');
    check('★ 死缓存自愈：首发 404 后重建并成功（不把渠道钉死 30 分钟）', c1.ok === true && c1.reply === 'ok', c1);
    check('★ 自愈是"一次性"的（恰恰 2 次建会话，不是无限重试）', up6c.seen.filter((s) => s.path === '/api/conversations').length === 2, up6c.seen.filter((s) => s.path === '/api/conversations').length);
    const c2 = await manualTest(gw6c.base, 'harkA');
    check('自愈之后再测正常（新会话已进缓存）', c2.ok === true && c2.reply === 'ok', c2);
  } finally { gw6c.kill(); await up6c.close(); }
  check('真实失败不触发自愈（只在 404/not found 上）', /if \(!sent\.ok && \/404\|not found\/i\.test/.test(SRC));

  console.log('\n══ §7 大正文回合：正文不许当命令行参数（spawn E2BIG，v1.18.51） ══');
  // 现场：手工测试（几十字节）过、真实调用（DSH 把整段会话拍平成几十万字符）挂，渠道 lastError 是
  //   `hark send: curl: curl spawn: spawn E2BIG` —— Windows 命令行上限约 32KB（Linux 单参数 128KB）。
  //   这里经真网关发一发 12 万字符的正文：修好之前它必然 E2BIG，修好之后上游要真收到**完整**正文。
  const BIG = '甲乙丙丁戊己庚辛壬癸'.repeat(12000) + '【末尾标记-ZZEND】';   // 12 万字符
  const up7 = await startFakeUpstream({ reply: '大正文收到' });
  const gw7 = await startGateway(up7.port);
  try {
    const r = await chat(gw7.base, { model: 'hark-agent', messages: [{ role: 'user', content: BIG }] });
    const j = await r.json();
    check(`★ ${BIG.length} 字符的正文经真网关发出去不报 E2BIG（HTTP 200）`, r.status === 200, { status: r.status, body: JSON.stringify(j).slice(0, 200) });
    check('客户端拿到上游回复', j.choices && j.choices[0].message.content === '大正文收到', j.choices && j.choices[0].message.content);
    const sent = (() => { const s = up7.seen.find((x) => x.path === '/api/messages/send'); try { return JSON.parse(s.body).message; } catch { return ''; } })();
    check('★ 上游真收到**完整**正文（长度对得上，且末尾标记在）', typeof sent === 'string' && sent.length >= BIG.length && sent.includes('【末尾标记-ZZEND】'), { got: String(sent).length, want: BIG.length });
    const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => /^zzhark_|^zzcurl_/.test(f));
    check('临时正文文件没有堆积（每条退出路径都清掉）', leftovers.length === 0, leftovers.slice(0, 5));
  } finally { gw7.kill(); await up7.close(); }
  check('★ 结构守卫：harkCurl 的正文走文件（`@` + bodyFile），不再直接进 argv', /args\.push\('--data-binary', bodyFile \? '@' \+ bodyFile : String\(bodyStr\)\)/.test(HARK_SRC));
  check('★ 结构守卫：通用 CF 回退路径也不再把正文塞 argv（`--data-raw` 已清零）', !/args\.push\('--data-raw'/.test(SRC) && /args\.push\('--data', bodyFile \? '@' \+ bodyFile : String\(body\)\)/.test(SRC));

  console.log('\n══ §8 工具定义形状归一：扁平 / input_schema / inputSchema 也必须注入真目录（v1.18.52 / v1.18.56） ══');
  // 现场：调用方（agent 客户端）发的不是 OpenAI 嵌套形状 → 旧代码把目录渲染成 `### function` + 空 schema `{}`，
  //   或者直接返回 null（连协议都不注入）→ 上游拿不到真工具名，只能回散文（"我执行不了这些工具调用"）。
  // v1.18.56：**schema 字段名本身也有两种拼法**——snake `input_schema` 与 camel `inputSchema`，
  //   且两种都可能出现在顶层或 `function` 里。只认 snake 时工具名读得到、schema 却是空 `{}`。
  const FLAT = [{ type: 'function', name: 'read_local_file', description: '读取本机文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
  const ANTH = [{ name: 'read_local_file', description: '读取本机文件', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }];
  const CAMEL = [{ name: 'read_local_file', description: '读取本机文件', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
  for (const [label, tools] of [['扁平 type:function', FLAT], ['Anthropic 式 input_schema', ANTH], ['驼峰 inputSchema', CAMEL]]) {
    const up8 = await startFakeUpstream({ reply: TOOL_CALL_REPLY });
    const gw8 = await startGateway(up8.port);
    try {
      const r = await chat(gw8.base, { model: 'hark-agent', messages: [{ role: 'user', content: '读 D:\\x\\a.txt' }], tools });
      const j = await r.json();
      const m = j.choices && j.choices[0].message;
      const sent = (() => { const s = up8.seen.find((x) => x.path === '/api/messages/send'); try { return JSON.parse(s.body).message; } catch { return ''; } })();
      check(`★ [${label}] 目录里是真工具名（旧代码是 ### function）`, /### read_local_file/.test(sent), String(sent).match(/### [^\n]*/g));
      check(`★ [${label}] schema 真的注进去了（旧代码是空 {}）`, /"required":\["path"\]|"properties":\{"path"/.test(sent));
      check(`★ [${label}] 客户端仍拿到 tool_calls`, j.choices && j.choices[0].finish_reason === 'tool_calls' && m.tool_calls && m.tool_calls[0].function.name === 'read_local_file', j.choices && j.choices[0].finish_reason);
    } finally { gw8.kill(); await up8.close(); }
  }
  const EMU_SRC = fs.readFileSync(path.join(ROOT, 'tool-emu.js'), 'utf8');
  check('★ 结构守卫：仿真器有形状归一函数 normTool，且入口先归一后过滤', /function normTool\(t\)/.test(EMU_SRC) && /\.map\(normTool\)\.filter\(\(t\) => t\.name\)/.test(EMU_SRC));
  check('★ 结构守卫：不再只认 t.function.name 当目录名', !/f\.name \|\| t\.type \|\| 'tool'/.test(EMU_SRC));
  check('★ 结构守卫：尾部提醒带工具名清单（抗稀释，能独立成立）', /本次可用工具：/.test(EMU_SRC) && /buildTailReminder\(toolNames\)/.test(EMU_SRC));
  // v1.18.56：归一必须同时收下 snake / camel 两种拼法，**且两种都可能嵌在 `function` 里**（纯函数，零额度）
  check('★ [v1.18.56] normTool 真值表：parameters / input_schema / inputSchema × 顶层 / function 内', (() => {
    const emu = require(path.join(ROOT, 'tool-emu.js'));
    const S = { type: 'object', properties: { path: { type: 'string' } } };
    const render = (t) => { const txt = emu.buildToolSystemPrompt([t], 'auto'); return /"path"/.test(txt); };
    return render({ type: 'function', function: { name: 'a', parameters: S } }) === true
      && render({ type: 'function', function: { name: 'a', input_schema: S } }) === true
      && render({ type: 'function', function: { name: 'a', inputSchema: S } }) === true
      && render({ name: 'a', parameters: S }) === true
      && render({ name: 'a', input_schema: S }) === true
      && render({ name: 'a', inputSchema: S }) === true;
  })());
  check('★ [v1.18.56] 优先级与边界：parameters 压过驼峰／数组 schema 退成空对象（目录里工具仍在）', (() => {
    const emu = require(path.join(ROOT, 'tool-emu.js'));
    const A = { type: 'object', properties: { a: { type: 'string' } } };
    const B = { type: 'object', properties: { b: { type: 'string' } } };
    const txt = emu.buildToolSystemPrompt([{ name: 'x', parameters: A, inputSchema: B }], 'auto');
    const arr = emu.buildToolSystemPrompt([{ name: 'x', inputSchema: ['nope'] }], 'auto');
    return /"a"/.test(txt) && !/"b"/.test(txt) && /### x/.test(arr) && !/"properties"/.test(arr);
  })());
  check('★ [v1.18.56] 结构守卫：schema 取值的四处链在源码里是完整的一段（别被后人删回两处）', /f\.parameters \|\| f\.input_schema \|\| f\.inputSchema/.test(EMU_SRC) && /o\.parameters \|\| o\.input_schema \|\| o\.inputSchema/.test(EMU_SRC));
  check('对照：纯文本回合不注入、tool_choice=none 不注入、无工具定义返回 null', (() => {
    const emu = require(path.join(ROOT, 'tool-emu.js'));
    return emu.emulateRequest({ messages: [{ role: 'user', content: 'hi' }] }) === null
      && emu.emulateRequest({ messages: [{ role: 'user', content: 'hi' }], tools: FLAT, tool_choice: 'none' }) === null
      && emu.emulateRequest({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function' }] }) === null;
  })());

  console.log('\n══ §9 上游偶发固定道歉（约 25%）：必须判成可重试失败，不许当成功回给客户端（v1.18.55） ══');
  // 真机现场：同一发 211k 载荷连打 8 次，6 次正常回 [TOOL_CALL]、2 次回
  //   「I wasn't able to answer this message.」（out=10）/「I couldn't complete your request. Please try again.」（out=13）。
  //   用户连撞三次 → 看到的是"渠道坏了/不回工具调用"。旧行为把它记成 ok:true 并原样回给客户端。
  const CANNED = "I wasn't able to answer this message.";
  {
    // ① 纯函数真值表：只认"自称没工具 / hark 固定道歉"，普通短答一律不误伤
    const emu = require(path.join(ROOT, 'tool-emu.js'));
    const MUST_HIT = [
      "I wasn't able to answer this message.",
      "I couldn't complete your request. Please try again.",
      "I don't have a tool that can read files from your local machine (like `D:\\x`), and I can't execute these tool calls.",
      '我在这里替你执行不了这些工具调用',
      '那种工具调用格式我这边跑不了',
      '我连不上你的服务器，也不能在你的电脑上执行命令',
    ];
    const MUST_MISS = ['OK', '42', '巴黎', 'Done.', '# zzcsapi', '我读到了 README 的第一行：版本 v1.18.55。',
      'I read the file successfully. The first line is # zzcsapi.', '工具 read_local_file 的参数是 path。',
      'The tool_calls array is empty.', 'x'.repeat(1200) + " I couldn't complete your request"];
    check('★ 真值表：6 条真道歉全部命中（含用户转来的中文原文）', MUST_HIT.every((s) => emu.looksLikeHarkCannedFailure(s)), MUST_HIT.filter((s) => !emu.looksLikeHarkCannedFailure(s)));
    check('★ 真值表：10 条正常回答一条都不误伤（含"长正文里带道歉字样"）', MUST_MISS.every((s) => !emu.looksLikeHarkCannedFailure(s)), MUST_MISS.filter((s) => emu.looksLikeHarkCannedFailure(s)));
    check('★ 结构守卫：canned 判据真的接在 hark 渠道里、且返回可重试失败', /looksLikeHarkCannedFailure\(replyText\)/.test(SRC) && /hark: canned apology \(retryable\)/.test(SRC));

    // ② 真网关：第 1 发回固定道歉、第 2 发回正常 tool_calls → 客户端**必须**拿到 tool_calls
    const up9 = await startFakeUpstream({ replies: [CANNED, TOOL_CALL_REPLY] });
    const gw9 = await startGateway(up9.port);
    try {
      const r = await chat(gw9.base, { model: 'hark-agent', messages: [{ role: 'user', content: '读 D:\\x\\a.txt' }], tools: TOOLS });
      const j = await r.json();
      const ch0 = (j.choices && j.choices[0]) || {};
      const m = ch0.message || {};
      check('★ 第一发是固定道歉时，客户端拿到的仍是 tool_calls（不是那句道歉）', r.status === 200 && ch0.finish_reason === 'tool_calls' && !!(m.tool_calls && m.tool_calls[0].function.name === 'read_local_file'), { status: r.status, fr: ch0.finish_reason, body: JSON.stringify(j).slice(0, 200) });
      check('★ 道歉没有漏进正文（不许既回 tool_calls 又把道歉当 content 塞回去）', !String(m.content || '').includes("wasn't able"), String(m.content || '').slice(0, 80));
      await new Promise((r2) => setTimeout(r2, 400));
      const sends = up9.seen.filter((s) => s.path === '/api/messages/send').length;
      check('★ 上游真收到了**两发**（第一发道歉被判失败 → 同渠道重试）', sends >= 2, sends);
    } finally { gw9.kill(); await up9.close(); }
  }
  {
    // ③ 对照：上游一直回道歉 → 不能假装成功，必须如实失败（502/错误体）
    const up9b = await startFakeUpstream({ replies: [CANNED] });
    const gw9b = await startGateway(up9b.port);
    try {
      const r = await chat(gw9b.base, { model: 'hark-agent', messages: [{ role: 'user', content: '读 D:\\x\\a.txt' }], tools: TOOLS });
      const j = await r.json();
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      check('对照：一直回道歉 → 如实报失败（不把道歉当成功回给客户端）', r.status >= 400 && !String(msg.content || '').includes("wasn't able"), { status: r.status, content: String(msg.content || '').slice(0, 80) });
    } finally { gw9b.kill(); await up9b.close(); }
  }

  console.log(`\n══════ 通过 ${pass} · 失败 ${fail} ══════`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('!! 用例异常:', e && e.stack || e); process.exitCode = 1; });
