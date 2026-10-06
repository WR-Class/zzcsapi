// notion.js - Notion AI 逆向协议支持（零依赖 Node）
// 参考 notion2api (github.com/maverickxone/notion2api) 的协议逆向：
//   POST /api/v3/runInferenceTranscript，cookie 鉴权，NDJSON 流响应
// 渠道配置：protocol="notion", apiKey=token_v2, baseUrl=https://www.notion.so
// 凭据发现：getSpaces 自动拿 user_id / space_id / space_view_id（缓存于渠道运行态）

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ─────────────────────────── 模型映射 ───────────────────────────
// 对外模型名 → Notion 内部代号
// 2026-09-06 经 /api/v3/getAvailableModels（spaceId 鉴权）全量刷新：33 个模型
const NOTION_MODEL_MAP = {
  'gpt-6-astra': 'orlando-quinn',
  'gpt-5.6-sol': 'orange-mousse',
  'gpt-5.6-terra': 'orchid-muffin',
  'gpt-5.6-luna': 'olive-jellyroll',
  'gpt-5.2': 'oatmeal-cookie',
  'gpt-5.4': 'oval-kumquat-medium',
  'gpt-5.4-mini': 'oregon-grape-medium',
  'gpt-5.4-nano': 'otaheite-apple-medium',
  'gpt-5.5': 'opal-quince-medium',
  'gemini-3.5flash': 'vertex-gemini-3.5-flash',
  'gemini-3.6flash': 'vertex-gemini-3.6-flash',
  'gemini-3.7flash': 'grapefruit-zeppole',
  'gemini-3.1pro': 'galette-medium-thinking',
  'gemini-3flash': 'gingerbread',
  'claude-sonnet4.6': 'almond-croissant-low',
  'claude-sonnet5': 'angel-cake-high',
  'claude-opus4.6': 'avocado-froyo-medium',
  'claude-opus4.7': 'apricot-sorbet-high',
  'claude-opus4.8': 'ambrosia-tart-high',
  'claude-opus5': 'agave-flan',
  'claude-haiku4.5': 'anthropic-haiku-4.5',
  'fable-5.1': 'assam-chai',
  'fable-5': 'acai-budino-high',
  'kimi-k3': 'fireworks-kimi-k3',
  'kimi-2.7': 'fireworks-kimi-k2.7',
  'kimi-2.6': 'fireworks-kimi-k2.6',
  'deepseek-v4pro': 'baseten-deepseek-v4-pro',
  'deepseek-v4flash': 'baseten-deepseek-v4-flash',
  'glm-5.2': 'baseten-glm-5.2',
  'grok-4.6': 'soursop-shortcake',
  'grok-4.3': 'xigua-mochi-medium',
  'grok-4.5': 'strawberry-whoopiepie',
  'grok-build0.1': 'xinomavro-cake',
};

// Notion 内部代号 → 对外模型名
const NOTION_MODEL_REVERSE = Object.fromEntries(Object.entries(NOTION_MODEL_MAP).map(([k, v]) => [v, k]));

// 需要 markdown-chat 线程类型的模型（vertex- 前缀）
const NOTION_MARKDOWN_CHAT = new Set(['vertex-gemini-3.5-flash']);

const NOTION_DEFAULT_MODEL = 'claude-sonnet4.6';

function notionModel(name) {
  return NOTION_MODEL_MAP[String(name || '').toLowerCase()] || NOTION_MODEL_MAP[NOTION_DEFAULT_MODEL];
}

function notionThreadType(notionModelId) {
  return NOTION_MARKDOWN_CHAT.has(notionModelId) ? 'markdown-chat' : 'workflow';
}

function notionListModels() {
  return Object.keys(NOTION_MODEL_MAP);
}

// ─────────────────────────── system 提示词净化 ───────────────────────────
// Notion AI 会拒绝"身份劫持"式 system（"You are Claude Code"等）。
// 剥掉已知 agent 身份声明，剩下的重构成"用户偏好"注入。

const KNOWN_AGENT_NAMES = String.raw`opencode|notion2api|claude\s*code|aider|cursor|cline|continue|roo|kilo|trae|windsurf|copilot|codex|gemini\s*cli|your own coding assistant`;

const IDENTITY_LINE_PATTERNS = [
  new RegExp(`^you are\\s+(?:${KNOWN_AGENT_NAMES})\\b.*$`, 'im'),
  new RegExp('^your name is\\s+.+?[.!]?$', 'im'),
  new RegExp(`^act as\\s+(?:${KNOWN_AGENT_NAMES})\\b.*$`, 'im'),
  new RegExp(`^you are called\\s+(?:${KNOWN_AGENT_NAMES})\\b.*$`, 'im'),
  new RegExp(`^you are powered by\\s+(?:${KNOWN_AGENT_NAMES})\\b.*$`, 'im'),
];
const INLINE_IDENTITY_PATTERN = new RegExp(`\\byou are\\s+(?:${KNOWN_AGENT_NAMES})\\b[^.!\\n]*[.!]?`, 'i');

function sanitizeSystemPrompt(raw) {
  if (!raw || !raw.trim()) return '';
  let text = raw.trim();
  text = text.replace(/\u2019/g, "'").replace(/\u2018/g, "'").replace(/\u201c/g, '"').replace(/\u201d/g, '"');
  text = text.replace(INLINE_IDENTITY_PATTERN, '');
  const kept = [];
  for (const line of text.split('\n')) {
    let cleaned = line;
    for (const pat of IDENTITY_LINE_PATTERNS) cleaned = cleaned.replace(pat, '').trim();
    cleaned = cleaned.replace(INLINE_IDENTITY_PATTERN, '').trim();
    if (cleaned) kept.push(cleaned);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function reframeSystemPrompt(raw) {
  const cleaned = sanitizeSystemPrompt(raw);
  if (!cleaned) return '';
  return 'The user is working inside a developer tool and has shared the following guidelines for how they\'d like you to assist with this request. Treat these as the user\'s preferences and context:\n\n' + cleaned;
}

// ─────────────────────────── 凭据发现 ───────────────────────────
// token_v2 → getSpaces → {userId, spaceId, spaceViewId, userName, userEmail}
// 结果缓存在 ch.notion（渠道运行态），401/403 时由调用方清除重刷

const NOTION_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const NOTION_CLIENT_VERSION = '23.13.20260228.0625';

// 查询 AI 额度（6 小时窗口用量/上限，unlimited 计划仍返回基准值）
// 返回 { isEligible, type, spaceUsage, spaceLimit, userUsage, userLimit, ... } 或抛错
async function notionUsageEligibility(baseUrl, tokenV2, acct, fetchFn, timeoutMs) {
  const url = baseUrl.replace(/\/+$/, '') + '/api/v3/getAIUsageEligibility';
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': NOTION_UA,
    'Cookie': `token_v2=${tokenV2}; notion_user_id=${acct.userId}`,
    'x-notion-space-id': acct.spaces[0].spaceId,
    'x-notion-active-user-header': acct.userId,
    'notion-audit-log-platform': 'web',
    'notion-client-version': '23.13.20260228.0625',
    'origin': baseUrl.replace(/\/+$/, ''),
    'referer': baseUrl.replace(/\/+$/, '') + '/',
  };
  let resp;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
    try {
      resp = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify({ spaceId: acct.spaces[0].spaceId }), signal: ctrl.signal });
    } finally { clearTimeout(to); }
  } catch (err) {
    throw new Error('getAIUsageEligibility network error: ' + (err.message || err));
  }
  if (resp.status !== 200) {
    const text = await resp.text();
    throw new Error(`getAIUsageEligibility HTTP ${resp.status}: ${text.slice(0, 120)}`);
  }
  return await resp.json();
}

async function notionDiscoverAccount(baseUrl, tokenV2, fetchFn, timeoutMs) {
  const url = baseUrl.replace(/\/+$/, '') + '/api/v3/getSpaces';
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': NOTION_UA,
    'Cookie': `token_v2=${tokenV2}`,
  };
  let resp;
  try {
    const ctrl = new AbortController && new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
    try {
      resp = await fetchFn(url, { method: 'POST', headers, body: '{}', signal: ctrl.signal });
    } finally { clearTimeout(to); }
  } catch (err) {
    throw new Error('getSpaces network error: ' + (err.message || err));
  }
  const text = await resp.text();
  if (resp.status !== 200) {
    const err = new Error(`getSpaces HTTP ${resp.status}: ${text.slice(0, 150)}`);
    err.status = resp.status;
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('getSpaces: invalid JSON'); }
  // getSpaces: { [userId]: { space: {...}, space_view: {...}, notion_user: {...} } }
  let userId = '', userName = 'user', userEmail = '';
  const spaces = []; // {spaceId, spaceViewId, name}
  for (const [uid, ud] of Object.entries(data || {})) {
    if (!ud || typeof ud !== 'object') continue;
    // 第一个用户即当前账号（token 对应唯一）
    if (!userId) {
      userId = uid;
      const nu = ud.notion_user || {};
      const nuEntry = Object.values(nu)[0];
      if (nuEntry) {
        const v = (nuEntry.value && (nuEntry.value.value || nuEntry.value)) || nuEntry;
        userName = v.given_name || v.name || v.family_name || 'user';
        userEmail = v.email || '';
      }
    }
    for (const [sid, sd] of Object.entries(ud.space || {})) {
      if (spaces.find((s) => s.spaceId === sid)) continue;
      const v = (sd.value && (sd.value.value || sd.value)) || sd;
      spaces.push({ spaceId: sid, name: v.name || '' });
    }
    for (const [svid, svd] of Object.entries(ud.space_view || {})) {
      const v = (svd.value && (svd.value.value || svd.value)) || svd;
      if (v.space_id) {
        const s = spaces.find((x) => x.spaceId === v.space_id);
        if (s && !s.spaceViewId) s.spaceViewId = svid;
      }
    }
  }
  if (!userId || !spaces.length) throw new Error('getSpaces: no user or space found (token_v2 invalid?)');
  return { userId, userName, userEmail, spaces };
}

// ─────────────────────────── transcript 构建 ───────────────────────────
// [config, context, ...user/assistant 消息]
// system → 净化+reframe 后并入第一条 user
// assistant → agent-inference block（Notion 的 assistant 历史格式）

function uuid4() {
  // 零依赖 UUID（crypto.randomUUID Node 16.7+，兜底手搓）
  try { return require('crypto').randomUUID(); } catch { return 'xxxxxxxxyxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; const v = c === 'x' ? r : (r & 3 | 8); return v.toString(16); }).replace(/^(.{8})(.{4})/, '$1-$2-'); }
}

function buildNotionTranscript(messages, upstreamModel, acct, opts) {
  const notionModelId = notionModel(upstreamModel);
  const threadType = notionThreadType(notionModelId);
  // opts.useWebSearch === false：请求带外部工具仿真时关掉 notion 内置搜索
  // （否则超长上下文下模型可能调用内置搜索工具、输出 notion 内部格式）
  const useWebSearch = !(opts && opts.useWebSearch === false);
  const t = [];
  t.push({
    id: uuid4(),
    type: 'config',
    value: {
      type: threadType,
      model: notionModelId,
      modelFromUser: true,
      useWebSearch,
    },
  });
  t.push({
    id: uuid4(),
    type: 'context',
    value: {
      timezone: 'Asia/Shanghai',
      currentDatetime: new Date().toISOString(),
      userId: acct.userId,
      spaceId: acct.spaceId,
    },
  });
  // 收集 system + 对话
  const systemParts = [];
  const dialog = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    let content = '';
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.map((p) => p && (typeof p === 'string' ? p : p.text) || '').filter(Boolean).join('\n');
    if (m.role === 'system') { if (content.trim()) systemParts.push(content.trim()); continue; }
    if (m.role === 'user' || m.role === 'assistant') dialog.push({ role: m.role, content });
  }
  if (!dialog.length) return { error: 'no user message' };
  // system 净化 + reframe → 并入第一条 user
  if (systemParts.length) {
    const reframed = reframeSystemPrompt(systemParts.join('\n'));
    if (reframed && dialog[0].role === 'user') dialog[0].content = reframed + '\n\n' + dialog[0].content;
  }
  for (const d of dialog) {
    if (d.role === 'assistant') {
      t.push({
        id: uuid4(),
        type: 'agent-inference',
        value: [{ type: 'text', content: d.content }],
      });
    } else {
      t.push({
        id: uuid4(),
        type: 'user',
        value: [[d.content]],
        userId: acct.userId,
        createdAt: new Date().toISOString(),
      });
    }
  }
  return { transcript: t, threadType };
}

// ─────────────────────────── 请求组装 ───────────────────────────

function notionBuildPayload(transcript, threadType, acct, opts) {
  // opts 只服务「流断兜底：同一线程再发一次」（v1.18.39）。不传时与首发逐字节一致：
  //   threadId  —— 复用同一条线程（兜底必需；首发自造）
  //   createThread:false + isPartialTranscript:true —— 活体验证过的取回形状
  //   （见 server.js notionRefetchAnswer 的注释：A1/A2 实测 HTTP 200 + record-map 全文）
  const o = opts || {};
  const threadId = o.threadId || uuid4();
  return {
    traceId: uuid4(),
    spaceId: acct.spaceId,
    threadId,
    threadType,
    createThread: o.createThread !== false,
    generateTitle: o.generateTitle !== false,
    saveAllThreadOperations: true,
    setUnreadState: true,
    isPartialTranscript: o.isPartialTranscript === true,
    asPatchResponse: true,
    isUserInAnySalesAssistedSpace: false,
    isSpaceSalesAssisted: false,
    threadParentPointer: { table: 'space', id: acct.spaceId, spaceId: acct.spaceId },
    transcript,
    debugOverrides: {
      emitAgentSearchExtractedResults: true,
      cachedInferences: {},
      annotationInferences: {},
      emitInferences: false,
    },
  };
}

function notionHeaders(acct, tokenV2, baseUrl) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/x-ndjson',
    'User-Agent': NOTION_UA,
    'x-notion-space-id': acct.spaceId,
    'x-notion-active-user-header': acct.userId,
    'notion-audit-log-platform': 'web',
    'notion-client-version': NOTION_CLIENT_VERSION,
    'origin': baseUrl,
    'referer': baseUrl + '/ai',
    'cookie': `token_v2=${tokenV2}; notion_user_id=${acct.userId}`,
  };
}

// ─────────────────────────── NDJSON 流解析 ───────────────────────────
// 段落注册表移植（简化）：
//   o:"a" + /s/-  → 新段落注册（v.type 标角色：agent-inference=thinking, text=content, title=meta）
//   o:"x" + /s/N/value/M/content → 追加文本
//   record-map / markdown-chat 事件 → final_content（权威全文）
// 输出事件：{type:'content'|'thinking'|'final', text}

const SEG_THINKING = 'thinking', SEG_TOOL = 'tool', SEG_CONTENT = 'content', SEG_META = 'meta';
const THINKING_TYPES = ['agent-inference', 'thinking', 'reasoning', 'inference'];
const TOOL_TYPES = ['agent-tool-result', 'tool_use', 'tool', 'search', 'web', 'citation'];

function classifySeg(t) {
  const s = String(t || '').toLowerCase();
  if (!s) return SEG_CONTENT;
  if (s === 'text') return SEG_CONTENT;
  if (s === 'title') return SEG_META;
  if (THINKING_TYPES.some((k) => s.includes(k))) return SEG_THINKING;
  if (TOOL_TYPES.some((k) => s.includes(k))) return SEG_TOOL;
  return SEG_CONTENT;
}

// <lang ...> 标记清理（Notion 内部语言标记，跨块截断）
function stripLangTags(text, state) {
  let out = '', i = 0;
  while (i < text.length) {
    if (state.inLang) {
      const end = text.indexOf('>', i);
      if (end === -1) break;
      state.inLang = false; i = end + 1; continue;
    }
    const ls = text.indexOf('<lang', i);
    const cs = text.indexOf('</lang>', i);
    const cands = [];
    if (ls !== -1) cands.push([ls, 'open']);
    if (cs !== -1) cands.push([cs, 'close']);
    if (!cands.length) { out += text.slice(i); break; }
    cands.sort((a, b) => a[0] - b[0]);
    const [pos, typ] = cands[0];
    out += text.slice(i, pos);
    if (typ === 'close') { i = pos + 7; continue; }
    const end = text.indexOf('>', pos);
    if (end === -1) { state.inLang = true; break; }
    i = end + 1;
  }
  return out;
}

function cleanNotionMarkup(t) {
  return t
    .replace(/<lang\b[^>]*>([\s\S]*?)<\/lang>/g, '$1')
    .replace(/<\/lang>/g, '')
    .replace(/<lang\b[^>]*>/g, '')
    .replace(/\bprimary="[a-zA-Z-]{1,15}"\s*/g, '')
    .replace(/^-?[a-zA-Z]{0,4}"\s*>\s*/, '');
}

function normalizePath(patch) {
  for (const k of ['path', 'p', 'pointer', 'at']) {
    if (k in patch) {
      const raw = patch[k];
      if (Array.isArray(raw)) return raw.map(String).join('/');
      return String(raw);
    }
  }
  return '';
}

function segIdx(path) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2 || parts[0] !== 's') return null;
  const n = Number(parts[1]);
  return Number.isInteger(n) ? n : null;
}

function valIdx(path) {
  const parts = path.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === 'value' && i + 1 < parts.length) {
      const n = Number(parts[i + 1]);
      if (Number.isInteger(n)) return n;
    }
  }
  return null;
}

function extractText(patch) {
  const op = patch.o;
  if (op === 'a') {
    const v = patch.v;
    if (v && typeof v === 'object' && Array.isArray(v.value)) {
      return v.value.map((it) => it && typeof it === 'object' && typeof it.content === 'string' ? it.content : '').join('');
    }
    if (v && typeof v === 'object' && typeof v.content === 'string') return v.content;
    return '';
  }
  if ((op === 'x' || op === 'p') && typeof patch.v === 'string') {
    if (op === 'p') {
      const p = normalizePath(patch);
      if (!p.includes('/content') && !p.includes('/text')) return '';
    }
    return patch.v;
  }
  return '';
}

function extractMarkdownChatText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((it) => {
      if (typeof it === 'string') return it;
      if (it && typeof it === 'object') {
        if (String(it.type || '').toLowerCase() === 'text' && typeof it.content === 'string') return it.content;
        if ('value' in it) return extractMarkdownChatText(it.value);
      }
      return '';
    }).join('');
  }
  if (value && typeof value === 'object') {
    for (const k of ['value', 'content', 'text']) {
      if (k in value) {
        const r = extractMarkdownChatText(value[k]);
        if (r) return r;
      }
    }
  }
  return '';
}

// record-map: thread_message → step（markdown-chat / agent-inference / text）取最优全文
function extractFinalFromRecordMap(data) {
  const rm = data.recordMap;
  if (!rm || typeof rm !== 'object') return null;
  const tm = rm.thread_message;
  if (!tm || typeof tm !== 'object') return null;
  const PRI = { 'markdown-chat': 400, 'text': 350, 'agent-inference': 300, 'title': 50 };
  const cands = [];
  for (const [mid, md] of Object.entries(tm)) {
    if (!md || typeof md !== 'object') continue;
    const ov = md.value;
    if (!ov || typeof ov !== 'object') continue;
    const iv = ov.value;
    if (!iv || typeof iv !== 'object') continue;
    const step = iv.step;
    if (!step || typeof step !== 'object') continue;
    const st = String(step.type || '').toLowerCase();
    let content = '';
    if (st === 'markdown-chat') content = extractMarkdownChatText(step.value);
    else if (st === 'agent-inference') content = (Array.isArray(step.value) ? step.value : []).map((it) => it && it.type === 'text' && typeof it.content === 'string' ? it.content : '').join('');
    else if (st === 'text' || st === 'title') content = typeof step.value === 'string' ? step.value : '';
    content = cleanNotionMarkup(content || '').trim();
    if (content) cands.push({ st, pri: PRI[st] || 100, edited: Number(iv.last_edited_time) || 0, created: Number(iv.created_time) || 0, len: content.length, text: content });
  }
  if (!cands.length) return null;
  // 高优先级过滤：有 text/markdown-chat 时忽略 agent-inference（防重复）
  const hasHigh = cands.some((c) => c.st === 'text' || c.st === 'markdown-chat');
  const pool = hasHigh ? cands.filter((c) => c.st === 'text' || c.st === 'markdown-chat') : cands;
  pool.sort((a, b) => (b.pri - a.pri) || (b.edited - a.edited) || (b.created - a.created) || (b.len - a.len));
  return pool[0].text;
}

// 主解析器：输入 NDJSON 文本行，输出事件数组 {type:'content'|'thinking'|'final', text}
// onEvent(evt) 同步回调；跨行状态保存在 st
function createNotionStreamParser(onEvent) {
  const st = {
    inLang: false,
    segmentTypes: new Map(),   // notionIndex → seg class
    valueTypes: new Map(),     // `${si}:${vi}` → seg class
    nextValId: new Map(),      // notionIndex → int
    pending: [],               // 待绑定段落
    sawContent: false,
    sawFinal: false,           // 权威全文（record-map / markdown-chat）到过没有 —— 流断兜底的触发判据
    finalText: '',
  };
  return {
    state: st,
    // 处理一行 NDJSON
    line(rawLine) {
      const line = String(rawLine || '').trim();
      if (!line) return;
      let data;
      try { data = JSON.parse(line); } catch { return; }
      const dt = String(data.type || '').toLowerCase();
      if (dt === 'record-map') {
        const f = extractFinalFromRecordMap(data);
        if (f) { st.finalText = f; st.sawFinal = true; onEvent({ type: 'final', text: f }); }
        return;
      }
      if (dt === 'markdown-chat') {
        const t = cleanNotionMarkup(extractMarkdownChatText(data.value) || '').trim();
        if (t) { st.finalText = t; st.sawFinal = true; onEvent({ type: 'final', text: t }); }
        return;
      }
      if (dt !== 'patch') return;
      const patches = data.v;
      if (!Array.isArray(patches)) return;
      for (const patch of patches) {
        if (!patch || typeof patch !== 'object') continue;
        this._patch(patch, st, onEvent);
      }
    },
    _patch(patch, st, onEvent) {
      const op = String(patch.o || '');
      const path = normalizePath(patch);
      const pSeg = segIdx(path);
      const patchType = String(patch.type || '').toLowerCase();
      const nestedType = patch.v && typeof patch.v === 'object' ? String(patch.v.type || '').toLowerCase() : '';
      const effType = patchType || nestedType;

      let patchRole = null;
      const pathStripped = path.replace(/^\//, '');
      const isNewSeg = (op === 'a' && pathStripped === 's/-');

      if (isNewSeg) {
        const segClass = classifySeg(effType);
        const localValTypes = new Map();
        let localNext = 0;
        if (patch.v && typeof patch.v === 'object' && Array.isArray(patch.v.value)) {
          if (segClass !== SEG_CONTENT) {
            // thinking/tool/meta 段落内的 value item 继承段落角色
            // （agent-inference 内的 {type:'text'} 子项就是思考文本，不能按 item 类型误判为 content）
            patch.v.value.forEach((item, idx) => { localValTypes.set(idx, segClass); localNext = idx + 1; });
          } else {
            patch.v.value.forEach((item, idx) => {
              if (item && typeof item === 'object') {
                const c = classifySeg(item.type);
                localValTypes.set(idx, c);
                localNext = idx + 1;
              }
            });
          }
        }
        if (!localValTypes.has(0)) { localValTypes.set(0, segClass); localNext = Math.max(localNext, 1); }
        st.pending.push({ segClass, localValTypes, localNext });
        patchRole = localValTypes.get(0) || segClass;
      } else if (op === 'a' && pSeg !== null) {
        // 已有段落的子追加：/s/N/value/-
        if (!st.segmentTypes.has(pSeg) && st.pending.length) this._bind(pSeg, st, path);
        if (!st.segmentTypes.has(pSeg)) st.segmentTypes.set(pSeg, classifySeg(effType));
        // value block 序号
        const parts = path.split('/').filter(Boolean);
        if (parts.length === 4 && parts[0] === 's' && parts[2] === 'value') {
          const raw = parts[3];
          let vid = raw === '-' ? (st.nextValId.get(pSeg) || 0) : Number(raw);
          st.nextValId.set(pSeg, Math.max(st.nextValId.get(pSeg) || 0, vid + 1));
          const vc = classifySeg(effType);
          st.valueTypes.set(`${pSeg}:${vid}`, vc);
          patchRole = vc;
          st.inLang = false;
        }
      }

      // 绑定 pending（首次引用未知 index 时）
      if (pSeg !== null && !st.segmentTypes.has(pSeg) && st.pending.length) this._bind(pSeg, st, path);

      // 角色确定
      let segOwner;
      if (patchRole !== null) {
        segOwner = patchRole;
      } else {
        const vi = valIdx(path);
        if (vi !== null && pSeg !== null && st.valueTypes.has(`${pSeg}:${vi}`)) segOwner = st.valueTypes.get(`${pSeg}:${vi}`);
        else if (pSeg !== null && st.segmentTypes.has(pSeg)) segOwner = st.segmentTypes.get(pSeg);
        else segOwner = SEG_CONTENT;
      }

      // 文本提取
      if (op === 'p' && path.includes('/content') && typeof patch.v === 'string') {
        if (patch.v.includes('>') || patch.v.includes('\n') || !patch.v.trim()) st.inLang = false;
      }
      let content = extractText(patch);
      if (!content) return;
      let cleaned = stripLangTags(content, st);
      cleaned = cleanNotionMarkup(cleaned);
      if (!cleaned) return;

      if (segOwner === SEG_META) return;
      if (segOwner === SEG_THINKING || segOwner === SEG_TOOL) {
        onEvent({ type: 'thinking', text: cleaned });
      } else {
        st.sawContent = true;
        onEvent({ type: 'content', text: cleaned });
      }
    },
    _bind(notionIdx, st, patchPath) {
      if (!st.pending.length) return;
      const vi = valIdx(patchPath);
      let best = 0;
      if (vi !== null) {
        for (let i = 0; i < st.pending.length; i++) {
          if (st.pending[i].localValTypes.get(vi) === SEG_THINKING) { best = i; break; }
        }
      }
      const chosen = st.pending.splice(best, 1)[0];
      st.segmentTypes.set(notionIdx, chosen.segClass);
      for (const [vi2, cls] of chosen.localValTypes) st.valueTypes.set(`${notionIdx}:${vi2}`, cls);
      st.nextValId.set(notionIdx, chosen.localNext);
    },
  };
}

module.exports = {
  NOTION_MODEL_MAP,
  NOTION_MODEL_REVERSE,
  notionModel,
  notionThreadType,
  notionListModels,
  notionDiscoverAccount,
  notionUsageEligibility,
  buildNotionTranscript,
  notionBuildPayload,
  notionHeaders,
  createNotionStreamParser,
  reframeSystemPrompt,
  NOTION_UA,
};
