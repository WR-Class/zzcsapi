'use strict';
/**
 * prism.js —— prism.openai.com 反代实现（通用 LLM gpt-5.6-sol + sandbox agent harness）
 *
 * 逆向自 Prism 前端，纯 HTTP 驱动，无需浏览器。完整链路见
 * docs/prism-reverse-proxy-research.md。
 *
 * 设计要点：
 * - 鉴权是 cookie（prism_session_token + prism_oai_access_token），配置里存成
 *   "k=v; k=v" 形式放在 apiKey。
 * - 必须走代理（Cloudflare 挡直连 + TLS 指纹），传输统一用 wbCurlRequest。
 * - 每次调用要 8 步握手起 sandbox；这里对「同一渠道 + 同一会话」做 sandbox 复用缓存。
 * - 多轮记忆：服务端记忆走 Next.js Server Actions（外部调不通），
 *   所以这里把历史压平进单条 user 文本。
 */

const crypto = require('crypto');

const PRISM_ORIGIN = 'https://prism.openai.com';
const PRISM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const PRISM_DEFAULT_MODEL = 'gpt-5.6-sol';
const PRISM_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

// sandbox 会话缓存：key = channelId，value = { sandboxUrl, sandboxToken, projectId, userId, expiresAt }
const prismSessions = new Map();

function prismJwtPayload(t) {
  try {
    const p = String(t || '').split('.')[1];
    if (!p) return {};
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return {}; }
}

/** 从配置的 apiKey 里解析 cookie；也允许直接粘整段 cookie 串 */
function prismCookie(def) {
  const raw = String((def && def.apiKey) || '').trim();
  if (!raw) throw new Error('prism: 未配置 cookie（apiKey 应为 prism_session_token=…; prism_oai_access_token=…）');
  if (!/=/.test(raw)) throw new Error('prism: cookie 格式不对，应形如 "prism_session_token=…; prism_oai_access_token=…"');
  return raw.replace(/\s+/g, ' ').trim();
}

/** 校验 cookie 里是否有必需的会话信息，并读出 userId */
function prismIdentity(cookie) {
  const m = cookie.match(/prism_session_token=([^;]+)/);
  if (!m) throw new Error('prism: cookie 里缺少 prism_session_token');
  const payload = prismJwtPayload(m[1]);
  const userId = payload && payload.policy && payload.policy.user && payload.policy.user.id;
  if (!userId) throw new Error('prism: prism_session_token 解析不出 userId（可能已过期，请重新导出 cookie）');
  const exp = Number(payload.exp || 0) * 1000;
  if (exp && Date.now() > exp) {
    throw new Error('prism: prism_session_token 已过期（有效期约 12 小时），请重新导出 cookie');
  }
  return { userId, exp, email: (payload.policy.user && payload.policy.user.email) || '' };
}

function prismHeaders(cookie, extra) {
  return Object.assign({
    'cookie': cookie,
    'User-Agent': PRISM_UA,
    'accept': 'application/json',
    'referer': PRISM_ORIGIN + '/',
    'origin': PRISM_ORIGIN,
    'content-type': 'application/json',
  }, extra || {});
}

/**
 * 执行 6 步 bootstrap，拿到一个已 synced 的 sandbox。
 * 返回 { sandboxUrl, sandboxToken, projectId, userId }
 */
async function prismBootstrap(io, def, opts) {
  const { wbCurlRequest } = io;
  const cookie = prismCookie(def);
  const ident = prismIdentity(cookie);
  const proxy = def.proxy;
  // 实测这些端点单次可达 60s+（上游 sandbox 子系统慢），默认给 90s
  const timeout = (opts && opts.timeoutMs) || 90000;
  const log = (opts && opts.log) || (() => {});

  // 解析 projectId：优先用渠道配置/显式传入，否则取项目列表第一个
  let projectId = (opts && opts.projectId) || def.prismProjectId || '';
  if (!projectId) {
    const r = await wbCurlRequest('GET', PRISM_ORIGIN + '/api/projects', prismHeaders(cookie), null, timeout, proxy);
    const j = r.body ? safeParse(r.body) : null;
    const list = (j && j.projects) || [];
    if (!list.length) throw new Error('prism: 该账号下没有项目，请先在 prism.openai.com 建一个项目');
    projectId = list[0].uuid;
  }
  log('prism 步骤1/6 项目 ' + projectId);

  // ① 新 sandbox
  // 注意：这个端点实测抖动很大（同一容器内 4.6s / 18s / 63s 都出现过），
  // 是上游创建/排队 sandbox 本身慢，不是网络问题。所以给足超时 + 重试。
  let sb = null, r1 = null;
  for (let i = 0; i < 3 && !sb; i++) {
    r1 = await wbCurlRequest('POST', PRISM_ORIGIN + '/api/backend/1/new', prismHeaders(cookie), '{}',
      (opts && opts.sandboxCreateTimeoutMs) || 150000, proxy);
    const j = r1.body ? safeParse(r1.body) : null;
    if (j && j.url && j.token) { sb = j; break; }
    if (i < 2) { log('prism 步骤1 建 sandbox 失败(' + r1.status + ')，重试 ' + (i + 1) + '/2'); await sleep(2500); }
  }
  if (!sb) {
    throw new Error('prism: 创建 sandbox 失败 HTTP ' + ((r1 && r1.status) || 0) + ' '
      + String((r1 && (r1.body || r1.error)) || '').slice(0, 160));
  }
  const sbase = String(sb.url).replace(/\/+$/, '');
  log('prism 步骤2/6 sandbox 就绪');

  // ② 资源令牌（必须带 sandbox_token，否则 sandbox 读不到工作区文件）
  // 实测这个端点 503 很常见（上游 sandbox 子系统抖动），多重试几次
  let rt = null, r2 = null;
  for (let i = 0; i < 5 && !(rt && rt.access_token); i++) {
    r2 = await wbCurlRequest('POST',
      PRISM_ORIGIN + '/api/projects/' + encodeURIComponent(projectId) + '/sandbox/resources-token',
      prismHeaders(cookie),
      JSON.stringify({ sandbox_session_id: null, sandbox_token: sb.token }),
      timeout, proxy);
    rt = r2.body ? safeParse(r2.body) : null;
    if (!rt || !rt.access_token) {
      rt = null;
      if (i < 4) { log('prism 步骤2 取资源令牌失败(' + r2.status + ')，重试 ' + (i + 1) + '/4'); await sleep(1500 + i * 1000); }
    }
  }
  if (!rt) {
    throw new Error('prism: 取资源令牌失败 HTTP ' + ((r2 && r2.status) || 0) + ' '
      + String((r2 && (r2.body || r2.error)) || '').slice(0, 160));
  }

  // ③ 把资源令牌推给 sandbox
  const t3 = Date.now();
  const r3 = await wbCurlRequest('POST', sbase + '/resources-token',
    prismHeaders(cookie, { 'X-Crixet-Sandbox-Token': sb.token }),
    JSON.stringify({ token: rt.access_token, resourceBaseUrl: rt.resources_base_url, projectId }),
    timeout, proxy);
  if (r3.status !== 200) {
    throw new Error('prism: 推送资源令牌失败 HTTP ' + r3.status + ' ' + String(r3.body || '').slice(0, 120));
  }
  log('prism 步骤3/6 资源令牌已推送（' + (Date.now() - t3) + 'ms）');

  // 预热：sandbox 刚建好时接口可能 5xx
  for (let i = 0; i < 8; i++) {
    const w = await wbCurlRequest('GET', sbase + '/wait-for-sync?wait_ms=3000',
      prismHeaders(cookie, { 'X-Crixet-Sandbox-Token': sb.token }), null, 15000, proxy);
    if (w.status === 200) break;
    await sleep(1500);
  }

  // ④ Y-Sweet 文档令牌（同样容易 5xx，重试）
  const t4 = Date.now();
  let ytok = null, r4 = null;
  for (let i = 0; i < 4 && !(ytok && ytok.url); i++) {
    r4 = await wbCurlRequest('POST', PRISM_ORIGIN + '/api/y', prismHeaders(cookie),
      JSON.stringify({ docId: projectId, requestContext: {
        source: 'initial-bootstrap', bootstrapAttempt: 0, previouslyConnected: false,
        sandboxUrl: sbase, maxAttempts: 5, requestSeriesId: crypto.randomUUID(),
      } }),
      timeout, proxy);
    ytok = r4.body ? safeParse(r4.body) : null;
    if (!ytok || !ytok.url) {
      ytok = null;
      if (i < 3) { log('prism 步骤4 取 Y-Sweet 令牌失败(' + r4.status + ')，重试 ' + (i + 1) + '/3'); await sleep(1500 + i * 1000); }
    }
  }
  if (!ytok) {
    throw new Error('prism: 取 Y-Sweet 令牌失败 HTTP ' + ((r4 && r4.status) || 0) + ' '
      + String((r4 && (r4.body || r4.error)) || '').slice(0, 160));
  }

  // ⑤ 把 Yjs 令牌推给 sandbox（重试：预热期可能 500）
  let pushed = false, lastErr = '';
  for (let i = 0; i < 5; i++) {
    const r5 = await wbCurlRequest('POST', sbase + '/token',
      prismHeaders(cookie, { 'X-Crixet-Sandbox-Token': sb.token }),
      JSON.stringify(ytok), timeout, proxy);
    if (r5.status === 200) { pushed = true; break; }
    lastErr = 'HTTP ' + r5.status + ' ' + String(r5.body || '').slice(0, 100);
    await sleep(1800);
  }
  if (!pushed) throw new Error('prism: 推送 Y-Sweet 令牌失败 ' + lastErr);
  log('prism 步骤4/6 Y-Sweet 令牌已推送（' + (Date.now() - t4) + 'ms）');

  // ⑥ 等同步完成
  const t6 = Date.now();
  for (let i = 0; i < 12; i++) {
    const w = await wbCurlRequest('GET', sbase + '/wait-for-sync?wait_ms=10000',
      prismHeaders(cookie, { 'X-Crixet-Sandbox-Token': sb.token }), null, 30000, proxy);
    const st = w.body ? safeParse(w.body) : null;
    if (st && st.status === 'synced' && st.tokens && st.tokens.hasSyncedYSweetProvider) {
      log('prism 步骤5/6 工作区已同步（' + (Date.now() - t6) + 'ms）');
      return { sandboxUrl: sbase, sandboxToken: sb.token, projectId, userId: ident.userId, email: ident.email };
    }
    if (st && st.status === 'failed') throw new Error('prism: sandbox 同步失败');
  }
  throw new Error('prism: sandbox 同步超时（wait-for-sync 未到 synced，已等 ' + Math.round((Date.now() - t6) / 1000) + 's）');
}

/** 拿（缓存的）sandbox 会话；失效自动重建 */
async function prismEnsureSession(io, ch, opts) {
  const key = ch.def.id;
  const cached = prismSessions.get(key);
  if (cached && Date.now() < cached.expiresAt && cached.sandboxUrl) {
    return cached;
  }
  const fresh = await prismBootstrap(io, ch.def, opts);
  // 复用能省掉约 65s 的 6 步握手（实测复用时 start 仅 ~1s），所以给到 25 分钟；
  // 真被回收了由 prismChatOnce 的失败分支自动重建
  prismSessions.set(key, Object.assign({}, fresh, { expiresAt: Date.now() + 25 * 60 * 1000 }));
  return fresh;
}

function prismDropSession(channelId) { prismSessions.delete(channelId); }

/** chat.completions messages → Prism 的单条 prompt（历史压平） */
function prismBuildPrompt(messages) {
  const sys = [];
  const turns = [];
  for (const m of messages || []) {
    const text = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((p) => (p && (p.text || (p.type === 'image_url' ? '[图片]' : ''))) || '').join('')
      : String(m.content || '');
    if (!text.trim() && m.role !== 'assistant') continue;
    if (m.role === 'system' || m.role === 'developer') { sys.push(text.trim()); continue; }
    turns.push({ role: m.role === 'assistant' ? 'assistant' : 'user', text });
  }
  // 只有一轮 user：直接发原文（避免多套一层壳影响效果）
  const onlyOne = turns.length === 1 && turns[0].role === 'user';
  let prompt;
  if (onlyOne) {
    prompt = turns[0].text;
  } else {
    const lines = [];
    // 最后一条一定是本次提问，其余作为历史
    const last = turns[turns.length - 1];
    const history = turns.slice(0, -1);
    if (history.length) {
      lines.push('对话历史：');
      for (const t of history) lines.push(`${t.role === 'user' ? '用户' : '助手'}：${t.text}`);
      lines.push('');
    }
    lines.push(`现在回答：${last ? last.text : ''}`);
    prompt = lines.join('\n');
  }
  if (sys.length) prompt = sys.join('\n') + '\n\n' + prompt;
  return prompt;
}

/** 发起一轮，返回最终文本。内部含重试 + sandbox 失效重建 */
async function prismChatOnce(io, ch, opts) {
  const { wbCurlRequest } = io;
  const { model, prompt, timeoutMs, effort } = opts;
  // 调用方可能不传 log —— 给个空实现，避免 "log is not a function"
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const cookie = prismCookie(ch.def);
  const proxy = ch.def.proxy;
  // bootstrap 本身可能耗 1~2 分钟（上游 sandbox 子系统慢），单独给预算
  const sess = await prismEnsureSession(io, ch, { timeoutMs: 90000, sandboxCreateTimeoutMs: 150000, log });

  const metadata = {
    projectId: sess.projectId,
    userId: sess.userId,
    model: model || PRISM_DEFAULT_MODEL,
    reasoning_effort: PRISM_EFFORTS.includes(effort) ? effort : 'low',
    frontend_origin: PRISM_ORIGIN,
    sandbox_url: sess.sandboxUrl,
    sandbox_token: sess.sandboxToken,
  };
  const body = JSON.stringify({
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    previousResponseId: null,
    metadata,
    conversationId: null,
  });

  log('prism 步骤6/6 发起回合');
  const tStart = Date.now();
  const start = await wbCurlRequest('POST', PRISM_ORIGIN + '/api/llm/response_with_tools_start',
    prismHeaders(cookie), body, timeoutMs, proxy);
  log('prism start 返回 ' + start.status + '（' + (Date.now() - tStart) + 'ms）');
  let j = start.body ? safeParse(start.body) : null;
  if (!j) {
    return { ok: false, retryable: true, error: 'prism start: HTTP ' + start.status + ' ' + String(start.body || start.error || '').slice(0, 160) };
  }
  if (j.status === 'completed') {
    return prismExtract(j);
  }
  if (j.status !== 'started') {
    const p = (j.response && j.response.payload) || {};
    const why = String(p.rootCause || p.message || '未进入 started');
    const retryable = /healthz|sandbox|reconnect|lookup failed|5\d\d|Gateway Timeout/i.test(why);
    if (retryable) prismDropSession(ch.def.id); // 下次重建 sandbox
    return { ok: false, retryable, error: 'prism start: ' + why.slice(0, 200) };
  }

  // 轮询
  let turnState = j.turn_state;
  const reqId = j.request_id;
  const deadline = Date.now() + Math.max(60000, timeoutMs - 15000);
  let lastProgress = '';
  while (Date.now() < deadline) {
    await sleep(3000);
    const s = await wbCurlRequest('POST', PRISM_ORIGIN + '/api/llm/response_with_tools_status',
      prismHeaders(cookie), JSON.stringify({ request_id: reqId, turn_state: turnState }), 60000, proxy);
    const k = s.body ? safeParse(s.body) : null;
    if (!k) continue;
    if (k.turn_state) turnState = k.turn_state;
    if (k.codex_live_progress) {
      const p = k.codex_live_progress;
      const line = p.last_tool_progress_line || p.status || '';
      if (line && line !== lastProgress) { lastProgress = line; log('prism 进行中: ' + String(line).slice(0, 100)); }
    }
    if (k.status === 'completed') return prismExtract(k);
  }
  return { ok: false, retryable: true, error: 'prism: 轮询超时（回合未在时限内完成）' };
}

/** 从 completed 信封里抽取文本 */
function prismExtract(envelope) {
  const resp = envelope.response || {};
  const payload = resp.payload || {};
  if (resp.status !== 'success') {
    const why = [payload.reason, payload.message, payload.rootCause].filter(Boolean).join(' / ');
    const retryable = /5\d\d|timeout|sandbox|reconnect/i.test(why);
    return { ok: false, retryable, error: 'prism 回合失败: ' + String(why || 'unknown').slice(0, 220) };
  }
  const text = (payload.output || [])
    .flatMap((it) => it.content || [])
    .filter((c) => c && (c.type === 'output_text' || typeof c.text === 'string'))
    .map((c) => c.text || '')
    .join('\n')
    .trim();
  if (!text) return { ok: false, retryable: true, error: 'prism: 回合完成但输出为空' };
  if (text === 'Codex did not produce an answer') return { ok: false, retryable: true, error: 'prism: 模型未产出答案（请重试）' };
  const df = payload.codexDeltaFiles;
  const files = Array.isArray(df) ? df.map((f) => f.file_path).filter(Boolean) : (df && df.file_path ? [df.file_path] : []);
  return { ok: true, text, files, conversationId: payload.conversationId || envelope.conversation_id || '' };
}

/** 探测：验证 cookie 有效 + 列出可用模型 */
async function prismProbe(io, def, timeoutMs) {
  const { wbCurlRequest } = io;
  const t0 = Date.now();
  try {
    const cookie = prismCookie(def);
    const ident = prismIdentity(cookie);
    const r = await wbCurlRequest('GET', PRISM_ORIGIN + '/api/projects', prismHeaders(cookie), null, timeoutMs || 15000, def.proxy);
    const j = r.body ? safeParse(r.body) : null;
    if (r.status !== 200 || !j || !Array.isArray(j.projects)) {
      const msg = (j && (j.error || j.message)) || String(r.body || r.error || '').slice(0, 140);
      return { ok: false, status: r.status || 0, error: 'prism: HTTP ' + r.status + ' ' + msg, latencyMs: Date.now() - t0 };
    }
    let models = Object.values(def.models || {}).filter(Boolean);
    if (!models.length) models = [PRISM_DEFAULT_MODEL];
    return {
      ok: true, models, latencyMs: Date.now() - t0, status: 200,
      account: {
        email: ident.email || undefined,
        projects: j.projects.map((p) => p.name || p.uuid).slice(0, 5),
        note: 'prism 无 /models 端点，模型列表来自别名配置（默认建议 ' + PRISM_DEFAULT_MODEL + '）',
      },
    };
  } catch (err) {
    return { ok: false, status: 0, error: String(err.message || err), latencyMs: Date.now() - t0 };
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  PRISM_ORIGIN, PRISM_UA, PRISM_DEFAULT_MODEL, PRISM_EFFORTS,
  prismCookie, prismIdentity, prismBootstrap, prismEnsureSession, prismDropSession,
  prismBuildPrompt, prismChatOnce, prismProbe, prismSessions,
};
