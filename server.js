// ZZCSAPI - 本地多渠道 OpenAI / Anthropic / Gemini 兼容聚合网关
// 用法：  1) node server.js                        （用 ./config.json）
//        2) DSH 模型地址填 http://127.0.0.1:8787/v1
// 目标：多渠道 API key 统一调度，失败自动切换，全失败才报错
// 依赖：仅 Node 18+ 自带 fetch / ReadableStream / setTimeout

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { URL } = require('url');
const notion = require('./notion.js');

// 检测响应是否 Cloudflare WAF 拦截（JA3/TLS 指纹被识别为机器人）
function isCloudflareBlock(status, body) {
  if (status === 403 && body && body.length > 100 && /cloudflare|cf-wrapper|attention required/i.test(body.slice(0, 800))) return true;
  if (status === 403 && body && /<html/i.test(body.slice(0, 500))) return true;
  return false;
}

// 通过外部进程发起请求，绕过 Cloudflare JA3 拦截：
//  - Windows: PowerShell (Invoke-WebRequest) → .NET Schannel TLS
//  - Linux/macOS: curl → 系统 OpenSSL TLS
// 返回 {status, headers, body, error}
function psHttpRequest(method, url, headers, body, timeoutMs) {
  if (process.platform === 'win32') return psHttpRequestWin(method, url, headers, body, timeoutMs);
  return curlHttpRequest(method, url, headers, body, timeoutMs);
}

// curl 版（Linux/macOS Docker 环境）
// 用 -w '\n__HTTPCODE__%{http_code}' 输出状态码到 stdout 末尾；body 走 stdout。
function curlHttpRequest(method, url, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    const args = ['-sS', '-X', String(method).toUpperCase(), '--max-time', String(Math.max(1, Math.floor((timeoutMs || 30000) / 1000)))];
    // 模拟浏览器指纹 + 常见头，尽量绕过 WAF
    args.push('-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    args.push('-H', 'Accept: application/json, text/plain, */*');
    args.push('-H', 'Accept-Language: en-US,en;q=0.5');
    args.push('--compressed');
    for (const [k, v] of Object.entries(headers || {})) {
      args.push('-H', `${k}: ${v}`);
    }
    if (body) args.push('--data-raw', String(body));
    args.push('-w', '\n__ZZCODE__%{http_code}');
    args.push(String(url));
    const child = spawn('curl', args, { windowsHide: true });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ status: 0, headers: {}, body: '', error: 'curl timeout' }); }, (timeoutMs || 30000) + 5000);
    child.stdout.on('data', (c) => { stdout = Buffer.concat([stdout, c]); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('close', () => {
      clearTimeout(timer);
      const text = stdout.toString('utf8');
      const m = text.match(/__ZZCODE__(\d+)\s*$/);
      if (!m) { resolve({ status: 0, headers: {}, body: text, error: stderr ? stderr.slice(0, 300) : 'curl parse fail' }); return; }
      const body = text.slice(0, text.lastIndexOf('__ZZCODE__')).replace(/\n$/, '');
      resolve({ status: Number(m[1]), headers: {}, body, error: null });
    });
    child.on('error', (err) => { clearTimeout(timer); resolve({ status: 0, headers: {}, body: '', error: 'curl spawn: ' + err.message }); });
  });
}

// Notion 专用 curl 请求（完整 headers 原样传递，body 走临时文件避免命令行长度/转义问题）
// 背景：Notion 推理接口对 undici(OpenSSL) TLS 指纹返回 soft-error（temporarily-unavailable），
//       Windows curl.exe(Schannel) / Linux curl 实测可过。
// 返回 {status, body, error}；status>0 且 body 非空时为成功响应
function notionCurlRequest(method, url, headers, bodyStr, timeoutMs) {
  return new Promise((resolve) => {
    const os = require('os');
    const fsSync = require('fs');
    const pathSync = require('path');
    const bodyFile = pathSync.join(os.tmpdir(), `zznotion_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    let written = false;
    try { fsSync.writeFileSync(bodyFile, bodyStr || '', 'utf8'); written = true; } catch {}
    const args = ['-sS', '-X', String(method).toUpperCase(), '--max-time', String(Math.max(1, Math.floor((timeoutMs || 120000) / 1000)))];
    for (const [k, v] of Object.entries(headers || {})) args.push('-H', `${k}: ${v}`);
    if (written) args.push('--data', '@' + bodyFile);
    args.push(String(url));
    const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      if (written) try { fsSync.unlinkSync(bodyFile); } catch {}
      resolve({ status: 0, body: '', error: 'curl timeout' });
    }, (timeoutMs || 120000) + 5000);
    child.stdout.on('data', (c) => { stdout = Buffer.concat([stdout, c]); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (written) try { fsSync.unlinkSync(bodyFile); } catch {}
      if (code !== 0) { resolve({ status: 0, body: stdout.toString('utf8'), error: `curl exit ${code}: ${stderr.slice(0, 200)}` }); return; }
      resolve({ status: 200, body: stdout.toString('utf8'), error: null });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (written) try { fsSync.unlinkSync(bodyFile); } catch {}
      resolve({ status: 0, body: '', error: 'curl spawn: ' + err.message });
    });
  });
}

// PowerShell 版（Windows）— 用 .NET Schannel/TLS
function psHttpRequestWin(method, url, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    // 构造 PowerShell 命令 — headers 必须是 hashtable
    const hdrsPs = Object.entries(headers || {}).map(([k, v]) => {
      const k2 = String(k).replace(/'/g, "''");
      const v2 = String(v).replace(/'/g, "''");
      return `'${k2}' = '${v2}'`;
    }).join(';\n');
    const bodyArg = body ? ` -Body @'\n${body}\n'@` : '';
    const ps = `
$ErrorActionPreference = 'Stop'
try {
  $hdrs = @{
${hdrsPs}
  }
  $r = Invoke-WebRequest -Uri '${String(url).replace(/'/g, "''")}' -Method '${method}' -Headers $hdrs -TimeoutSec ${Math.max(1, Math.floor((timeoutMs || 30000) / 1000))} -UseBasicParsing${bodyArg}
  $bytes = $r.RawContentStream.ToArray()
  Write-Output ('STATUS=' + [int]$r.StatusCode)
  foreach ($h in $r.Headers.GetEnumerator()) {
    foreach ($v in $h.Value) { Write-Output ('HDR=' + $h.Key + ': ' + $v) }
  }
  Write-Output '---BODY---'
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
  [Console]::Out.Flush()
} catch {
  $r2 = $_.Exception.Response
  if ($r2) {
    Write-Output ('STATUS=' + [int]$r2.StatusCode)
    $s = $r2.GetResponseStream()
    $sr = New-Object System.IO.StreamReader($s)
    Write-Output '---BODY---'
    Write-Output $sr.ReadToEnd()
  } else {
    Write-Output ('STATUS=0')
    Write-Output '---BODY---'
    Write-Output $_.Exception.Message
  }
}
`;
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ status: 0, headers: {}, body: '', error: 'ps timeout' }); }, (timeoutMs || 30000) + 5000);
    child.stdout.on('data', (c) => { stdout = Buffer.concat([stdout, c]); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = stdout.toString('utf8');
      const m = text.match(/^STATUS=(\d+)\r?\n([\s\S]*?)^---BODY---\r?\n?([\s\S]*)$/m);
      if (!m) {
        resolve({ status: 0, headers: {}, body: '', error: 'ps parse fail: ' + (stderr || text.slice(0, 200)) });
        return;
      }
      const status = Number(m[1]);
      const hdrLines = m[2].split(/\r?\n/).filter((l) => l.startsWith('HDR='));
      const headersOut = {};
      for (const l of hdrLines) {
        const kv = l.slice(4).split(': ');
        const k = kv[0].toLowerCase();
        if (!headersOut[k]) headersOut[k] = [];
        headersOut[k].push(kv.slice(1).join(': '));
      }
      // body 解析：m[3] 是从 ---BODY--- 之后到结尾的内容，stdout 末尾可能没换行符，所以是完整 buffer
      const bodyStart = text.indexOf('---BODY---') + '---BODY---'.length;
      const body = text.slice(bodyStart).replace(/^\r?\n/, '');
      resolve({ status, headers: headersOut, body, error: null });
    });
    child.on('error', (err) => { clearTimeout(timer); resolve({ status: 0, headers: {}, body: '', error: 'ps spawn: ' + err.message }); });
  });
}

// ─────────────────────────── 鉴权 ───────────────────────────
const GATEWAY_KEY = process.env.GATEWAY_KEY || ''; // 客户端调 /v1/* / /anthropic/* / /gemini/*
const ADMIN_KEY   = process.env.ADMIN_KEY   || ''; // 调 /admin/* + Web 控制台
const NOAUTH = process.env.ZZCSAPI_NOAUTH === '1';  // 本地开发：完全关闭鉴权
function checkAuth(req, kind) {
  // kind: 'gateway' | 'admin'
  if (NOAUTH) return true;                            // 本地免鉴权
  if (kind === 'admin' && !ADMIN_KEY) return true;    // 没设置就放行（仅本机）
  if (kind === 'gateway' && !GATEWAY_KEY) return true; // 没设置就放行
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
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
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
    if (ch.autoAlias === undefined) ch.autoAlias = false; // 探测到的模型自动可路由（默认关闭，按需开启）
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
  def.autoAlias = !!def.autoAlias;
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
    // 显式 alias 始终可路由
    for (const alias of ch.aliasMap.keys()) all.add(alias);
    // 探测到的真模型仅在 autoAlias 时算可路由
    if (ch.def.autoAlias === true) {
      for (const m of ch.models) all.add(m);
    }
  }
  return Array.from(all).sort();
}

// ─────────────────────────── 健康探测 ───────────────────────────
async function probeChannel(ch) {
  // Notion 渠道：getSpaces 验证（成功即 ok，刷新凭据缓存）
  if ((ch.def.protocol || 'openai') === 'notion') {
    const t0 = Date.now();
    try {
      const acct = await notion.notionDiscoverAccount(ch.def.baseUrl, ch.def.apiKey, fetch, HEALTH.timeoutMs || 15000);
      const first = acct.spaces[0];
      ch.notion = { userId: acct.userId, spaceId: first.spaceId, spaceViewId: first.spaceViewId || '', userName: acct.userName, userEmail: acct.userEmail, spaces: acct.spaces, at: Date.now() };
      try {
        const u = await notion.notionUsageEligibility(ch.def.baseUrl, ch.def.apiKey, acct, fetch, 10000);
        ch.notion.usage = { type: u.type, eligible: u.isEligible, userUsage: u.userUsage, userLimit: u.userLimit, at: Date.now() };
      } catch { /* 额度查询失败不影响健康状态 */ }
      ch.models = notion.notionListModels();
      ch.latencyMs = Date.now() - t0;
      ch.lastCheck = Date.now();
      ch.consecutiveFail = 0; ch.cooldownUntil = 0; ch.lastError = null;
      ch.status = 'ok';
    } catch (err) {
      ch.status = 'down';
      ch.consecutiveFail++;
      ch.lastError = 'notion: ' + (err.message || err);
      ch.cooldownUntil = Date.now() + Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail));
    }
    return;
  }
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH.timeoutMs || 8000);
  const probeUrl = probeUrlFor(ch);
  let resp;
  let usedFallback = false;
  try {
    resp = await fetch(probeUrl, {
      method: probeMethodFor(ch),
      headers: probeHeadersFor(ch),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    // Cloudflare 拦截 → PS Schannel 回退
    if (resp.status === 403) {
      let body = '';
      try { body = await resp.text(); } catch {}
      if (isCloudflareBlock(403, body)) {
        const ps = await psHttpRequest(probeMethodFor(ch), probeUrl, probeHeadersFor(ch), null, HEALTH.timeoutMs || 8000);
        if (ps.status > 0) {
          usedFallback = true;
          resp = { ok: ps.status >= 200 && ps.status < 300, status: ps.status, text: async () => ps.body };
        }
      }
    }
    const ms = Date.now() - t0;
    if (!resp.ok) {
      ch.status = 'down';
      ch.consecutiveFail++;
      ch.lastError = `probe ${resp.status}`;
      ch.cooldownUntil = Date.now() + Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail));
      return;
    }
    const text = await resp.text();
    const j = safeJson(text);
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
  if (proto === 'notion')    return joinUrl(def.baseUrl, 'api/v3/getSpaces');
  if (proto === 'anthropic') return joinUrl(def.baseUrl, 'v1/models');
  if (proto === 'gemini')    return joinUrl(def.baseUrl, 'v1beta/models');
  return joinUrl(def.baseUrl, 'models');
}
function probeHeadersForDef(def) {
  const proto = def.protocol || 'openai';
  if (proto === 'notion')    return { 'User-Agent': notion.NOTION_UA, 'Cookie': `token_v2=${def.apiKey}` };
  if (proto === 'anthropic') return { 'x-api-key': def.apiKey, 'anthropic-version': '2023-06-01' };
  if (proto === 'gemini')    return { 'x-goog-api-key': def.apiKey };
  return { 'Authorization': `Bearer ${def.apiKey}` };
}
function extractModelIds(j, proto) {
  if (!j) return [];
  if (proto === 'notion')    return notion.notionListModels();
  if (proto === 'anthropic') return Array.isArray(j.data) ? j.data.map((m) => m.id).filter(Boolean) : [];
  if (proto === 'gemini')    return Array.isArray(j.models) ? j.models.map((m) => (m.name || '').replace(/^models\//, '')).filter(Boolean) : [];
  return Array.isArray(j.data) ? j.data.map((m) => m.id).filter(Boolean) : [];
}

// 探测一个 def（不要求它是已注册的渠道），返回 {ok, models, latencyMs, status, error}
async function probeDef(def, timeoutMs) {
  // Notion 协议：getSpaces（POST）验证 token_v2，模型列表用内置映射；顺带查 AI 额度
  if ((def.protocol || 'openai') === 'notion') {
    const t0 = Date.now();
    try {
      const acct = await notion.notionDiscoverAccount(def.baseUrl, def.apiKey, fetch, timeoutMs || 15000);
      let usage = null;
      try {
        const u = await notion.notionUsageEligibility(def.baseUrl, def.apiKey, acct, fetch, 10000);
        usage = {
          type: u.type,
          eligible: u.isEligible,
          sixHourWindow: { used: u.userUsage, limit: u.userLimit },
        };
      } catch { /* 额度接口失败不影响探测 */ }
      return { ok: true, models: notion.notionListModels(), latencyMs: Date.now() - t0, status: 200, account: { userId: acct.userId, spaces: acct.spaces.map((s) => s.name || s.spaceId) }, usage };
    } catch (err) {
      return { ok: false, status: err.status || 0, error: 'notion: ' + (err.message || err), latencyMs: Date.now() - t0 };
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || HEALTH.timeoutMs || 8000);
  const t0 = Date.now();
  try {
    const resp = await fetch(probeUrlForDef(def), { method: 'GET', headers: probeHeadersForDef(def), signal: ctrl.signal });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (resp.ok) {
      const j = await resp.json().catch(() => null);
      const models = extractModelIds(j, def.protocol || 'openai');
      return { ok: true, models, latencyMs: ms, status: 200 };
    }
    // 4xx/5xx: 读 body 判断是不是 Cloudflare 拦截
    let body = '';
    try { body = await resp.text(); } catch {}
    if (isCloudflareBlock(resp.status, body)) {
      // 用 PowerShell 走 .NET Schannel，绕过 JA3
      const ps = await psHttpRequest('GET', probeUrlForDef(def), probeHeadersForDef(def), null, timeoutMs || 12000);
      const ms2 = Date.now() - t0;
      if (ps.status >= 200 && ps.status < 300) {
        const j = safeJson(ps.body);
        const models = extractModelIds(j, def.protocol || 'openai');
        return { ok: true, models, latencyMs: ms2, status: ps.status, via: 'ps-fallback' };
      }
      return { ok: false, status: ps.status, error: `HTTP ${ps.status} (ps-fallback): ${ps.error || 'no body'}`, latencyMs: ms2, via: 'ps-fallback' };
    }
    return { ok: false, status: resp.status, error: `HTTP ${resp.status}: ${body.slice(0, 120)}`, latencyMs: ms };
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
  // Anthropic tools → OpenAI function tools
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'tool') out.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  if (body.system) {
    const sys = Array.isArray(body.system)
      ? body.system.map((s) => s.text || '').join('\n')
      : String(body.system);
    out.messages.push({ role: 'system', content: sys });
  }
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') {
      out.messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    // 分类收集
    const textParts = [];
    const imageParts = [];
    const toolUses = [];   // assistant 的 tool_use
    const toolResults = []; // user 的 tool_result
    for (const b of m.content) {
      if (b.type === 'text') textParts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') {
        imageParts.push({ type: 'image_url', image_url: { url: `data:${b.source?.media_type || 'image/png'};base64,${b.source?.data || ''}` } });
      } else if (b.type === 'tool_use') {
        toolUses.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
      } else if (b.type === 'tool_result') {
        // tool_result 内容可能是 string 或 blocks
        let contentText = '';
        if (typeof b.content === 'string') contentText = b.content;
        else if (Array.isArray(b.content)) {
          contentText = b.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
        }
        toolResults.push({ tool_call_id: b.tool_use_id, content: contentText || '(ok)' });
      }
    }
    if (m.role === 'assistant') {
      // assistant：文本 + tool_calls 合并
      const msg = { role: 'assistant', content: textParts.map((p) => p.text).join('') || null };
      if (toolUses.length) msg.tool_calls = toolUses;
      if (imageParts.length) msg.content = [...textParts, ...imageParts];
      out.messages.push(msg);
    } else {
      // user：文本/图片 作为 user 消息；tool_result 转成 role:'tool'
      if (textParts.length || imageParts.length) {
        out.messages.push({ role: 'user', content: [...textParts, ...imageParts] });
      }
      for (const tr of toolResults) {
        out.messages.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content });
      }
    }
  }
  return out;
}

function openAIToAnthropicResponse(oai, modelAlias) {
  const choice = oai.choices && oai.choices[0];
  const msg = choice ? (choice.message || {}) : {};
  const text = msg.content || '';
  const content = [];
  if (text) content.push({ type: 'text', text });
  // OpenAI tool_calls → Anthropic tool_use blocks
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      content.push({ type: 'tool_use', id: tc.id || `toolu_${Date.now()}`, name: tc.function?.name || '', input });
    }
  }
  return {
    id: oai.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: oai.model || modelAlias,
    content: content.length ? content : [{ type: 'text', text: '' }],
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
  let nextIndex = 0;
  let textIndex = -1;
  let finishReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  // tool_calls 增量：OpenAI 按 index 分流，每个 index 一个 tool_use block
  const toolBlock = new Map(); // deltaIndex → { index: anthropicIndex, id, name, argsBuf }
  for (const c of chunks) {
    const choice = c.choices?.[0];
    const delta = choice?.delta?.content;
    if (delta) {
      if (textIndex < 0) {
        textIndex = nextIndex++;
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } } };
      }
      yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta } } };
    }
    // tool_calls 增量
    if (Array.isArray(choice?.delta?.tool_calls)) {
      for (const tc of choice.delta.tool_calls) {
        const di = tc.index ?? 0;
        let blk = toolBlock.get(di);
        if (!blk) {
          const idx = nextIndex++;
          blk = { index: idx, id: tc.id || '', name: '', argsBuf: '', started: false };
          toolBlock.set(di, blk);
        }
        if (tc.id && !blk.id) blk.id = tc.id;
        if (tc.function?.name && !blk.name) blk.name = tc.function.name;
        if (tc.function?.arguments) blk.argsBuf += tc.function.arguments;
        if (!blk.started && (blk.name || blk.id)) {
          blk.started = true;
          yield { event: 'content_block_start', data: { type: 'content_block_start', index: blk.index, content_block: { type: 'tool_use', id: blk.id || `toolu_${Date.now()}`, name: blk.name } } };
          yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: blk.index, delta: { type: 'input_json_delta', partial_json: '' } } };
        }
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (c.usage) usage = { input_tokens: c.usage.prompt_tokens || 0, output_tokens: c.usage.completion_tokens || 0 };
  }
  // 关闭 text block
  if (textIndex >= 0) {
    yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } };
  }
  // 关闭 tool blocks（把累计的参数 JSON 一次性作为 partial_json 发完）
  for (const [, blk] of toolBlock) {
    if (blk.started) {
      // 前面已发空 partial_json；这里补发完整参数
      const args = blk.argsBuf || '{}';
      try { JSON.parse(args); } catch { /* 保留原样 */ }
      yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: blk.index, delta: { type: 'input_json_delta', partial_json: args } } };
      yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: blk.index } };
    }
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

// 从协议原生响应里抽 reply 文本
function extractReply(parsed, proto) {
  if (!parsed) return '';
  if (proto === 'anthropic') {
    return parsed.content?.[0]?.text || '';
  }
  if (proto === 'gemini') {
    return parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  return parsed.choices?.[0]?.message?.content || '';
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
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
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
      apiKey: ch.def.apiKey,
      protocol: ch.def.protocol || 'openai',
      priority: ch.def.priority ?? 0,
      enabled: ch.def.enabled !== false,
      autoAlias: ch.def.autoAlias !== false,
      status: ch.status,
      lastCheck: ch.lastCheck,
      latencyMs: ch.latencyMs,
      consecutiveFail: ch.consecutiveFail,
      cooldownUntil: ch.cooldownUntil,
      lastError: ch.lastError,
      aliases: Array.from(ch.aliasMap.entries()).map(([a, u]) => ({ alias: a, upstream: u })),
      upstreamModels: ch.models,
      notionUsage: ch.notion && ch.notion.usage ? ch.notion.usage : undefined,
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

// ─────────────────────────── 用量统计 ───────────────────────────
// usage.json 持久化（容器内 /app/usage.json，compose 挂载到宿主机 ./usage.json）
const USAGE_PATH = process.env.ZZCSAPI_USAGE || path.join(__dirname, 'usage.json');
let usageData = null;
let usageFlushTimer = null;

function ensureUsage() {
  if (usageData) return usageData;
  try {
    usageData = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
    if (!usageData || typeof usageData !== 'object' || Array.isArray(usageData)) throw new Error('bad');
  } catch { usageData = null; }
  if (!usageData) usageData = { total: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 }, byModel: {}, byChannel: {}, byDay: {}, recent: [] };
  if (!usageData.total) usageData.total = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
  if (!usageData.byModel) usageData.byModel = {};
  if (!usageData.byChannel) usageData.byChannel = {};
  if (!usageData.byDay) usageData.byDay = {};
  if (!Array.isArray(usageData.recent)) usageData.recent = [];
  return usageData;
}

function flushUsage() {
  if (usageFlushTimer) { clearTimeout(usageFlushTimer); usageFlushTimer = null; }
  try {
    const u = ensureUsage();
    fs.writeFileSync(USAGE_PATH, JSON.stringify(u, null, 1) + '\n', 'utf8');
  } catch { /* 磁盘失败不影响服务 */ }
}

function scheduleUsageFlush() {
  if (usageFlushTimer) return;
  usageFlushTimer = setTimeout(() => { usageFlushTimer = null; flushUsage(); }, 4000);
}

// token 估算：CJK 1 字 ≈ 1 token，其他 ≈ 4 字符/token（上游不返回 usage 时兜底）
function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : String(text);
  let cjk = 0, other = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF00 && c <= 0xFFEF) || (c >= 0xAC00 && c <= 0xD7AF) || (c >= 0x3040 && c <= 0x30FF)) cjk++;
    else other++;
  }
  return Math.max(s.length ? 1 : 0, Math.ceil(cjk + other / 4));
}

// 提取 messages 的纯文本（兼容 OpenAI/Anthropic 数组 content）
function messagesText(messages) {
  if (!Array.isArray(messages)) return '';
  let out = '';
  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    const c = m.content;
    if (typeof c === 'string') out += c + '\n';
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p && typeof p === 'object') {
          if (typeof p.text === 'string') out += p.text;
          else if (typeof p.content === 'string') out += p.content;
        }
      }
      out += '\n';
    }
  }
  return out;
}

function bumpUsageBucket(map, key, inTok, outTok, ok) {
  if (!key) key = 'unknown';
  let b = map[key];
  if (!b) b = map[key] = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
  b.requests++;
  if (!ok) b.errors++;
  b.inputTokens += inTok;
  b.outputTokens += outTok;
}

// 记一次请求用量。realUsage 可传 {prompt_tokens, completion_tokens}（上游真实值优先）
function recordUsage({ model, channelId, kind, inputTokens, outputTokens, ok, latencyMs, realUsage, note }) {
  try {
    const u = ensureUsage();
    let inTok = inputTokens || 0;
    let outTok = outputTokens || 0;
    // 真实 usage 优先，但上游计量缺失/为 0 时保留估算值
    if (realUsage && Number.isFinite(realUsage.prompt_tokens) && realUsage.prompt_tokens > 0) inTok = realUsage.prompt_tokens;
    if (realUsage && Number.isFinite(realUsage.completion_tokens) && realUsage.completion_tokens > 0) outTok = realUsage.completion_tokens;
    const ts = Date.now();
    u.total.requests++;
    if (!ok) u.total.errors++;
    u.total.inputTokens += inTok;
    u.total.outputTokens += outTok;
    bumpUsageBucket(u.byModel, model, inTok, outTok, ok);
    bumpUsageBucket(u.byChannel, channelId, inTok, outTok, ok);
    const day = new Date(ts).toISOString().slice(0, 10);
    bumpUsageBucket(u.byDay, day, inTok, outTok, ok);
    u.recent.push({ ts, model, channelId, kind: kind || 'chat', in: inTok, out: outTok, ok: ok !== false, ms: latencyMs || 0, ...(note ? { note } : {}) });
    if (u.recent.length > 800) u.recent.splice(0, u.recent.length - 800);
    scheduleUsageFlush();
  } catch { /* 统计失败不影响请求 */ }
}

// 从 SSE 行提取 delta 内容（content + reasoning_content），累计输出文本
function sseDeltaText(line) {
  if (!line || line.indexOf('data:') !== 0) return '';
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return '';
  try {
    const j = JSON.parse(data);
    const d = j && j.choices && j.choices[0] && j.choices[0].delta;
    if (!d) return '';
    let t = '';
    if (typeof d.content === 'string') t += d.content;
    if (typeof d.reasoning_content === 'string') t += d.reasoning_content;
    if (typeof d.reasoning === 'string') t += d.reasoning;
    return t;
  } catch { return ''; }
}

function validateChannelDef(def) {
  if (!def || typeof def !== 'object') return 'body must be an object';
  if (!def.id || !/^[a-zA-Z0-9_\-]+$/.test(def.id)) return 'id is required and must be [a-zA-Z0-9_-]+';
  if (!def.baseUrl || typeof def.baseUrl !== 'string') return 'baseUrl is required';
  if (!def.apiKey || typeof def.apiKey !== 'string') return 'apiKey is required';
  if (def.protocol && !['openai', 'anthropic', 'gemini', 'notion'].includes(def.protocol)) return 'protocol must be openai|anthropic|gemini|notion';
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
  // 用量统计：总用量 / 按模型 / 按渠道 / 按天 / 最近请求 / 24小时分布 / 各渠道平均延迟
  if (req.method === 'GET' && url.pathname === '/admin/api/usage') {
    const u = ensureUsage();
    const sorted = (obj) => Object.entries(obj)
      .map(([k, v]) => ({ key: k, ...v, total: (v.inputTokens || 0) + (v.outputTokens || 0) }))
      .sort((a, b) => (b.total || 0) - (a.total || 0));
    // 24 小时分布（按最近 800 条请求的本地小时）
    const hourly = Array.from({ length: 24 }, (_, h) => ({ h, requests: 0, errors: 0 }));
    for (const r of u.recent) {
      const h = new Date(r.ts).getHours();
      if (hourly[h]) { hourly[h].requests++; if (r.ok === false) hourly[h].errors++; }
    }
    // 各渠道平均延迟（按最近成功请求）
    const latSum = {}, latCnt = {};
    for (const r of u.recent) {
      if (r.ok !== false && r.ms > 0 && r.channelId) { latSum[r.channelId] = (latSum[r.channelId] || 0) + r.ms; latCnt[r.channelId] = (latCnt[r.channelId] || 0) + 1; }
    }
    const latency = {};
    for (const k of Object.keys(latSum)) latency[k] = Math.round(latSum[k] / latCnt[k]);
    return sendJson(res, 200, {
      total: u.total,
      byModel: sorted(u.byModel),
      byChannel: sorted(u.byChannel),
      byDay: Object.entries(u.byDay).map(([k, v]) => ({ day: k, requests: v.requests || 0, errors: v.errors || 0, inputTokens: v.inputTokens || 0, outputTokens: v.outputTokens || 0 })).sort((a, b) => a.day.localeCompare(b.day)),
      hourly,
      latency,
      recent: u.recent.slice(-200).reverse(),
    });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/usage/clear') {
    usageData = { total: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 }, byModel: {}, byChannel: {}, byDay: {}, recent: [] };
    flushUsage();
    return sendJson(res, 200, { ok: true });
  }
  // 暴露给控制台展示接入信息（含 key 与 URL）。仅本机 admin 可用。
  if (req.method === 'GET' && url.pathname === '/admin/api/config') {
    const base = `http://127.0.0.1:${PORT}`;
    return sendJson(res, 200, {
      port: PORT,
      gatewayKey: GATEWAY_KEY || '',
      adminKey: ADMIN_KEY || '',
      gatewayKeyRequired: !!GATEWAY_KEY,
      adminKeyRequired: !!ADMIN_KEY,
      urls: {
        openai: `${base}/v1`,
        anthropic: `${base}/anthropic`,
        gemini: `${base}/gemini/v1beta`,
        console: `${base}/console`,
        health: `${base}/healthz`,
      },
    });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/recheck') {
    const body = await safeReadJson(req);
    if (body && body.id) {
      const ch = channels.get(body.id);
      if (!ch) return sendJson(res, 404, { error: 'channel not found' });
      const before = ch.status;
      await probeChannel(ch);
      return sendJson(res, 200, {
        ok: true,
        results: [{
          id: body.id,
          status: ch.status,
          before,
          latencyMs: ch.latencyMs,
          modelCount: ch.models.length,
          error: ch.lastError,
        }],
      });
    }
    // 全部：先记下探测前状态，然后逐个探测后产出摘要
    const before = new Map();
    for (const ch of channels.values()) before.set(ch.def.id, ch.status);
    await probeAll();
    const results = Array.from(channels.values()).map((ch) => ({
      id: ch.def.id,
      status: ch.status,
      before: before.get(ch.def.id) || 'unknown',
      latencyMs: ch.latencyMs,
      modelCount: ch.models.length,
      error: ch.lastError,
    }));
    const summary = { ok: results.filter((r) => r.status === 'ok' || r.status === 'degraded').length, fail: results.filter((r) => r.status === 'down').length, total: results.length };
    return sendJson(res, 200, { ok: true, summary, results });
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
      autoAlias: body.autoAlias === true,
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
      protocol: ['openai', 'anthropic', 'gemini', 'notion'].includes(body.protocol) ? body.protocol : 'openai',
    };
    const r = await probeDef(def, Math.min(15000, Number(body.timeoutMs) || 10000));
    return sendJson(res, 200, r);
  }
  // 真模型测试：发一个最小 chat 请求，返回首字延迟 / 总耗时 / 错误
  if (req.method === 'POST' && url.pathname === '/admin/api/test') {
    const body = await safeReadJson(req) || {};
    const model = String(body.model || '').trim();
    if (!model) return sendJson(res, 400, { error: 'model required' });
    const onlyChannel = body.channelId ? channels.get(body.channelId) : null;
    if (body.channelId && !onlyChannel) return sendJson(res, 404, { error: 'channel not found' });

    const candidates = onlyChannel
      ? [{
          channelId: onlyChannel.def.id,
          upstream: model,
          priority: 0,
          status: onlyChannel.status,
          latencyMs: onlyChannel.latencyMs,
          cooldownUntil: 0,
          consecutiveFail: onlyChannel.consecutiveFail,
          protocol: onlyChannel.def.protocol || 'openai',
        }]
      : (channelsServing(model, 'openai').length ? channelsServing(model, 'openai') : channelsServing(model, 'notion')); // openai 优先，notion 兜底
    if (candidates.length === 0) return sendJson(res, 404, { error: 'no channel for model' });

    const prompt = String(body.prompt || 'Reply with "ok".');
    const results = [];
    for (const c of candidates) {
      const ch = channels.get(c.channelId);
      const t0 = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(60000, Number(body.timeoutMs) || 30000));
      let ttfb = 0;
      let resp;
      try {
        if (ch.def.protocol === 'notion') {
          // Notion 渠道：跑一次最小 runInferenceTranscript（真实模型调用，curl 优先）
          const acct = await ensureNotionAccount(ch, 15000);
          const built = notion.buildNotionTranscript([{ role: 'user', content: prompt }], c.upstream, acct);
          const payload = notion.notionBuildPayload(built.transcript, built.threadType, acct, {});
          const headers = notion.notionHeaders(acct, ch.def.apiKey, ch.def.baseUrl.replace(/\/+$/, ''));
          const target = ch.def.baseUrl.replace(/\/+$/, '') + '/api/v3/runInferenceTranscript';
          const bodyStr = JSON.stringify(payload);
          const tmo = Math.min(60000, Number(body.timeoutMs) || 30000);
          let text = '';
          let ok = false;
          let status = 0;
          const curlOut = await notionCurlRequest('POST', target, headers, bodyStr, tmo);
          if (curlOut.status > 0 && curlOut.body && !curlOut.error) {
            text = curlOut.body; status = 200; ok = true;
          } else {
            try {
              resp = await fetch(target, { method: 'POST', headers, body: bodyStr, signal: ctrl.signal });
              text = await resp.text();
              ok = resp.ok; status = resp.status;
            } catch (e) { text = String(e.message || e); }
          }
          ttfb = Date.now() - t0;
          // 流内错误检测（temporarily-unavailable 等 soft-block）
          const streamErr = (text.match(/"subType":"([^"]+)"/) || [])[1];
          // 解析 NDJSON 取全文
          let contentText = '', finalText = '';
          const parser = notion.createNotionStreamParser((evt) => {
            if (evt.type === 'content') contentText += evt.text;
            else if (evt.type === 'final') finalText = evt.text;
          });
          for (const ln of text.split('\n')) parser.line(ln);
          const reply = contentText.trim() || finalText || '';
          const testOk = ok && !!reply && !streamErr;
          if (testOk) {
            ch.consecutiveFail = 0; ch.cooldownUntil = 0; ch.lastError = null;
            if (ch.status !== 'ok') ch.status = 'ok';
            ch.latencyMs = ttfb; ch.lastCheck = Date.now();
            recordUsage({
              model, channelId: c.channelId, kind: 'test',
              inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(reply),
              ok: true, latencyMs: ttfb,
            });
            // 测试消耗了额度 → 异步刷新
            try {
              notion.notionUsageEligibility(ch.def.baseUrl, ch.def.apiKey, acct, fetch, 8000)
                .then((u) => { if (ch.notion) ch.notion.usage = { type: u.type, eligible: u.isEligible, userUsage: u.userUsage, userLimit: u.userLimit, at: Date.now() }; })
                .catch(() => {});
            } catch {}
          }
          results.push({
            channelId: c.channelId, ok: testOk, status: status || 200, latencyMs: ttfb,
            reply: reply.slice(0, 200) || undefined,
            error: testOk ? undefined : (streamErr ? 'notion: ' + streamErr : (ok ? 'empty stream' : `HTTP ${status}: ${text.slice(0, 150)}`)),
          });
          continue;
        }
        // 走 dispatchRequest 复用出站请求构造
        // 简化：自己拼一个最小 chat 请求
        const target = ch.def.protocol === 'anthropic'
          ? joinUrl(ch.def.baseUrl, 'v1/messages')
          : ch.def.protocol === 'gemini'
            ? joinUrl(ch.def.baseUrl, 'v1beta/models/' + encodeURIComponent(c.upstream) + ':generateContent')
            : joinUrl(ch.def.baseUrl, 'chat/completions');
        const headers = ch.def.protocol === 'anthropic'
          ? { 'Content-Type': 'application/json', 'x-api-key': ch.def.apiKey, 'anthropic-version': '2023-06-01' }
          : ch.def.protocol === 'gemini'
            ? { 'Content-Type': 'application/json', 'x-goog-api-key': ch.def.apiKey }
            : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.def.apiKey}` };
        let bodyOut;
        if (ch.def.protocol === 'anthropic') {
          bodyOut = { model: c.upstream, max_tokens: 16, messages: [{ role: 'user', content: prompt }] };
        } else if (ch.def.protocol === 'gemini') {
          bodyOut = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 16 } };
        } else {
          bodyOut = { model: c.upstream, max_tokens: 16, messages: [{ role: 'user', content: prompt }] };
        }
        resp = await fetch(target, { method: 'POST', headers, body: JSON.stringify(bodyOut), signal: ctrl.signal });
        let text = await resp.text();
        // Cloudflare 拦截 → PS Schannel 回退
        if (!resp.ok && isCloudflareBlock(resp.status, text)) {
          const ps = await psHttpRequest('POST', target, headers, JSON.stringify(bodyOut), Math.min(60000, Number(body.timeoutMs) || 30000));
          if (ps.status > 0) {
            text = ps.body;
            resp = { ok: ps.status >= 200 && ps.status < 300, status: ps.status };
          }
        }
        ttfb = Date.now() - t0;
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        const errText = (parsed && (parsed.error?.message || parsed.message)) || (resp.ok ? '' : text.slice(0, 200));
        // 测试成功时清零 channel 失败计数并标 ok（与主调度一致）
        if (resp.ok) {
          ch.consecutiveFail = 0;
          ch.cooldownUntil = 0;
          ch.lastError = null;
          if (ch.status !== 'ok') ch.status = 'ok';
          ch.latencyMs = ttfb;
          ch.lastCheck = Date.now();
          recordUsage({
            model, channelId: c.channelId, kind: 'test',
            inputTokens: parsed?.usage?.prompt_tokens ?? estimateTokens(prompt),
            outputTokens: parsed?.usage?.completion_tokens ?? estimateTokens(extractReply(parsed, ch.def.protocol || 'openai') || ''),
            ok: true, latencyMs: ttfb,
            realUsage: parsed?.usage,
          });
        }
        results.push({
          channelId: c.channelId,
          ok: resp.ok,
          status: resp.status,
          latencyMs: ttfb,
          promptTokens: parsed?.usage?.prompt_tokens,
          completionTokens: parsed?.usage?.completion_tokens,
          reply: extractReply(parsed, ch.def.protocol || 'openai'),
          error: errText || undefined,
        });
      } catch (err) {
        results.push({ channelId: c.channelId, ok: false, latencyMs: Date.now() - t0, error: String(err && err.message || err) });
      } finally {
        clearTimeout(timer);
      }
    }
    return sendJson(res, 200, { model, prompt, results });
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
// Bedrock 等上游要求 tool id 匹配 ^[a-zA-Z0-9_-]+$；客户端可能发出空 id 或含非法字符。
// 统一清洗：保证合法且 assistant.tool_calls[].id 与 role:'tool' 的 tool_call_id 配对一致。
function sanitizeToolId(id, seen) {
  let s = String(id || '');
  s = s.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!s) s = 'toolu_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  if (s.length > 128) s = s.slice(0, 128);
  if (seen) { if (seen.has(id)) return seen.get(id); seen.set(id, s); }
  return s;
}

function sanitizeOpenAIToolIds(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  const idMap = new Map(); // 原id → 新id（保证 assistant 与 tool 消息配对一致）
  let fixedCount = 0;
  for (const m of body.messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const orig = tc.id;
        const fixed = sanitizeToolId(orig, null);
        if (orig !== fixed) { tc.id = fixed; fixedCount++; console.log('[sanitize] tool_call id "' + String(orig).slice(0, 60) + '" → "' + fixed.slice(0, 60) + '"'); }
        if (orig != null) idMap.set(String(orig), fixed); // 空字符串也要配对记录
      }
    }
    if (m.role === 'tool' && m.tool_call_id != null) {
      const orig = m.tool_call_id;
      const fixed = idMap.has(String(orig)) ? idMap.get(String(orig)) : sanitizeToolId(orig, null);
      if (orig !== fixed) { m.tool_call_id = fixed; fixedCount++; console.log('[sanitize] tool_call_id "' + String(orig).slice(0, 60) + '" → "' + fixed.slice(0, 60) + '"'); }
    }
  }
  if (fixedCount) console.log('[sanitize] fixed ' + fixedCount + ' invalid tool id(s) for model=' + (body.model || '?'));
  return body;
}

async function handleOpenAIRequest(req, res, url) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return sendJson(res, 400, upstreamErrorPayload(400, 'invalid JSON body')); }
  sanitizeOpenAIToolIds(body); // 清洗工具 id（空/非法字符 → 合法，保持配对）
  const requested = body.model;
  if (!requested) return sendJson(res, 400, upstreamErrorPayload(400, 'missing model'));
  let candidates = channelsServing(requested, 'openai');
  // notion 渠道兜底：openai 渠道全挂/限频时接住（作为候选链尾部，不抢优先级）
  const notionCands = channelsServing(requested, 'notion');
  for (const nc of notionCands) if (!candidates.some((c) => c.channelId === nc.channelId)) candidates.push(nc);
  if (candidates.length === 0) {
    return sendJson(res, 404, upstreamErrorPayload(404, `no openai channel for model "${requested}"`));
  }
  return dispatchRequest({
    kind: 'openai',
    res,
    url,
    body,
    candidates,
    requestedModel: requested,
    isStream: !!body.stream,
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
    // 优先 anthropic 协议渠道；没有则回落 openai 协议（网关做 Anthropic↔OpenAI 转换）；notion 始终作为兜底候选
    let candidates = channelsServing(requested, 'anthropic');
    if (candidates.length === 0) candidates = channelsServing(requested, 'openai');
    for (const nc of channelsServing(requested, 'notion')) if (!candidates.some((c) => c.channelId === nc.channelId)) candidates.push(nc);
    if (candidates.length === 0) {
      return sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `no channel for model "${requested}"` } });
    }
    const isStream = !!body.stream;
    const oaiBody = sanitizeOpenAIToolIds(anthropicToOpenAI(body)); // 转换 + 清洗工具 id
    return dispatchRequest({
      kind: 'anthropic',
      res,
      url: { ...url, pathname: '/v1/chat/completions' }, // 复用 OpenAI 上游路径
      body: oaiBody,
      candidates,
      requestedModel: requested,
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

  let candidates = channelsServing(model, 'gemini');
  if (candidates.length === 0) candidates = channelsServing(model, 'openai');
  for (const nc of channelsServing(model, 'notion')) if (!candidates.some((c) => c.channelId === nc.channelId)) candidates.push(nc);
  if (candidates.length === 0) {
    return sendJson(res, 404, { error: { code: 404, message: `no channel for model "${model}"`, status: 'NOT_FOUND' } });
  }

  const oaiBody = geminiToOpenAI(body, model);
  return dispatchRequest({
    kind: 'gemini',
    res,
    url: { ...url, pathname: '/v1/chat/completions' },
    body: oaiBody,
    candidates,
    requestedModel: model,
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
  const { res, url, body, candidates, isStream, encodeOutgoing, buildOutgoingUrl, buildOutgoingHeaders, onSuccessNonStream, onStreamChunk, requestedModel, kind } = opts;
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
    // 还有后续候选 → 守门可以掐得早（快速切兜底）；已是最后候选 → 守门放宽到 300s（对齐
    // 客户端 idle 超时：上游"慢但能成"的请求留给客户端自身的重试机制，而不是被网关提前掐死）
    const hasMoreCandidates = i < Math.min(candidates.length, RETRIES.maxModelFallbacks || 99) - 1;
    const result = await tryChannel({
      res, url, body, candidate: c, isStream: stream,
      encodeOutgoing, buildOutgoingUrl, buildOutgoingHeaders, onSuccessNonStream, onStreamChunk, requestedModel, kind,
      hasMoreCandidates,
    });
    if (result === 'success') return;
    if (result === 'fatal_client') return;
    // 响应头已发出（某候选已开始写响应）→ 无法再切换渠道，直接结束
    if (res.headersSent || res.writableEnded) {
      if (!res.writableEnded) { try { res.end(); } catch {} }
      return;
    }
    errors.push({ ch: c.channelId, err: result });
  }
  if (!attemptedAny) return sendJson(res, 503, upstreamErrorPayload(503, 'all channels in cooldown'));
  return sendJson(res, 502, { error: { message: `all channels failed`, type: 'gateway_error', attempts: errors } });
}

async function tryChannel(opts) {
  const { res, url, body, candidate, isStream, encodeOutgoing, buildOutgoingUrl, buildOutgoingHeaders, onSuccessNonStream, onStreamChunk } = opts;
  const ch = channels.get(candidate.channelId);
  // Notion 协议渠道：完全独立的请求/响应路径
  if ((ch.def.protocol || 'openai') === 'notion') {
    return tryNotionChannel({ res, body, candidate, ch, isStream, kind: opts.kind, requestedModel: opts.requestedModel });
  }
  const outgoing = encodeOutgoing(body, candidate);
  const target = buildOutgoingUrl(ch);
  const headers = buildOutgoingHeaders(ch);
  const bodyStr = JSON.stringify(outgoing);
  const timeoutMs = ch.def.timeoutMs || 120_000;

  const t0 = Date.now();
  let resp;
  let usedFallback = false;
  let respBody = null;

  // 第一次尝试：Node fetch (undici)
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      resp = await fetch(target, { method: 'POST', headers, body: bodyStr, signal: ctrl.signal });
    } finally { clearTimeout(to); }
  } catch (err) {
    recordFailure(ch, String(err && err.message || err));
    return `network: ${err.message || err}`;
  }

  // 如果 fetch 被 Cloudflare 拦了（403 + HTML），且是非流请求，回退到 PowerShell (.NET Schannel)
  if (resp.status === 403 && !isStream) {
    let cfBody = '';
    try { cfBody = await resp.text(); } catch {}
    if (isCloudflareBlock(403, cfBody)) {
      const ps = await psHttpRequest('POST', target, headers, bodyStr, timeoutMs);
      if (ps.status > 0) {
        usedFallback = true;
        // 包装成 fetch-like
        respBody = ps.body;
        resp = {
          status: ps.status,
          ok: ps.status >= 200 && ps.status < 300,
          headers: { get: (k) => {
            const v = ps.headers[String(k).toLowerCase()];
            return Array.isArray(v) ? v[0] : v;
          } },
          text: async () => ps.body,
          json: async () => safeJson(ps.body) || {},
          body: null,
        };
      }
    }
  }

  if (!resp.ok) {
    const text = usedFallback ? (respBody || '') : (await resp.text().catch(() => ''));
    recordFailure(ch, `HTTP ${resp.status}: ${String(text).slice(0, 200)}`);
    // 401/402/403 是我们渠道侧的鉴权/余额问题（不是客户端的错）→ 切下一候选兜底；
    // 其余 4xx（400 参数 / 404 模型不存在等）是客户端错误 → 原样透传给调用方
    if (resp.status >= 400 && resp.status < 500 && ![401, 402, 403, 408, 429].includes(resp.status)) {
      // 客户端错误：直接把上游响应转发
      const ct = (resp.headers && resp.headers.get('content-type')) || '';
      res.writeHead(resp.status, { 'Content-Type': ct || 'application/json' });
      res.end(text);
      return 'fatal_client';
    }
    return `upstream ${resp.status}${usedFallback ? ' (via ps-fallback)' : ''}`;
  }

  // 成功
  ch.consecutiveFail = 0;
  ch.cooldownUntil = 0;
  ch.lastError = null;
  if (ch.status === 'down' || ch.status === 'unknown') ch.status = 'ok';
  ch.latencyMs = Date.now() - t0;

  if (isStream) {
    // PS 回退模式下没有流：直接把完整 body 写一次（仍满足"非空"语义）
    if (usedFallback) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-ZZCSAPI-Channel': candidate.channelId,
      });
      if (respBody) res.write(respBody);
      res.end();
      recordUsage({
        model: body && body.model, channelId: candidate.channelId, kind: opts.kind,
        inputTokens: estimateTokens(messagesText(body && body.messages)),
        outputTokens: estimateTokens(respBody), ok: true, latencyMs: Date.now() - t0,
      });
      return 'success';
    }
    const reader = resp.body.getReader();
    // ── 首字节守门（自适应）：上游迟迟不出首字节（免费线路排队/挂起）时——
    //    · 后面还有候选 → 90s 掐掉切下一候选（兜底是纯赚：避免干等）
    //    · 已是最后候选 → 等 300s（与 DSH 的 idle 超时一致）。上游"慢但能在客户端超时前出数据"
    //      的请求仍能成功，失败也由客户端自身的重试机制接管（保持旧行为）。
    //    在 writeHead 之前等首块，此时响应未提交，切候选仍可行。
    const FIRST_CHUNK_MS = ch.def.firstChunkTimeoutMs || (opts.hasMoreCandidates ? 90_000 : 300_000);
    let firstVal = null;
    let firstTimer = null;
    try {
      const first = await Promise.race([
        reader.read(),
        new Promise((_, rej) => { firstTimer = setTimeout(() => rej(new Error('zz-first-chunk-timeout')), FIRST_CHUNK_MS); }),
      ]);
      clearTimeout(firstTimer);
      if (first && !first.done) firstVal = first.value;
    } catch (err) {
      clearTimeout(firstTimer);
      try { reader.cancel(); } catch {}
      recordFailure(ch, `stream idle: 上游 ${FIRST_CHUNK_MS / 1000 | 0}s 未出首字节（挂起/排队）`);
      return `stream idle ${FIRST_CHUNK_MS}ms`;
    }
    res.writeHead(200, {
      'Content-Type': resp.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-ZZCSAPI-Channel': candidate.channelId,
    });
    const decoder = new TextDecoder();
    let buf = firstVal ? decoder.decode(firstVal, { stream: true }) : '';
    let streamOutText = ''; // 累计输出（用于 token 估算）
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          streamOutText += sseDeltaText(line);
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
        streamOutText += sseDeltaText(buf);
        const out = onStreamChunk(buf + '\n', candidate);
        if (out) res.write(out);
      }
    } catch (err) { /* 上游已断 */ }
    res.end();
    recordUsage({
      model: body && body.model, channelId: candidate.channelId, kind: opts.kind,
      inputTokens: estimateTokens(messagesText(body && body.messages)),
      outputTokens: estimateTokens(streamOutText), ok: true, latencyMs: Date.now() - t0,
    });
    return 'success';
  } else {
    // 非流式：先读全文（统计 + 转发），shim 给 handler 避免 double-read
    const text = await resp.text();
    let realUsage = null;
    let replyText = '';
    try {
      const j = JSON.parse(text);
      if (j && j.usage) realUsage = j.usage;
      if (j && j.choices && j.choices[0] && j.choices[0].message && typeof j.choices[0].message.content === 'string') replyText = j.choices[0].message.content;
    } catch { /* 非 JSON 上游 */ }
    recordUsage({
      model: body && body.model, channelId: candidate.channelId, kind: opts.kind,
      inputTokens: estimateTokens(messagesText(body && body.messages)),
      outputTokens: estimateTokens(replyText),
      ok: true, latencyMs: Date.now() - t0, realUsage,
    });
    const shim = { ok: resp.ok, status: resp.status, headers: resp.headers, text: async () => text };
    await onSuccessNonStream(shim, candidate);
    return 'success';
  }
}

// ─────────────────────────── Notion 渠道执行 ───────────────────────────
// 凭据缓存：ch.notion = {userId, spaceId, spaceViewId, userName, userEmail, at}
async function ensureNotionAccount(ch, timeoutMs) {
  if (ch.notion && Date.now() - ch.notion.at < 3600_000) return ch.notion;
  const acct = await notion.notionDiscoverAccount(ch.def.baseUrl, ch.def.apiKey, fetch, timeoutMs || 15000);
  const first = acct.spaces[0];
  const info = {
    userId: acct.userId,
    spaceId: first.spaceId,
    spaceViewId: first.spaceViewId || '',
    userName: acct.userName,
    userEmail: acct.userEmail,
    spaces: acct.spaces,
    at: Date.now(),
  };
  ch.notion = info;
  return info;
}

function notionSSEChunk(id, model, delta) {
  // OpenAI 流 chunk；delta 可含 content / reasoning_content
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
}

async function tryNotionChannel(opts) {
  const { res, body, candidate, ch, isStream, requestedModel } = opts;
  const t0 = Date.now();
  const timeoutMs = ch.def.timeoutMs || 180_000;
  const displayModel = requestedModel || candidate.upstream;

  // 1) 凭据（token_v2 → space/user）
  let acct;
  try {
    acct = await ensureNotionAccount(ch, 15000);
  } catch (err) {
    ch.notion = null; // 凭据缓存失效，下次重刷
    recordFailure(ch, 'notion-auth: ' + (err.message || err));
    if (String(err.status) === '401') return 'fatal_client';
    return 'notion-auth: ' + (err.message || err);
  }

  // 2) transcript + payload
  const built = notion.buildNotionTranscript(body.messages, candidate.upstream, acct);
  if (built.error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: built.error, type: 'invalid_request_error' } }));
    return 'fatal_client';
  }
  const payload = notion.notionBuildPayload(built.transcript, built.threadType, acct, {});
  const headers = notion.notionHeaders(acct, ch.def.apiKey, ch.def.baseUrl.replace(/\/+$/, ''));
  const target = ch.def.baseUrl.replace(/\/+$/, '') + '/api/v3/runInferenceTranscript';
  const bodyStr = JSON.stringify(payload);

  // 3) 发请求 —— curl 子进程优先（undici TLS 指纹被 Notion 推理服务 soft-block，
  //    实测 curl.exe(Schannel)/Linux curl 可过）；curl 不可用时降级 fetch
  const curlOut = await notionCurlRequest('POST', target, headers, bodyStr, timeoutMs);
  let ndjsonText = '';
  let httpStatus = 200;
  if (curlOut.status > 0 && curlOut.body && !curlOut.error) {
    ndjsonText = curlOut.body;
  } else {
    // curl 失败 → fetch 降级（万一某环境 curl 也能过）
    let resp;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        resp = await fetch(target, { method: 'POST', headers, body: bodyStr, signal: ctrl.signal });
      } finally { clearTimeout(to); }
      httpStatus = resp.status;
      if (resp.ok) ndjsonText = await resp.text();
      else {
        const errText = await resp.text().catch(() => '');
        recordFailure(ch, `notion HTTP ${resp.status}: ${errText.slice(0, 200)}`);
        if (resp.status >= 400 && resp.status < 500 && ![401, 402, 403, 408, 429].includes(resp.status)) {
          res.writeHead(resp.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Notion upstream HTTP ${resp.status}`, type: 'upstream_error' } }));
          return 'fatal_client';
        }
        return `notion upstream ${resp.status}`;
      }
    } catch (err) {
      recordFailure(ch, 'notion network: ' + (err.message || err));
      return 'network: ' + (err.message || err);
    }
  }

  // 3.5) 流内错误检测：Notion 会返回 200 但在 NDJSON 里带 error 事件（temporarily-unavailable 等）
  const streamError = (ndjsonText.match(/"type":"error","message":"([^"]{0,120})/) || [])[1]
    || (ndjsonText.match(/"subType":"([^"]+)"/) || [])[1];
  if (streamError) {
    recordFailure(ch, 'notion stream: ' + streamError);
    // soft-block（temporarily-unavailable）按上游失败处理，让调度器切别的渠道
    return 'notion stream: ' + streamError;
  }
  if (!ndjsonText.trim()) {
    recordFailure(ch, 'notion stream: empty');
    return 'notion stream: empty';
  }

  // 成功
  ch.consecutiveFail = 0;
  ch.cooldownUntil = 0;
  ch.lastError = null;
  if (ch.status === 'down' || ch.status === 'unknown') ch.status = 'ok';
  ch.latencyMs = Date.now() - t0;

  // 真实对话消耗了额度 → 异步刷新用量（免费接口，不阻塞响应，失败静默）
  try {
    notion.notionUsageEligibility(ch.def.baseUrl, ch.def.apiKey, acct, fetch, 8000)
      .then((u) => {
        if (ch.notion) ch.notion.usage = { type: u.type, eligible: u.isEligible, userUsage: u.userUsage, userLimit: u.userLimit, at: Date.now() };
      })
      .catch(() => {});
  } catch { /* 不影响主流程 */ }

  // 4) 解析 NDJSON → OpenAI chunk
  const respId = 'chatcmpl-notion-' + Date.now().toString(36);

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-ZZCSAPI-Channel': candidate.channelId,
    });
    let fullText = '';
    let finalText = '';
    let firstChunkSent = false;
    const parser = notion.createNotionStreamParser((evt) => {
      if (evt.type === 'content') {
        if (!firstChunkSent) { firstChunkSent = true; res.write(notionSSEChunk(respId, displayModel, { role: 'assistant', content: '' })); }
        fullText += evt.text; res.write(notionSSEChunk(respId, displayModel, { content: evt.text }));
      } else if (evt.type === 'thinking') {
        if (!firstChunkSent) { firstChunkSent = true; res.write(notionSSEChunk(respId, displayModel, { role: 'assistant', content: '' })); }
        res.write(notionSSEChunk(respId, displayModel, { reasoning_content: evt.text }));
      } else if (evt.type === 'final') { finalText = evt.text; }
    });
    for (const ln of ndjsonText.split('\n')) parser.line(ln);

    // 权威全文兜底：流里没采到 content → 用 record-map 的 final 补齐
    if (!fullText.trim() && finalText) {
      if (!firstChunkSent) res.write(notionSSEChunk(respId, displayModel, { role: 'assistant', content: '' }));
      res.write(notionSSEChunk(respId, displayModel, { content: finalText }));
      fullText = finalText;
    }
    // 收尾 chunk
    res.write(notionSSEChunk(respId, displayModel, {}));
    res.write(`data: ${JSON.stringify({ id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: displayModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    const inTok = estimateTokens(messagesText(body.messages));
    recordUsage({ model: displayModel, channelId: candidate.channelId, kind: opts.kind, inputTokens: inTok, outputTokens: estimateTokens(fullText), ok: true, latencyMs: Date.now() - t0 });
    return 'success';
  }

  // 非流式：聚合全文
  let contentText = '';
  let reasoningText = '';
  let finalText = '';
  const parser = notion.createNotionStreamParser((evt) => {
    if (evt.type === 'content') contentText += evt.text;
    else if (evt.type === 'thinking') reasoningText += evt.text;
    else if (evt.type === 'final') finalText = evt.text;
  });
  for (const ln of ndjsonText.split('\n')) parser.line(ln);
  const reply = contentText.trim() ? contentText : (finalText || '');
  const inTok = estimateTokens(messagesText(body.messages));
  const outTok = estimateTokens(reply + (reasoningText ? ' ' + reasoningText : ''));
  recordUsage({ model: displayModel, channelId: candidate.channelId, kind: opts.kind, inputTokens: inTok, outputTokens: outTok, ok: true, latencyMs: Date.now() - t0 });
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-ZZCSAPI-Channel': candidate.channelId });
  res.end(JSON.stringify({
    id: respId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: displayModel,
    choices: [{ index: 0, message: { role: 'assistant', content: reply, ...(reasoningText ? { reasoning_content: reasoningText } : {}) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  }));
  return 'success';
}

function recordFailure(ch, msg) {
  ch.consecutiveFail++;
  ch.lastError = msg;
  ch.cooldownUntil = Date.now() + Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail));
  if (ch.consecutiveFail >= 3) ch.status = 'down';
  // 失败也进用量统计（ok:false），便于排查"哪个渠道在挂"
  try {
    recordUsage({ model: '—', channelId: ch.def.id, kind: 'error', inputTokens: 0, outputTokens: 0, ok: false, latencyMs: 0, note: String(msg).slice(0, 200) });
  } catch { /* ignore */ }
}

// ─────────────────────────── 启动 ───────────────────────────
server.listen(PORT, process.env.ZZCSAPI_BIND || '127.0.0.1', () => {
  console.log(`[zzcsapi] listening on http://127.0.0.1:${PORT}`);
  console.log(`[zzcsapi] auth: gateway=${GATEWAY_KEY ? 'on' : 'off'} admin=${ADMIN_KEY ? 'on' : 'off'}`);
  console.log(`[zzcsapi] channels: ${Array.from(channels.values()).map((c) => `${c.def.id}/${c.def.protocol}(${c.aliasMap.size})`).join(', ')}`);
  console.log(`[zzcsapi] aggregated: openai=[${aggregateModels('openai').join(', ')}] anthropic=[${aggregateModels('anthropic').join(', ')}] gemini=[${aggregateModels('gemini').join(', ')}]`);
});

process.on('SIGINT', () => { console.log('\n[zzcsapi] bye'); try { flushUsage(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { flushUsage(); } catch {} process.exit(0); });
