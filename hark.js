// hark.js — hark.com 网页会话反代（网关「专用报文渠道」模块，v1.18.47）
//
// 为什么必须独立成一条协议（而不是给 openai 渠道填个 base_url）：
//   hark.com 的 Go 后端**没有** OpenAI 兼容面。实测 `POST /v1/chat/completions`（带有效 cookie +
//   标准 OpenAI 报文）回的是 **200 text/html**——那是 Vite SPA 的壳（`/v1/*` 只是前端路由兜底）。
//   真正的会话协议是网页客户端自己那套：**发消息走 REST、收回复走 SSE patch 流**。
//
// 链路（全程 curl 子进程 + def.proxy —— 与 genspark / codex 同惯例；本机直连会被 CF 403，
//   因为 Node/curl **不读系统代理**，而浏览器/Invoke-WebRequest 读。详见研究文档 §2）：
//   ① 鉴权：Cookie `__Secure-hark.session_token=<apiKey>`（也兼容整段 cookie 串）
//   ② 建会话：POST /api/conversations {title, autoTitle:false} → 新会话 id
//      ⚠ `{}` 只会返回用户的**主会话**（那是他自己的助手线程），绝不能往里发网关流量
//   ③ 发消息：POST /api/messages/send?cid=<会话id> → {success, messageId}
//   ④ 收回复：GET /api/sync/conversation?conversationId=…&v=2&manager=…&mode=in_tab（SSE）
//      读 patch 流直到「本条 messageId 触发的助手消息」完成
//
// 三条实测事实（决定了本模块的形状，别再重新踩）：
//   · **正文整段下发**，没有 token 级增量 → 只能做「伪流式」（客户端面把整段作为一次 delta 吐出）
//   · `narration_update`（narration.time.current_time / narration.web.read_page …）是唯一的
//     「正在干活」信号 → 当思考帧/保活用，不能当正文
//   · 上游工具**全在服务端执行**，客户端拿不到 `tool_calls`（流里一条 tool_add/tool_update 都没有）
//     → 客户端工具只能走 **tool-emu 文本仿真**（与 notion / genspark 同套路），不是原生 function calling
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');

const HARK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SESSION_COOKIE = '__Secure-hark.session_token';
const DEFAULT_BASE = 'https://hark.com';
// 会话映射上限与空闲上限：一个网关会话一条上游会话，闲置久了下次重建（别让用户账号里堆会话）
const CONV_MAX = 64;
const CONV_IDLE_MS = 30 * 60 * 1000;

const convMap = new Map();   // sessionKey -> { cid, at }

function curlBin() { return process.platform === 'win32' ? 'curl.exe' : 'curl'; }
function baseOf(def) { return String((def && def.baseUrl) || DEFAULT_BASE).replace(/\/+$/, ''); }
function rand(n) { return crypto.randomBytes(8).toString('hex').slice(0, n || 8); }

// 渠道 apiKey 可以是「只填 cookie 值」，也可以是整段 cookie 串（用户从 F12 直接整段复制）
function harkCookie(def) {
  const k = String((def && def.apiKey) || '').trim();
  if (!k) return '';
  if (k.includes('=') && k.includes(';')) return k;                 // 整段 cookie 串
  if (k.startsWith(SESSION_COOKIE + '=')) return k;                 // 只有这一条
  return `${SESSION_COOKIE}=${k}`;
}

function harkHeaders(def, extra) {
  const h = {
    'User-Agent': HARK_UA,
    'Accept': 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Origin': baseOf(def),
    'Referer': baseOf(def) + '/chat',
    'Cookie': harkCookie(def),
  };
  return Object.assign(h, extra || {});
}

// ─────────────────────────── 传输层 ───────────────────────────

// 一次性 curl（缓冲）：返回 {status, body, error}
function harkCurl(method, url, headers, bodyStr, timeoutMs, proxy) {
  return new Promise((resolve) => {
    const args = ['-sS', '--max-time', String(Math.max(1, Math.ceil((timeoutMs || 30000) / 1000)))];
    if (proxy) args.push('-x', String(proxy));
    args.push('-X', String(method).toUpperCase());
    for (const [k, v] of Object.entries(headers || {})) args.push('-H', `${k}: ${v}`);
    if (bodyStr != null) args.push('--data-binary', bodyStr);
    args.push('-w', '\n__ZZCODE__%{http_code}');
    args.push(url);
    let child;
    try { child = spawn(curlBin(), args, { windowsHide: true }); }
    catch (e) { resolve({ status: 0, body: '', error: 'curl spawn: ' + e.message }); return; }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ status: 0, body: out, error: 'curl timeout' }); }, (timeoutMs || 30000) + 5000);
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: 0, body: '', error: 'curl spawn: ' + e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const m = out.match(/__ZZCODE__(\d+)\s*$/);
      const body = m ? out.slice(0, out.lastIndexOf('__ZZCODE__')) : out;
      const status = m ? Number(m[1]) : (code === 0 ? 200 : 0);
      if (!m && code !== 0) { resolve({ status: 0, body, error: `curl exit ${code}: ${err.slice(0, 200)}` }); return; }
      resolve({ status, body, error: null });
    });
  });
}

// SSE 同步流：逐帧交给 onEvent；onEvent 返回非 null 即视为「拿到结果」并立即收流（杀 curl）。
// 这一点很关键——上游回复整段到达，不需要挂到超时。
function harkSyncStream(def, cid, onEvent, timeoutMs) {
  return new Promise((resolve) => {
    const url = `${baseOf(def)}/api/sync/conversation?conversationId=${encodeURIComponent(cid)}&v=2&manager=zz-${rand(10)}&mode=in_tab`;
    const args = ['-sS', '-N', '--max-time', String(Math.max(1, Math.ceil((timeoutMs || 180000) / 1000)))];
    if (def.proxy) args.push('-x', String(def.proxy));
    for (const [k, v] of Object.entries(harkHeaders(def, { 'Accept': 'text/event-stream' }))) args.push('-H', `${k}: ${v}`);
    args.push(url);
    let child;
    try { child = spawn(curlBin(), args, { windowsHide: true }); }
    catch (e) { resolve({ ok: false, error: 'curl spawn: ' + e.message }); return; }
    let buf = '';
    let err = '';
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'sync timeout', stderr: err.slice(0, 200) }), (timeoutMs || 180000) + 3000);
    child.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      const frames = buf.split('\n\n');
      buf = frames.pop();
      for (const fr of frames) {
        const line = fr.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;                      // `: ok` / `: ready` 这类注释帧（上游心跳）直接跳过
        let j;
        try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
        let r = null;
        try { r = onEvent(j); } catch (e) { r = { ok: false, error: 'parse: ' + e.message }; }
        if (r) { finish(r); return; }
      }
    });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    child.on('error', (e) => finish({ ok: false, error: 'curl spawn: ' + e.message }));
    child.on('close', () => finish({ ok: false, error: 'stream closed', stderr: err.slice(0, 200) }));
  });
}

// ─────────────────────────── 上游动作 ───────────────────────────

// 鉴权探测（免费，不消耗额度）：GET /api/auth/get-session
async function harkProbe(def, timeoutMs) {
  if (!harkCookie(def)) return { ok: false, status: 0, error: 'hark: 渠道未填会话 cookie（apiKey 填 __Secure-hark.session_token 的值）' };
  const out = await harkCurl('GET', `${baseOf(def)}/api/auth/get-session`, harkHeaders(def), null, timeoutMs || 15000, def.proxy);
  if (out.error) return { ok: false, status: 0, error: 'hark curl: ' + out.error };
  const raw = String(out.body || '').trim();
  // ⚠ 200 + 正文 `null` 是 Better Auth 对**未登录**请求的正常答复（不是 401、也不是 HTML）——
  //   必须判成"凭据失效"。v1.18.49 现场：旧判据 `!safeJson(body)` 把 `null` 也算成"非 JSON 响应"，
  //   于是显示成「疑似 CF 拦截页，检查代理出口」，把人引去出口层查（真因是一枚过期的 cookie）。
  let j, parsed = true;
  try { j = JSON.parse(raw); } catch { parsed = false; }
  if (out.status === 401 || out.status === 403) return { ok: false, status: out.status, error: `hark: 会话 cookie 失效或出口被拦（HTTP ${out.status}${def.proxy ? '' : '，且未配代理'}）` };
  if (!parsed) return { ok: false, status: out.status, error: `hark: 非 JSON 响应（HTTP ${out.status}，疑似 CF 拦截页或代理出口不对）: ` + raw.slice(0, 80) };
  if (j === null || typeof j !== 'object') return { ok: false, status: out.status || 401, error: `hark: 会话 cookie 已失效（get-session 回 ${out.status} + null = 未登录）——去 hark 重新复制 __Secure-hark.session_token 填进渠道钥匙` };
  if (!j.user) return { ok: false, status: out.status, error: 'hark: 响应里没有 user（cookie 可能只对部分域有效）' };
  return { ok: true, status: out.status, userId: String(j.user.id || ''), hasAppAccess: j.user.hasAppAccess !== false };
}

// 新建上游会话：POST /api/conversations {title, autoTitle:false}
async function harkCreateConversation(def, timeoutMs) {
  const out = await harkCurl('POST', `${baseOf(def)}/api/conversations`, harkHeaders(def, { 'Content-Type': 'application/json' }),
    JSON.stringify({ title: 'ZZCSAPI 网关通道', autoTitle: false }), timeoutMs || 20000, def.proxy);
  if (out.error) return { ok: false, error: 'curl: ' + out.error };
  const j = safeJson(out.body);
  const cid = j && (j.conversationId || (j.conversation && j.conversation.id) || j.id);
  if (!cid) return { ok: false, status: out.status, error: `建会话失败 HTTP ${out.status}: ` + String(out.body || '').slice(0, 120) };
  return { ok: true, cid: String(cid), status: out.status };
}

// 会话映射的键必须含「这枚 cookie 是谁」（v1.18.49）：
//   只用 sessionKey 时，**两条同类渠道会命中同一条上游会话**——现场：`hark1` 先测通过，
//   紧接着 `hark2` 拿 B 的 cookie 去访问 A 账号下建的会话 → 上游 `404 conversation not found`
//   （表现为"谁先测谁过、后测的必挂"，极易被误读成第二条渠道坏了）。
//   凭据指纹取 cookie 的 sha256 前 12 位：换 cookie 即换键，天然作废旧账号的会话（不继承死会话）。
function convKeyOf(def, sessionKey) {
  const fp = crypto.createHash('sha256').update(harkCookie(def) || '').digest('hex').slice(0, 12);
  return `${String((def && def.id) || '?')}|${fp}|${String(sessionKey || 'default')}`;
}

// 取/建该网关会话对应的上游会话（有界 + 空闲过期）
async function harkConversationFor(def, sessionKey, timeoutMs, forceNew) {
  const key = convKeyOf(def, sessionKey);
  const hit = convMap.get(key);
  if (!forceNew && hit && Date.now() - hit.at < CONV_IDLE_MS) { hit.at = Date.now(); return { ok: true, cid: hit.cid, reused: true }; }
  const made = await harkCreateConversation(def, timeoutMs);
  if (!made.ok) return made;
  convMap.set(key, { cid: made.cid, at: Date.now() });
  if (convMap.size > CONV_MAX) {
    // 先清过期，再按最久未用淘汰（Map 保持插入序）
    for (const [k, v] of convMap) if (Date.now() - v.at > CONV_IDLE_MS) convMap.delete(k);
    while (convMap.size > CONV_MAX) convMap.delete(convMap.keys().next().value);
  }
  return { ok: true, cid: made.cid, reused: false };
}

// 发消息：POST /api/messages/send?cid=<会话id>
async function harkSend(def, cid, message, timeoutMs) {
  const url = `${baseOf(def)}/api/messages/send?cid=${encodeURIComponent(cid)}`;
  const payload = JSON.stringify({
    conversationId: cid,
    message: String(message == null ? '' : message),
    idempotencyKey: crypto.randomUUID(),
    responseMessageId: crypto.randomUUID(),
  });
  const out = await harkCurl('POST', url, harkHeaders(def, { 'Content-Type': 'application/json' }), payload, timeoutMs || 30000, def.proxy);
  if (out.error) return { ok: false, error: 'curl: ' + out.error };
  const j = safeJson(out.body);
  if (out.status >= 400) {
    const msg = (j && (j.error || j.message)) || String(out.body || '').slice(0, 140);
    return { ok: false, status: out.status, error: `HTTP ${out.status}: ${msg}` };
  }
  if (!j || !j.success || !j.messageId) return { ok: false, status: out.status, error: '报文被接受但没有 messageId: ' + String(out.body || '').slice(0, 120) };
  return { ok: true, messageId: String(j.messageId), agentId: j.agentId ? String(j.agentId) : '', redirected: !!j.redirected };
}

// 收回复：读 SSE patch 流，直到本条 messageId 触发的助手消息完成。
// 返回 {ok, text, jobStatus, awaitingInput, narration, ms, ops} —— 超时但有正文时 ok 仍为 true（partial）
//
// ⚠ 匹配为什么放得这么宽（v1.18.47 实测教训）：
//   · 上游的 patch **不保证**每个 op 都带 `triggeredByMessageId`（有的只带 id、有的什么都不带）；
//     只认这一个字段会漏掉完成帧 → 一直挂到超时、客户端看到"空回复"。
//   · 但放宽是**安全**的：本模块每轮都新建一条上游会话（成功即删），会话里**只可能有我们这一轮**，
//     所以"流里最新的那条助手消息"就是我们的回复。
//   · 因此判据是：① 认 `triggeredByMessageId` / id 精确匹配；② 快照里**已经存在**的助手消息
//     （新会话自带的问候语）一律不算我们的回复 —— 只有"连上流之后新出现的"那条才算。
//     这条纪律是实测逼出来的：新会话快照里**本来就有一条 assistant**（问候），
//     若图省事"取最后一条助手消息"，问候语会被当成回复返回给客户端。
function harkAwaitReply(def, cid, messageId, timeoutMs, onNarration) {
  const t0 = Date.now();
  const st = { id: '', content: '', jobStatus: '', streaming: null, narration: '', sawSnapshot: false, frames: 0, ops: [] };
  const preexisting = new Set();          // 快照里已存在的助手消息 id（不是我们的回复）
  const note = (s) => { if (st.ops.length < 24) st.ops.push(s); };
  const isMine = (v) => (messageId && v && v.triggeredByMessageId === messageId);
  const done = () => {
    const awaiting = st.jobStatus === 'waiting_for_input' || st.jobStatus === 'awaiting_input';
    return {
      ok: !!st.content,
      text: st.content,
      jobStatus: st.jobStatus,
      awaitingInput: awaiting,
      narration: st.narration,
      sawSnapshot: st.sawSnapshot,
      frames: st.frames,
      ops: st.ops,
      ms: Date.now() - t0,
      error: st.content ? null : 'no assistant content',
    };
  };
  // "完成"必须**同时**有可交付内容或明确终态：否则一条空的完成帧（占位气泡）会让整轮提前收工、
  // 客户端拿到空回复（实测 entry_add 可能先带 isStreaming:false、正文随后才补）。
  const terminal = () => st.jobStatus === 'completed' || st.jobStatus === 'failed'
    || st.jobStatus === 'waiting_for_input' || st.jobStatus === 'awaiting_input';
  const finishable = () => !!st.content || terminal();
  const complete = () => st.streaming === false || terminal();
  const applyFields = (o) => {
    if (!o) return;
    if (o.content != null && String(o.content)) st.content = String(o.content);
    if (o.jobStatus) st.jobStatus = String(o.jobStatus);
    if (o.isStreaming != null) st.streaming = o.isStreaming;
  };
  return harkSyncStream(def, cid, (j) => {
    const ev = j.event || j;
    st.frames++;
    if (ev.type === 'snapshot') {
      st.sawSnapshot = true;
      const msgs = (ev.data && ev.data.messages) || {};
      const list = Object.values(msgs).filter((m) => m && m.role === 'assistant');
      for (const m of list) if (m.id) preexisting.add(String(m.id));
      note(`snapshot(assistant=${list.length})`);
      // 快照里只认精确命中（说明回复在我们连上流之前就完成了）；否则等流里的新消息
      const pick = list.find((m) => isMine(m));
      if (pick) {
        st.id = String(pick.id || '');
        applyFields(pick);
        if (complete() && finishable()) return done();
      }
      return null;
    }
    for (const p of Array.isArray(ev.data) ? ev.data : []) {
      if (!p || !p.op) continue;
      if (p.op === 'narration_update') {
        const n = (p.fields && p.fields.narration) || p.narration;
        if (n && n.line) { st.narration = String(n.line); note('narration'); if (onNarration) { try { onNarration(st.narration); } catch {} } }
        continue;
      }
      if (p.op === 'entry_add') {
        const v = p.value || {};
        if (v.role !== 'assistant') { note('entry_add:' + (v.role || '?')); continue; }
        const mine = isMine(v);
        const fresh = v.id && !preexisting.has(String(v.id));   // 连上流之后新出现的才算我们的
        note('entry_add:assistant' + (mine ? '*' : fresh ? '+' : '-'));
        if (!mine && !fresh) continue;                          // 快照里就有过的旧消息 → 不是回复
        if (!st.id) st.id = String(v.id || '');
        applyFields(v);
        if (complete() && finishable()) return done();
        continue;
      }
      if (p.op === 'message_update') {
        const target = String(p.id || p.messageId || (p.value && p.value.id) || (p.fields && p.fields.id) || '');
        note('message_update' + (target ? (target === st.id ? '*' : ':' + target.slice(0, 6)) : ''));
        // id 对得上、或本 patch 不带 id（那就只可能是我们正在等的那条）——但**必须先认领过**一条
        if (!st.id) continue;
        if (target && target !== st.id) continue;
        applyFields(p.fields || p.value || p);
        if (complete() && finishable()) return done();
        continue;
      }
      note(p.op);
    }
    return null;
  }, timeoutMs).then((r) => {
    if (r && r.ok) return r;
    // 超时/断流：已有正文就如实返回（partial，并带上帧序列便于诊断），否则把原因说清
    if (st.content) return Object.assign(done(), { ok: true, partial: true });
    return Object.assign(done(), { ok: false, error: (r && r.error) || 'no assistant content' });
  });
}

// 删除上游会话（尽力而为）：每轮成功后清掉，别让网关流量在用户账号里堆成一片会话。
// 失败**不报错**（删不掉最多是留一条会话，不影响本轮结果）。
async function harkDeleteConversation(def, cid, timeoutMs) {
  try {
    const out = await harkCurl('DELETE', `${baseOf(def)}/api/conversations/${encodeURIComponent(cid)}`, harkHeaders(def), null, timeoutMs || 10000, def.proxy);
    return { ok: out.status >= 200 && out.status < 300, status: out.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 尽力停止（形状未确证，失败不影响主流程）：客户端取消时调
async function harkStop(def, cid, timeoutMs) {
  try {
    const out = await harkCurl('POST', `${baseOf(def)}/api/messages/stop-tool`, harkHeaders(def, { 'Content-Type': 'application/json' }),
      JSON.stringify({ conversationId: cid }), timeoutMs || 10000, def.proxy);
    return { ok: out.status >= 200 && out.status < 300, status: out.status, body: String(out.body || '').slice(0, 120) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ─────────────────────────── 报文渲染 ───────────────────────────

// hark 的发送接口只收**一条字符串** → 把（已由 tool-emu 仿真过的）messages 拍平成一段文本。
// 每段带【角色】标注，让上游分得清系统设定 / 历史 / 工具结果 / 本次输入。
function flattenForHark(messages) {
  const roleName = (r) => (r === 'system' ? '系统设定' : r === 'assistant' ? '助手（此前回复）' : r === 'tool' ? '工具执行结果' : '用户');
  const parts = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) text = m.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).filter(Boolean).join('\n');
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      text += (text ? '\n' : '') + m.tool_calls.map((tc) => `[此前已请求调用工具 ${(tc.function && tc.function.name) || ''}] ${(tc.function && tc.function.arguments) || ''}`).join('\n');
    }
    if (!String(text).trim()) continue;
    parts.push(`【${roleName(m.role)}】\n${text}`);
  }
  return parts.join('\n\n');
}

function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

module.exports = {
  harkProbe,
  harkCreateConversation,
  harkConversationFor,
  harkDeleteConversation,
  harkSend,
  harkCurl,   // 供 hark-probe.js 做只读体检（会话清单 / 额度），不对外当渠道接口用
  harkAwaitReply,
  harkStop,
  flattenForHark,
  harkCookie,
  harkHeaders,
  // 测试用：会话映射的观测与重置
  _convMap: convMap,
  _convKeyOf: convKeyOf,
  _convReset: () => convMap.clear(),
  CONV_MAX,
  CONV_IDLE_MS,
  DEFAULT_BASE,
};
