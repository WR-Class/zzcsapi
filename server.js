// ZZCSAPI - 本地多渠道 OpenAI / Anthropic / Gemini 兼容聚合网关
// 用法：  1) node server.js                        （用 ./config.json）
//        2) DSH 模型地址填 http://127.0.0.1:8787/v1
// 目标：多渠道 API key 统一调度，失败自动切换，全失败才报错
// 依赖：仅 Node 18+ 自带 fetch / ReadableStream / setTimeout

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

// ─────────────────────────── 鉴权 ───────────────────────────
const GATEWAY_KEY = process.env.GATEWAY_KEY || ''; // 客户端调 /v1/* / /anthropic/* / /gemini/*
const ADMIN_KEY   = process.env.ADMIN_KEY   || ''; // 调 /admin/* + Web 控制台
function checkAuth(req, kind) {
  // kind: 'gateway' | 'admin'
  if (kind === 'admin' && !ADMIN_KEY) return true;       // 没设置就放行（仅本机）
  if (kind === 'gateway' && !GATEWAY_KEY) return true;   // 没设置就放行
  const need = kind === 'admin' ? ADMIN_KEY : GATEWAY_KEY;
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m && m[1] === need) return true;
  // 兼容 ?key=...
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.searchParams.get('key') === need) return true;
  return false;
}

// ─────────────────────────── 加载配置 ───────────────────────────
const CONFIG_PATH = process.env.ZZCSAPI_CONFIG || path.join(__dirname, 'config.json');
const EXAMPLE_PATH = path.join(__dirname, 'config.example.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    if (fs.existsSync(EXAMPLE_PATH)) {
      fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
      console.log(`[init] 已从 config.example.json 生成 ${CONFIG_PATH}，请填入真实渠道信息后重启`);
    } else {
      throw new Error(`配置文件不存在: ${CONFIG_PATH}`);
    }
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  if (!Array.isArray(cfg.channels) || cfg.channels.length === 0) {
    throw new Error('config.json 缺少 channels 数组');
  }
  for (const ch of cfg.channels) {
    if (!ch.id) ch.id = ch.name || `ch-${Math.random().toString(36).slice(2, 8)}`;
    if (!ch.baseUrl) throw new Error(`渠道 ${ch.id} 缺少 baseUrl`);
    if (!ch.apiKey) throw new Error(`渠道 ${ch.id} 缺少 apiKey`);
    if (ch.enabled === undefined) ch.enabled = true;
    if (ch.priority === undefined) ch.priority = 0;
    if (!ch.protocol) ch.protocol = 'openai'; // openai | anthropic | gemini
    if (ch.autoAlias === undefined) ch.autoAlias = true; // 探测到的模型自动可路由
    ch.models = ch.models || {};
  }
  return cfg;
}

const config = loadConfig();
const PORT = config.port || 8787;
const HEALTH = config.health || { intervalSec: 300, timeoutMs: 8000 };
const RETRIES = config.retries || { perChannel: 1, maxModelFallbacks: 99 };

// ─────────────────────────── 渠道运行时状态 ───────────────────────────
const channels = new Map();

function upsertChannel(def) {
  def.autoAlias = def.autoAlias !== false;
  const cur = channels.get(def.id);
  if (cur) {
    Object.assign(cur.def, def);
    cur.def.models = def.models || {};
    cur.def.protocol = def.protocol || cur.def.protocol || 'openai';
    cur.def.autoAlias = def.autoAlias;
    cur.aliasMap = buildAliasMap(def.models);
    return cur;
  }
  const state = {
    def,
    status: 'unknown',
    lastCheck: 0,
    latencyMs: -1,
    models: [],
    aliasMap: buildAliasMap(def.models),
    consecutiveFail: 0,
    cooldownUntil: 0,
    lastError: null,
  };
  channels.set(def.id, state);
  return state;
}

function buildAliasMap(models) {
  const m = new Map();
  for (const [alias, upstream] of Object.entries(models || {})) {
    m.set(alias.toLowerCase(), upstream);
  }
  return m;
}

for (const ch of config.channels) upsertChannel(ch);

// ─────────────────────────── 模型索引 ───────────────────────────
function channelsServing(model, protocol) {
  const want = String(model || '').toLowerCase().trim();
  if (!want) return [];
  const out = [];
  const hasAny = { explicit: false, auto: false, blind: false };
  for (const ch of channels.values()) {
    if (!ch.def.enabled) continue;
    const chProto = ch.def.protocol || 'openai';
    if (protocol && chProto !== protocol) continue;
    // 关闭 autoAlias 时跳过自动 alias
    const autoAlias = ch.def.autoAlias !== false;
    if (ch.aliasMap.has(want)) {
      hasAny.explicit = true;
      out.push({
        channelId: ch.def.id,
        upstream: ch.aliasMap.get(want),
        priority: ch.def.priority ?? 0,
        status: ch.status,
        latencyMs: ch.latencyMs,
        cooldownUntil: ch.cooldownUntil,
        consecutiveFail: ch.consecutiveFail,
        protocol: chProto,
        kind: 'explicit',
      });
    } else if (autoAlias && ch.models.includes(want)) {
      hasAny.auto = true;
      out.push({
        channelId: ch.def.id,
        upstream: want,
        priority: (ch.def.priority ?? 0) - 0.5,
        status: ch.status,
        latencyMs: ch.latencyMs,
        cooldownUntil: ch.cooldownUntil,
        consecutiveFail: ch.consecutiveFail,
        protocol: chProto,
        kind: 'auto',
      });
    }
  }
  // 冷启动兜底：上面都没命中，但有同协议、已启用、且从来没探测过的渠道
  // 仍把模型名当上游名尝试，priority 最低（-1e9），让前两类优先
  if (!hasAny.explicit && !hasAny.auto) {
    for (const ch of channels.values()) {
      if (!ch.def.enabled) continue;
      const chProto = ch.def.protocol || 'openai';
      if (protocol && chProto !== protocol) continue;
      const autoAlias = ch.def.autoAlias !== false;
      if (!autoAlias) continue;
      if (out.find((o) => o.channelId === ch.def.id)) continue;
      out.push({
        channelId: ch.def.id,
        upstream: want,
        priority: -1e9,
        status: ch.status,
        latencyMs: ch.latencyMs,
        cooldownUntil: ch.cooldownUntil,
        consecutiveFail: ch.consecutiveFail,
        protocol: chProto,
        kind: 'blind',
      });
      hasAny.blind = true;
    }
  }
  out.sort((a, b) => {
    const healthy = (c) => (c.cooldownUntil > Date.now() ? 2 : c.status === 'down' ? 1 : 0);
    const ha = healthy(a), hb = healthy(b);
    if (ha !== hb) return ha - hb;
    if (a.priority !== b.priority) return b.priority - a.priority;
    const la = a.latencyMs < 0 ? 1e9 : a.latencyMs;
    const lb = b.latencyMs < 0 ? 1e9 : b.latencyMs;
    return la - lb;
  });
  return out;
}

function aggregateModels(protocol) {
  const all = new Set();
  for (const ch of channels.values()) {
    const chProto = ch.def.protocol || 'openai';
    if (protocol && chProto !== protocol) continue;
    for (const alias of ch.aliasMap.keys()) all.add(alias);
    for (const m of ch.models) all.add(m);
  }
  return Array.from(all).sort();
}

// ─────────────────────────── 健康探测 ───────────────────────────
async function probeChannel(ch) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH.timeoutMs || 8000);
  const probeUrl = probeUrlFor(ch);
  try {
    const resp = await fetch(probeUrl, {
      method: probeMethodFor(ch),
      headers: probeHeadersFor(ch),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (!resp.ok) {
      ch.status = 'down';
      ch.consecutiveFail++;
      ch.lastError = `probe ${resp.status}`;
      ch.cooldownUntil = Date.now() + Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail));
      return;
    }
    const j = await resp.json().catch(() => null);
    const ids = extractModelIds(j, ch.def.protocol || 'openai');
    ch.models = ids;
    ch.latencyMs = ms;
    ch.lastCheck = Date.now();
    ch.consecutiveFail = 0;
    ch.cooldownUntil = 0;
    ch.lastError = null;
    ch.status = ids.length > 0 ? 'ok' : 'degraded';
  } catch (err) {
    clearTimeout(timer);
    ch.status = 'down';
    ch.consecutiveFail++;
    ch.lastError = String(err && err.message || err);
    ch.cooldownUntil = Date.now() + Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail));
  }
}

function probeUrlForDef(def) {
  const proto = def.protocol || 'openai';
  if (proto === 'anthropic') return joinUrl(def.baseUrl, 'v1/models');
  if (proto === 'gemini')    return joinUrl(def.baseUrl, 'v1beta/models');
  return joinUrl(def.baseUrl, 'models');
}
function probeHeadersForDef(def) {
  const proto = def.protocol || 'openai';
  if (proto === 'anthropic') return { 'x-api-key': def.apiKey, 'anthropic-version': '2023-06-01' };
  if (proto === 'gemini')    return { 'x-goog-api-key': def.apiKey };
  return { 'Authorization': `Bearer ${def.apiKey}` };
}
function extractModelIds(j, proto) {
  if (!j) return [];
  if (proto === 'anthropic') return Array.isArray(j.data) ? j.data.map((m) => m.id).filter(Boolean) : [];
  if (proto === 'gemini')    return Array.isArray(j.models) ? j.models.map((m) => (m.name || '').replace(/^models\//, '')).filter(Boolean) : [];
  return Array.isArray(j.data) ? j.data.map((m) => m.id).filter(Boolean) : [];
}

// 探测一个 def（不要求它是已注册的渠道），返回 {ok, models, latencyMs, status, error}
async function probeDef(def, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || HEALTH.timeoutMs || 8000);
  const t0 = Date.now();
  try {
    const resp = await fetch(probeUrlForDef(def), { method: 'GET', headers: probeHeadersForDef(def), signal: ctrl.signal });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: `HTTP ${resp.status}`, latencyMs: ms };
    }
    const j = await resp.json().catch(() => null);
    const models = extractModelIds(j, def.protocol || 'openai');
    return { ok: true, models, latencyMs: ms, status: 200 };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: String(err && err.message || err), latencyMs: Date.now() - t0 };
  }
}

// 兼容旧签名：仍以 ch 为参数
function probeUrlFor(ch) { return probeUrlForDef(ch.def); }
function probeMethodFor() { return 'GET'; }
function probeHeadersFor(ch) { return probeHeadersForDef(ch.def); }

async function probeAll() { await Promise.all(Array.from(channels.values()).map((ch) => probeChannel(ch))); }

if (HEALTH.intervalSec > 0) {
  probeAll().catch(() => {});
  setInterval(() => probeAll().catch(() => {}), HEALTH.intervalSec * 1000);
}

// ─────────────────────────── HTTP 工具 ───────────────────────────
function joinUrl(base, p) {
  const b = base.replace(/\/+$/, '');
  const s = p.replace(/^\/+/, '');
  return `${b}/${s}`;
}
function readBody(req) { return new Promise((resolve, reject) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); }); }
function sendJson(res, code, obj) { const body = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }); res.end(body); }
function unauthorized(res, kind) { sendJson(res, 401, { error: { message: `${kind} key required` } }); }
function upstreamErrorPayload(status, msg) { return { error: { message: msg, type: 'upstream_error', code: status } }; }
function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

// ─────────────────────────── Anthropic ↔ OpenAI 转换 ───────────────────────────
// 极简适配。功能：
//   Anthropic Request -> OpenAI Chat Request
//   OpenAI Chat Response -> Anthropic Response (non-stream)
//   OpenAI Chat Stream chunks -> Anthropic SSE events
function anthropicToOpenAI(body) {
  const out = {
    model: body.model,
    messages: [],
    max_tokens: body.max_tokens || 4096,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    stream: body.stream,
  };
  if (body.system) {
    const sys = Array.isArray(body.system)
      ? body.system.map((s) => s.text || '').join('\n')
      : String(body.system);
    out.messages.push({ role: 'system', content: sys });
  }
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') {
      out.messages.push({ role: m.role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const parts = [];
      for (const b of m.content) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') {
          // 简化：转成 OpenAI image_url 形式（仅支持 base64）
          parts.push({ type: 'image_url', image_url: { url: `data:${b.source?.media_type || 'image/png'};base64,${b.source?.data || ''}` } });
        }
      }
      out.messages.push({ role: m.role, content: parts });
    }
  }
  return out;
}

function openAIToAnthropicResponse(oai, modelAlias) {
  const choice = oai.choices && oai.choices[0];
  const text = choice ? (choice.message?.content || '') : '';
  return {
    id: oai.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: oai.model || modelAlias,
    content: [{ type: 'text', text }],
    stop_reason: choice ? mapFinishReason(choice.finish_reason) : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: oai.usage?.prompt_tokens || 0,
      output_tokens: oai.usage?.completion_tokens || 0,
    },
  };
}

function mapFinishReason(r) {
  switch (r) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'refusal';
    default: return 'end_turn';
  }
}

// 把 OpenAI 流式 chunk 转 Anthropic SSE
function* openAIStreamToAnthropicSSE(chunks, modelAlias) {
  let msgId = `msg_${Date.now()}`;
  yield { event: 'message_start', data: { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: modelAlias, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } } };
  let startedText = false;
  let finishReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  for (const c of chunks) {
    const choice = c.choices?.[0];
    const delta = choice?.delta?.content;
    if (delta) {
      if (!startedText) {
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } };
        startedText = true;
      }
      yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } } };
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (c.usage) usage = { input_tokens: c.usage.prompt_tokens || 0, output_tokens: c.usage.completion_tokens || 0 };
  }
  if (startedText) {
    yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } };
  }
  yield { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null }, usage } };
  yield { event: 'message_stop', data: { type: 'message_stop' } };
}

function sseEncode(eventName, data) {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ─────────────────────────── Gemini 转换 ───────────────────────────
function geminiToOpenAI(body, model) {
  const contents = body.contents || [];
  const messages = [];
  let sysText = body.systemInstruction?.parts?.map((p) => p.text).join('\n') || '';
  if (body.system_instruction?.parts) sysText = body.system_instruction.parts.map((p) => p.text).join('\n');
  if (sysText) messages.push({ role: 'system', content: sysText });
  for (const c of contents) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const text = (c.parts || []).map((p) => p.text || '').join('');
    if (text) messages.push({ role, content: text });
  }
  const gen = body.generationConfig || {};
  return {
    model,
    messages,
    max_tokens: gen.maxOutputTokens,
    temperature: gen.temperature,
    top_p: gen.topP,
    stream: !!body.stream,
  };
}

function openAIToGeminiResponse(oai) {
  const choice = oai.choices?.[0];
  const text = choice?.message?.content || '';
  return {
    candidates: [{
      content: { role: 'model', parts: [{ text }] },
      finishReason: choice?.finish_reason === 'length' ? 'MAX_TOKENS' : 'STOP',
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: oai.usage?.prompt_tokens || 0,
      candidatesTokenCount: oai.usage?.completion_tokens || 0,
      totalTokenCount: (oai.usage?.prompt_tokens || 0) + (oai.usage?.completion_tokens || 0),
    },
    modelVersion: oai.model,
  };
}

function openAIStreamToGeminiSSE(chunks) {
  const out = [];
  for (const c of chunks) {
    const choice = c.choices?.[0];
    const text = choice?.delta?.content || '';
    if (text) {
      out.push({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] });
    }
  }
  return out;
}

// ─────────────────────────── 路由 ───────────────────────────
const CONSOLE_HTML = loadConsoleHtml();

function loadConsoleHtml() {
  try {
    return fs.readFileSync(path.join(__dirname, 'console.html'), 'utf8');
  } catch {
    return '<!doctype html><meta charset="utf-8"><title>zzcsapi</title><p>console.html missing</p>';
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    // 控制台 HTML
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/console' || url.pathname === '/console/')) {
      if (!checkAuth(req, 'admin')) return unauthorized(res, 'admin');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(CONSOLE_HTML);
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, channels: channels.size, gatewayKey: !!GATEWAY_KEY, adminKey: !!ADMIN_KEY });
    }

    // 控制台 API（用 admin key 鉴权）
    if (url.pathname.startsWith('/admin/api/')) {
      if (!checkAuth(req, 'admin')) return unauthorized(res, 'admin');
      return handleAdminApi(req, res, url);
    }

    // 兼容旧的 admin 路径
    if (url.pathname === '/admin/status') {
      if (!checkAuth(req, 'admin')) return unauthorized(res, 'admin');
      return sendJson(res, 200, channelStatusAll());
    }
    if (req.method === 'POST' && url.pathname === '/admin/recheck') {
      if (!checkAuth(req, 'admin')) return unauthorized(res, 'admin');
      await probeAll();
      return sendJson(res, 200, { ok: true, checked: channels.size });
    }

    // OpenAI 兼容
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      if (!checkAuth(req, 'gateway')) return unauthorized(res, 'gateway');
      return sendJson(res, 200, { object: 'list', data: aggregateModels('openai').map((id) => ({ id, object: 'model', created: 0, owned_by: 'zzcsapi' })) });
    }
    if (req.method === 'POST' && (
      url.pathname === '/v1/chat/completions' ||
      url.pathname === '/v1/embeddings' ||
      url.pathname === '/v1/responses' ||
      url.pathname === '/v1/completions'
    )) {
      if (!checkAuth(req, 'gateway')) return unauthorized(res, 'gateway');
      return handleOpenAIRequest(req, res, url);
    }

    // Anthropic 兼容：/anthropic/v1/messages
    if (url.pathname.startsWith('/anthropic/')) {
      if (!checkAuth(req, 'gateway')) return unauthorized(res, 'gateway');
      return handleAnthropicRequest(req, res, url);
    }

    // Gemini 兼容：/gemini/v1beta/models/{model}:{action}
    if (url.pathname.startsWith('/gemini/')) {
      if (!checkAuth(req, 'gateway')) return unauthorized(res, 'gateway');
      return handleGeminiRequest(req, res, url);
    }

    return sendJson(res, 404, upstreamErrorPayload(404, 'not found'));
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendJson(res, 500, upstreamErrorPayload(500, String(err && err.message || err)));
  }
});

function channelStatusAll() {
  return {
    channels: Array.from(channels.values()).map((ch) => ({
      id: ch.def.id,
      name: ch.def.name || ch.def.id,
      baseUrl: ch.def.baseUrl,
      protocol: ch.def.protocol || 'openai',
      priority: ch.def.priority ?? 0,
      enabled: ch.def.enabled !== false,
      status: ch.status,
      lastCheck: ch.lastCheck,
      latencyMs: ch.latencyMs,
      consecutiveFail: ch.consecutiveFail,
      cooldownUntil: ch.cooldownUntil,
      lastError: ch.lastError,
      aliases: Array.from(ch.aliasMap.entries()).map(([a, u]) => ({ alias: a, upstream: u })),
      upstreamModels: ch.models,
    })),
    aggregated: {
      openai: aggregateModels('openai'),
      anthropic: aggregateModels('anthropic'),
      gemini: aggregateModels('gemini'),
    },
  };
}

// 持久化到 config.json（写之前备份到 config.bak.json）
function persistConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return;
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
  } catch (e) { /* ignore */ }
  const out = {
    port: config.port,
    health: config.health,
    retries: config.retries,
    channels: Array.from(channels.values()).map((ch) => ({
      id: ch.def.id,
      name: ch.def.name,
      baseUrl: ch.def.baseUrl,
      apiKey: ch.def.apiKey,
      protocol: ch.def.protocol || 'openai',
      priority: ch.def.priority ?? 0,
      enabled: ch.def.enabled !== false,
      autoAlias: ch.def.autoAlias !== false,
      models: ch.def.models || {},
    })),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

function validateChannelDef(def) {
  if (!def || typeof def !== 'object') return 'body must be an object';
  if (!def.id || !/^[a-zA-Z0-9_\-]+$/.test(def.id)) return 'id is required and must be [a-zA-Z0-9_-]+';
  if (!def.baseUrl || typeof def.baseUrl !== 'string') return 'baseUrl is required';
  if (!def.apiKey || typeof def.apiKey !== 'string') return 'apiKey is required';
  if (def.protocol && !['openai', 'anthropic', 'gemini'].includes(def.protocol)) return 'protocol must be openai|anthropic|gemini';
  if (def.models && typeof def.models !== 'object') return 'models must be an object {alias: upstream}';
  return null;
}

async function handleAdminApi(req, res, url) {
  // /admin/api/status        GET   渠道状态
  // /admin/api/recheck       POST  立即重探测（body 可选 {id}）
  // /admin/api/channel       POST  改 priority/enabled（不持久化的轻量操作）
  // /admin/api/channels      POST  完整 upsert（持久化到 config.json）
  // /admin/api/channels      DELETE {id}  删除
  // /admin/api/channels      GET   列表
  if (req.method === 'GET' && url.pathname === '/admin/api/status') {
    return sendJson(res, 200, channelStatusAll());
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/recheck') {
    const body = await safeReadJson(req);
    if (body && body.id) {
      const ch = channels.get(body.id);
      if (!ch) return sendJson(res, 404, { error: 'channel not found' });
      await probeChannel(ch);
      return sendJson(res, 200, { ok: true, id: body.id, status: ch.status, latencyMs: ch.latencyMs });
    }
    await probeAll();
    return sendJson(res, 200, { ok: true, checked: channels.size });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/channel') {
    const body = await safeReadJson(req);
    if (!body || !body.id) return sendJson(res, 400, { error: 'missing id' });
    const ch = channels.get(body.id);
    if (!ch) return sendJson(res, 404, { error: 'channel not found' });
    if (body.priority !== undefined) ch.def.priority = Number(body.priority);
    if (body.enabled !== undefined) ch.def.enabled = !!body.enabled;
    return sendJson(res, 200, { ok: true, id: body.id, priority: ch.def.priority, enabled: ch.def.enabled });
  }

  // 完整 CRUD：channels 集合
  if (req.method === 'GET' && url.pathname === '/admin/api/channels') {
    return sendJson(res, 200, { channels: Array.from(channels.values()).map((ch) => ({
      id: ch.def.id,
      name: ch.def.name,
      baseUrl: ch.def.baseUrl,
      apiKey: ch.def.apiKey,
      protocol: ch.def.protocol || 'openai',
      priority: ch.def.priority ?? 0,
      enabled: ch.def.enabled !== false,
      autoAlias: ch.def.autoAlias !== false,
      models: ch.def.models || {},
    })) });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/channels') {
    const body = await safeReadJson(req);
    const err = validateChannelDef(body);
    if (err) return sendJson(res, 400, { error: err });
    const def = {
      id: body.id,
      name: body.name || body.id,
      baseUrl: body.baseUrl.replace(/\/+$/, ''),
      apiKey: body.apiKey,
      protocol: body.protocol || 'openai',
      priority: body.priority !== undefined ? Number(body.priority) : 0,
      enabled: body.enabled !== false,
      autoAlias: body.autoAlias !== false,
      models: body.models || {},
    };
    const existed = channels.has(def.id);
    const ch = upsertChannel(def);
    persistConfig();
    // 立即探测一次，便于前端立刻显示健康状态
    probeChannel(ch).catch(() => {});
    return sendJson(res, 200, { ok: true, id: def.id, existed, channel: { id: def.id, name: def.name, baseUrl: def.baseUrl, protocol: def.protocol, priority: def.priority, enabled: def.enabled, autoAlias: def.autoAlias, models: def.models } });
  }
  // 临时探测（不落库），用于「获取模型」按钮
  if (req.method === 'POST' && url.pathname === '/admin/api/probe') {
    const body = await safeReadJson(req);
    if (!body || !body.baseUrl || !body.apiKey) return sendJson(res, 400, { error: 'baseUrl & apiKey required' });
    const def = {
      baseUrl: String(body.baseUrl).replace(/\/+$/, ''),
      apiKey: String(body.apiKey),
      protocol: ['openai', 'anthropic', 'gemini'].includes(body.protocol) ? body.protocol : 'openai',
    };
    const r = await probeDef(def, Math.min(15000, Number(body.timeoutMs) || 10000));
    return sendJson(res, 200, r);
  }
  if (req.method === 'DELETE' && url.pathname === '/admin/api/channels') {
    const body = await safeReadJson(req);
    if (!body || !body.id) return sendJson(res, 400, { error: 'missing id' });
    if (!channels.has(body.id)) return sendJson(res, 404, { error: 'channel not found' });
    channels.delete(body.id);
    persistConfig();
    return sendJson(res, 200, { ok: true, id: body.id });
  }

  return sendJson(res, 404, { error: 'unknown admin api' });
}

async function safeReadJson(req) {
  try {
    const buf = await readBody(req);
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch { return null; }
}

// ─────────────────────────── OpenAI 调度 ───────────────────────────
async function handleOpenAIRequest(req, res, url) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return sendJson(res, 400, upstreamErrorPayload(400, 'invalid JSON body')); }
  const requested = body.model;
  if (!requested) return sendJson(res, 400, upstreamErrorPayload(400, 'missing model'));
  const candidates = channelsServing(requested, 'openai');
  if (candidates.length === 0) {
    return sendJson(res, 404, upstreamErrorPayload(404, `no openai channel for model "${requested}"`));
  }
  return dispatchRequest({
    kind: 'openai',
    res,
    url,
    body,
    candidates,
    encodeOutgoing: (b, c) => ({ ...b, model: c.upstream }),
    buildOutgoingUrl: (ch) => joinUrl(ch.def.baseUrl, url.pathname.replace(/^\/v1\//, '')),
    buildOutgoingHeaders: (ch) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.def.apiKey}` }),
    onSuccessNonStream: async (oai, candidate) => {
      const text = await oai.text();
      res.writeHead(200, { 'Content-Type': oai.headers.get('content-type') || 'application/json', 'X-ZZCSAPI-Channel': candidate.channelId });
      res.end(text);
    },
  });
}

// ─────────────────────────── Anthropic 调度 ───────────────────────────
async function handleAnthropicRequest(req, res, url) {
  // /anthropic/v1/messages  -> 去掉 /anthropic 前缀
  const inner = url.pathname.replace(/^\/anthropic/, '');
  if (req.method === 'GET' && inner === '/v1/models') {
    return sendJson(res, 200, { data: aggregateModels('anthropic').map((id) => ({ id, type: 'model' })) });
  }
  if (req.method === 'POST' && inner === '/v1/messages') {
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw.toString('utf8') || '{}'); }
    catch { return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }); }
    const requested = body.model;
    if (!requested) return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'missing model' } });
    const candidates = channelsServing(requested, 'anthropic');
    if (candidates.length === 0) {
      return sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `no anthropic channel for model "${requested}"` } });
    }
    const isStream = !!body.stream;
    const oaiBody = anthropicToOpenAI(body);
    return dispatchRequest({
      kind: 'anthropic',
      res,
      url: { ...url, pathname: '/v1/chat/completions' }, // 复用 OpenAI 上游路径
      body: oaiBody,
      candidates,
      isStream,
      encodeOutgoing: (b, c) => ({ ...b, model: c.upstream }),
      buildOutgoingUrl: (ch) => joinUrl(ch.def.baseUrl, 'chat/completions'),
      buildOutgoingHeaders: (ch) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.def.apiKey}` }),
      onSuccessNonStream: async (oai, candidate) => {
        const oaiBody = await oai.json();
        const ant = openAIToAnthropicResponse(oaiBody, requested);
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-ZZCSAPI-Channel': candidate.channelId });
        res.end(JSON.stringify(ant));
      },
      onStreamChunk: (oaiChunk, candidate) => {
        // oaiChunk 是 OpenAI SSE 的一行（data: {...}）
        const line = oaiChunk.trim();
        if (!line.startsWith('data:')) return null;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          return sseEncode('message_stop', { type: 'message_stop' });
        }
        try {
          const j = JSON.parse(data);
          // 解析为单 chunk 然后转 SSE
          const fakeChunks = [j];
          let out = '';
          for (const ev of openAIStreamToAnthropicSSE(fakeChunks, requested)) {
            out += sseEncode(ev.event, ev.data);
          }
          return out;
        } catch {
          return null;
        }
      },
      streamPrelude: () => '',
    });
  }
  return sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
}

// ─────────────────────────── Gemini 调度 ───────────────────────────
async function handleGeminiRequest(req, res, url) {
  // /gemini/v1beta/models/{model}:{action}  ->  去掉 /gemini 前缀
  const inner = url.pathname.replace(/^\/gemini/, '');
  const m = inner.match(/^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/);
  if (!m) return sendJson(res, 404, { error: { code: 404, message: 'unsupported path' } });
  const model = decodeURIComponent(m[1]);
  const action = m[2];
  const isStream = action === 'streamGenerateContent';

  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return sendJson(res, 400, { error: { code: 400, message: 'invalid JSON' } }); }

  const candidates = channelsServing(model, 'gemini');
  if (candidates.length === 0) {
    return sendJson(res, 404, { error: { code: 404, message: `no gemini channel for model "${model}"`, status: 'NOT_FOUND' } });
  }

  const oaiBody = geminiToOpenAI(body, model);
  return dispatchRequest({
    kind: 'gemini',
    res,
    url: { ...url, pathname: '/v1/chat/completions' },
    body: oaiBody,
    candidates,
    isStream,
    encodeOutgoing: (b, c) => ({ ...b, model: c.upstream }),
    buildOutgoingUrl: (ch) => joinUrl(ch.def.baseUrl, 'chat/completions'),
    buildOutgoingHeaders: (ch) => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.def.apiKey}` }),
    onSuccessNonStream: async (oai, candidate) => {
      const oaiBody = await oai.json();
      const gem = openAIToGeminiResponse(oaiBody);
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-ZZCSAPI-Channel': candidate.channelId });
      res.end(JSON.stringify(gem));
    },
    onStreamChunk: (line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return null;
      const data = t.slice(5).trim();
      if (data === '[DONE]') return null;
      try {
        const j = JSON.parse(data);
        const gems = openAIStreamToGeminiSSE([j]);
        return gems.map((g) => `data: ${JSON.stringify(g)}\n\n`).join('');
      } catch { return null; }
    },
  });
}

// ─────────────────────────── 调度核心（统一） ───────────────────────────
async function dispatchRequest(opts) {
  const { res, url, body, candidates, isStream, encodeOutgoing, buildOutgoingUrl, buildOutgoingHeaders, onSuccessNonStream, onStreamChunk } = opts;
  const errors = [];
  let attemptedAny = false;
  const stream = !!isStream;

  for (let i = 0; i < Math.min(candidates.length, RETRIES.maxModelFallbacks || 99); i++) {
    const c = candidates[i];
    if (c.cooldownUntil > Date.now()) {
      errors.push({ ch: c.channelId, err: 'in cooldown' });
      continue;
    }
    attemptedAny = true;
    const result = await tryChannel({
      res, url, body, candidate: c, isStream: stream,
      encodeOutgoing, buildOutgoingUrl, buildOutgoingHeaders, onSuccessNonStream, onStreamChunk,
    });
    if (result === 'success') return;
    if (result === 'fatal_client') return;
    errors.push({ ch: c.channelId, err: result });
  }
  if (!attemptedAny) return sendJson(res, 503, upstreamErrorPayload(503, 'all channels in cooldown'));
  return sendJson(res, 502, { error: { message: `all channels failed`, type: 'gateway_error', attempts: errors } });
}

async function tryChannel(opts) {
  const { res, url, body, candidate, isStream, encodeOutgoing, buildOutgoingUrl, buildOutgoingHeaders, onSuccessNonStream, onStreamChunk } = opts;
  const ch = channels.get(candidate.channelId);
  const outgoing = encodeOutgoing(body, candidate);
  const target = buildOutgoingUrl(ch);
  const headers = buildOutgoingHeaders(ch);

  const t0 = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), (ch.def.timeoutMs || 120_000));
  let resp;
  try {
    resp = await fetch(target, { method: 'POST', headers, body: JSON.stringify(outgoing), signal: ctrl.signal });
  } catch (err) {
    clearTimeout(to);
    recordFailure(ch, String(err && err.message || err));
    return `network: ${err.message || err}`;
  }
  clearTimeout(to);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    recordFailure(ch, `HTTP ${resp.status}: ${text.slice(0, 200)}`);
    if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
      // 客户端错误：直接把上游响应转发
      const ct = resp.headers.get('content-type') || '';
      res.writeHead(resp.status, { 'Content-Type': ct || 'application/json' });
      res.end(text);
      return 'fatal_client';
    }
    return `upstream ${resp.status}`;
  }

  // 成功
  ch.consecutiveFail = 0;
  ch.cooldownUntil = 0;
  ch.lastError = null;
  if (ch.status === 'down' || ch.status === 'unknown') ch.status = 'ok';
  ch.latencyMs = Date.now() - t0;

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': resp.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-ZZCSAPI-Channel': candidate.channelId,
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (onStreamChunk) {
            const out = onStreamChunk(line + '\n', candidate);
            if (out) res.write(out);
          } else {
            res.write(line + '\n');
          }
        }
      }
      // 收尾
      if (buf.length && onStreamChunk) {
        const out = onStreamChunk(buf + '\n', candidate);
        if (out) res.write(out);
      }
    } catch (err) { /* 上游已断 */ }
    res.end();
    return 'success';
  } else {
    return onSuccessNonStream(resp, candidate);
  }
}

function recordFailure(ch, msg) {
  ch.consecutiveFail++;
  ch.lastError = msg;
  ch.cooldownUntil = Date.now() + Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail));
  if (ch.consecutiveFail >= 3) ch.status = 'down';
}

// ─────────────────────────── 启动 ───────────────────────────
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[zzcsapi] listening on http://127.0.0.1:${PORT}`);
  console.log(`[zzcsapi] auth: gateway=${GATEWAY_KEY ? 'on' : 'off'} admin=${ADMIN_KEY ? 'on' : 'off'}`);
  console.log(`[zzcsapi] channels: ${Array.from(channels.values()).map((c) => `${c.def.id}/${c.def.protocol}(${c.aliasMap.size})`).join(', ')}`);
  console.log(`[zzcsapi] aggregated: openai=[${aggregateModels('openai').join(', ')}] anthropic=[${aggregateModels('anthropic').join(', ')}] gemini=[${aggregateModels('gemini').join(', ')}]`);
});

process.on('SIGINT', () => { console.log('\n[zzcsapi] bye'); process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });
