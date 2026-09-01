// ZZCSAPI - 轻量级本地 OpenAI 兼容聚合网关
// 用法：  1) node server.js                        （用 ./config.json）
//        2) DSH 模型地址填 http://127.0.0.1:8787/v1
// 目标：多渠道 API key 统一调度，失败自动切换，全失败才报错
// 依赖：仅 Node 18+ 自带 fetch / ReadableStream / setTimeout
//
// 配置字段：见 config.example.json

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

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
    ch.models = ch.models || {}; // alias -> upstream
  }
  return cfg;
}

const config = loadConfig();
const PORT = config.port || 8787;
const HEALTH = config.health || { intervalSec: 300, timeoutMs: 8000 };
const RETRIES = config.retries || { perChannel: 1, maxModelFallbacks: 99 };

// ─────────────────────────── 渠道运行时状态 ───────────────────────────
const channels = new Map(); // id -> {def, status, lastCheck, latencyMs, models, consecutiveFail, cooldownUntil, lastError}

function upsertChannel(def) {
  const cur = channels.get(def.id);
  if (cur) {
    Object.assign(cur.def, def);
    cur.def.models = def.models || {};
    return cur;
  }
  const state = {
    def,
    status: 'unknown',         // 'ok' | 'degraded' | 'down' | 'unknown'
    lastCheck: 0,
    latencyMs: -1,
    models: [],                 // 探测到的真实模型 id 列表
    aliasMap: buildAliasMap(def.models),
    consecutiveFail: 0,
    cooldownUntil: 0,
    lastError: null,
  };
  channels.set(def.id, state);
  return state;
}

function buildAliasMap(models) {
  // alias（用户面向）-> upstream name
  const m = new Map();
  for (const [alias, upstream] of Object.entries(models || {})) {
    m.set(alias.toLowerCase(), upstream);
  }
  return m;
}

for (const ch of config.channels) upsertChannel(ch);

// ─────────────────────────── 模型索引 ───────────────────────────
// 用户请求模型 -> [{channelId, alias, upstream, priority, status, ...}]
function channelsServing(model) {
  const want = String(model || '').toLowerCase().trim();
  if (!want) return [];
  const out = [];
  for (const ch of channels.values()) {
    if (!ch.def.enabled) continue;
    if (ch.aliasMap.has(want)) {
      out.push({
        channelId: ch.def.id,
        upstream: ch.aliasMap.get(want),
        priority: ch.def.priority ?? 0,
        status: ch.status,
        latencyMs: ch.latencyMs,
        cooldownUntil: ch.cooldownUntil,
        consecutiveFail: ch.consecutiveFail,
      });
    } else if (ch.models.includes(want)) {
      // 渠道探测到该模型但用户未在 models 显式映射——仍允许，但优先级低
      out.push({
        channelId: ch.def.id,
        upstream: want,
        priority: (ch.def.priority ?? 0) - 0.5,
        status: ch.status,
        latencyMs: ch.latencyMs,
        cooldownUntil: ch.cooldownUntil,
        consecutiveFail: ch.consecutiveFail,
      });
    }
  }
  // 排序：可用 > 未知；冷却中排最后；同状态按优先级 > 延迟
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

// 全局聚合模型清单
function aggregateModels() {
  const all = new Set();
  for (const ch of channels.values()) {
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
  try {
    const url = joinUrl(ch.def.baseUrl, 'models');
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${ch.def.apiKey}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (!resp.ok) {
      ch.status = 'down';
      ch.consecutiveFail++;
      ch.lastError = `models ${resp.status}`;
      ch.cooldownUntil = Date.now() + Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail));
      return;
    }
    const j = await resp.json().catch(() => null);
    const ids = (j && Array.isArray(j.data)) ? j.data.map((m) => m.id).filter(Boolean) : [];
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

async function probeAll() {
  await Promise.all(Array.from(channels.values()).map((ch) => probeChannel(ch)));
}

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function upstreamErrorPayload(status, msg) {
  // 兼容 OpenAI / Anthropic 错误体
  return { error: { message: msg, type: 'upstream_error', code: status } };
}

// ─────────────────────────── 路由 ───────────────────────────
//
// GET  /v1/models                              聚合模型清单
// POST /v1/chat/completions                    自动调度 chat（流式 + 非流式）
// POST /v1/embeddings                          透传
// POST /v1/responses                           透传
// GET  /healthz                                网关自身健康
// GET  /admin/status                           渠道状态（无需鉴权：仅监听 127.0.0.1）

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    // —— /healthz
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, channels: channels.size });
    }

    // —— /v1/models
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const now = Date.now();
      return sendJson(res, 200, {
        object: 'list',
        data: aggregateModels().map((id) => ({ id, object: 'model', created: 0, owned_by: 'zzcsapi' })),
        _zzcsapi: {
          generatedAt: now,
          channels: Array.from(channels.values()).map((ch) => ({
            id: ch.def.id,
            name: ch.def.name || ch.def.id,
            status: ch.status,
            latencyMs: ch.latencyMs,
            consecutiveFail: ch.consecutiveFail,
            aliasCount: ch.aliasMap.size,
            upstreamModelCount: ch.models.length,
            lastError: ch.lastError,
          })),
        },
      });
    }

    // —— chat / embed / responses
    if (req.method === 'POST' && (
      url.pathname === '/v1/chat/completions' ||
      url.pathname === '/v1/embeddings' ||
      url.pathname === '/v1/responses' ||
      url.pathname === '/v1/completions'
    )) {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw.toString('utf8') || '{}'); }
      catch { return sendJson(res, 400, upstreamErrorPayload(400, 'invalid JSON body')); }

      const requested = body.model;
      if (!requested) return sendJson(res, 400, upstreamErrorPayload(400, 'missing model'));

      const candidates = channelsServing(requested);
      if (candidates.length === 0) {
        return sendJson(res, 404, upstreamErrorPayload(404, `no channel configured for model "${requested}"`));
      }

      return dispatchRequest(req, res, url, body, candidates);
    }

    // —— admin
    if (url.pathname === '/admin/status') {
      return sendJson(res, 200, {
        channels: Array.from(channels.values()).map((ch) => ({
          id: ch.def.id,
          name: ch.def.name || ch.def.id,
          baseUrl: ch.def.baseUrl,
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
        aggregated: aggregateModels(),
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/recheck') {
      await probeAll();
      return sendJson(res, 200, { ok: true, checked: channels.size });
    }

    return sendJson(res, 404, upstreamErrorPayload(404, 'not found'));
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendJson(res, 500, upstreamErrorPayload(500, String(err && err.message || err)));
  }
});

// ─────────────────────────── 调度核心 ───────────────────────────
async function dispatchRequest(req, res, url, body, candidates) {
  const isStream = !!body.stream;
  const errors = [];
  let attemptedAny = false;

  for (let i = 0; i < Math.min(candidates.length, RETRIES.maxModelFallbacks || 99); i++) {
    const c = candidates[i];
    if (c.cooldownUntil > Date.now()) {
      errors.push({ ch: c.channelId, err: 'in cooldown' });
      continue;
    }
    attemptedAny = true;
    const result = await tryChannel(req, res, url, body, c, isStream);
    if (result === 'success') return;
    if (result === 'fatal_client') return; // 4xx 类（参数错）不重试
    errors.push({ ch: c.channelId, err: result });
  }

  if (!attemptedAny) {
    return sendJson(res, 503, upstreamErrorPayload(503, 'all channels in cooldown'));
  }
  return sendJson(res, 502, {
    error: {
      message: `all channels failed for model "${body.model}"`,
      type: 'gateway_error',
      attempts: errors,
    },
  });
}

async function tryChannel(req, res, url, body, candidate, isStream) {
  const ch = channels.get(candidate.channelId);
  const upstream = { ...body, model: candidate.upstream };
  const target = joinUrl(ch.def.baseUrl, url.pathname.replace(/^\/v1\//, ''));
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${ch.def.apiKey}`,
  };
  if (req.headers['accept']) headers['Accept'] = req.headers['accept'];

  const t0 = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), (ch.def.timeoutMs || 120_000));
  let resp;
  try {
    resp = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstream),
      signal: ctrl.signal,
    });
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
      // 4xx 客户端问题：模型名错、参数错 — 不要再重试别的渠道
      sendJson(res, resp.status, safeJson(text) || upstreamErrorPayload(resp.status, text));
      return 'fatal_client';
    }
    return `upstream ${resp.status}`;
  }

  // 成功 —— 记录指标
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
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          await new Promise((r) => res.once('drain', r));
        }
      }
    } catch (err) {
      // 上游断开 —— 此时已经返回 200，无法再换渠道
    }
    res.end();
    return 'success';
  } else {
    const text = await resp.text();
    res.writeHead(200, {
      'Content-Type': resp.headers.get('content-type') || 'application/json',
      'X-ZZCSAPI-Channel': candidate.channelId,
    });
    res.end(text);
    return 'success';
  }
}

function recordFailure(ch, msg) {
  ch.consecutiveFail++;
  ch.lastError = msg;
  ch.cooldownUntil = Date.now() + Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail));
  if (ch.consecutiveFail >= 3) ch.status = 'down';
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ─────────────────────────── 启动 ───────────────────────────
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[zzcsapi] listening on http://127.0.0.1:${PORT}`);
  console.log(`[zzcsapi] channels: ${Array.from(channels.values()).map((c) => `${c.def.id}(${c.aliasMap.size})`).join(', ')}`);
  console.log(`[zzcsapi] aggregated models: ${aggregateModels().join(', ') || '(empty, 等待健康探测)'}`);
});

process.on('SIGINT', () => { console.log('\n[zzcsapi] bye'); process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });
