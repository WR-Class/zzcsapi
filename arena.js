// arena.js — Arena.ai 逆向协议模块
// 架构：网关进程内启动一个 headless Chromium（原生 CDP 控制，无 Playwright 依赖），
//       所有对 arena.ai 的请求都从这个真实浏览器页面内发起（同源 fetch）：
//       · 真实 Chrome TLS/HTTP2 指纹 → 天然过 Cloudflare（非浏览器指纹会被全站 403）
//       · 登录 cookie 由浏览器自己带 → 网关只需把分片 cookie 注入页面
//       · 会话续期：页面内 POST /nextjs-api/refresh 自动轮换 cookie，轮换结果回写 config.json
//       · 模型清单：从页面 SSR 数据 initialModels 直接提取（1052 个模型，含内部 id）
// 请求：POST /nextjs-api/stream/create-evaluation → 行流响应：
//       a0: 文本增量（JSON 转义字符串）/ ag: 思考增量 / ad: 完成 / a3: 错误 / a2: 心跳 / af: 元数据
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ARENA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const ARENA_ORIGIN = 'https://arena.ai';
const RECAPTCHA_SITEKEY = '6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0';
// profile 放本地临时目录（bind mount 的 Windows 卷上 Chromium profile 会因 SQLite 锁崩溃；
// cookie 由网关每次启动显式注入，profile 无需持久化）
const PROFILE_DIR = process.env.ZZCSAPI_ARENA_PROFILE || path.join(os.tmpdir(), 'zzcsapi-arena-profile');
// 远程 CDP 浏览器（网关容器 → 宿主机 Chrome）：容器内 Alpine Chromium 的 TLS 指纹会被
// arena.ai 的 Cloudflare 直接拦截（headless 也拦）；宿主机真 Chrome 与用户日常浏览器同款
// 二进制，CF 放行。Docker Desktop 的 host.docker.internal 中继可从容器直达宿主机端口。
const REMOTE_CDP_URL = process.env.ZZCSAPI_ARENA_CDP_URL || '';

// ─────────────────────────── 工具 ───────────────────────────

function uuidv7() {
  const ts = Date.now();
  const b = Buffer.alloc(16);
  b[0] = (ts / 2 ** 40) & 255; b[1] = (ts / 2 ** 32) & 255; b[2] = (ts / 2 ** 24) & 255;
  b[3] = (ts / 2 ** 16) & 255; b[4] = (ts / 2 ** 8) & 255; b[5] = ts & 255;
  b[6] = 0x70 | (Math.floor(Math.random() * 16) & 0x0f);
  b[7] = Math.floor(Math.random() * 256);
  b[8] = 0x80 | (Math.floor(Math.random() * 64) & 0x3f);
  for (let i = 9; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// 多轮消息 → arena 单条 userMessage.content
// 格式对齐 OmniRoute lmarena executor（live-smoke 验证过）：
//   单条用户消息 → 纯文本直出；多轮 → "System:/User:/Assistant:" 标签行 + 空行分隔
function buildArenaContent(messages) {
  const src = Array.isArray(messages) ? messages : [];
  const rendered = [];
  for (const m of src) {
    let text = '';
    if (m && typeof m.content === 'string') text = m.content;
    else if (m && Array.isArray(m.content)) {
      text = m.content.map((p) => {
        if (typeof p === 'string') return p;
        if (p && p.type === 'text') return p.text || '';
        if (p && p.type === 'image_url') return '[image]';
        return '';
      }).filter(Boolean).join('\n');
    }
    text = String(text || '').trim();
    if (!text) continue;
    const role = typeof (m && m.role) === 'string' ? m.role : 'user';
    const label = role === 'system' ? 'System' : role === 'assistant' ? 'Assistant' : role === 'developer' ? 'Developer' : 'User';
    rendered.push(`${label}: ${text}`);
  }
  if (rendered.length === 1 && src.length === 1 && src[0] && src[0].role === 'user') {
    const c = src[0].content;
    return String(typeof c === 'string' ? c : rendered[0].slice('User: '.length)).trim();
  }
  return rendered.join('\n\n');
}

function buildArenaPayload(modelAId, content) {
  // mode 必须是 'direct-battle'（'direct' 报 "'direct' mode is not allowed when
  // starting a new conversation"）；modelB* 字段不发送（OmniRoute 实测负载不含）
  return {
    id: uuidv7(),
    mode: 'direct-battle',
    modelAId,
    userMessageId: uuidv7(),
    modelAMessageId: uuidv7(),
    userMessage: { content, experimental_attachments: [], metadata: {} },
    modality: 'chat',
    recaptchaV3Token: null,
  };
}

// ─────────────────────────── 流解析器 ───────────────────────────
// AI SDK 行格式：[participant]code:value，participant ∈ {a,b}，code ∈ {0,g,2,3,d,f}
//   0 → 文本增量；g → 思考增量；2 → 心跳；3 → 错误；d → 完成(finishReason=error 则错误)
//   ae: → 旧平台错误格式（对齐 OmniRoute lmarena/stream.ts 语义）
// 返回事件：{type:'content'|'thinking'|'final'|'error'|'heartbeat', text}

function createArenaStreamParser(onEvent) {
  let buf = '';
  function unquote(v) {
    try { return JSON.parse(v); } catch { return v; }
  }
  function pickString(v) {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      for (const k of ['error', 'message', 'text', 'textDelta']) {
        if (typeof v[k] === 'string') return v[k];
      }
      return '';
    }
    return String(v || '');
  }
  function line(ln) {
    if (!ln) return;
    let payload = ln.trim();
    if (!payload) return;
    if (payload.startsWith('data: ')) payload = payload.slice(6).trim();
    if (!payload) return;
    // 旧平台错误 ae:
    let m = payload.match(/^[ab]e:(.*)$/);
    if (m) {
      const s = pickString(unquote(m[1] || ''));
      if (s) onEvent({ type: 'error', text: String(s).slice(0, 300) });
      return;
    }
    // 归一化 participant 前缀：a0: / b0: → 0:
    m = payload.match(/^([ab])([023dfg]):(.*)$/);
    if (m) payload = m[2] + ':' + m[3];
    const i = payload.indexOf(':');
    if (i <= 0) return;
    const code = payload.slice(0, i);
    const val = payload.slice(i + 1);
    if (code === '0') {
      const t = pickString(unquote(val));
      if (t) onEvent({ type: 'content', text: t });
    } else if (code === 'g') {
      const v = unquote(val);
      const t = typeof v === 'string' ? v : String((v && (v.thinking || v.text || v.textDelta)) || '');
      if (t) onEvent({ type: 'thinking', text: t });
    } else if (code === '2') {
      onEvent({ type: 'heartbeat' });
    } else if (code === '3') {
      const msg = pickString(unquote(val)) || String(val).slice(0, 300);
      onEvent({ type: 'error', text: String(msg).slice(0, 300) });
    } else if (code === 'd') {
      let v = null;
      try { v = JSON.parse(val); } catch {}
      if (v && typeof v === 'object' && v.finishReason === 'error') {
        onEvent({ type: 'error', text: 'Arena stream finished with an error' });
      } else {
        onEvent({ type: 'final' });
      }
    }
    // f → 元数据，忽略
  }
  return {
    push(chunk) {
      buf += chunk;
      let n;
      while ((n = buf.indexOf('\n')) >= 0) { line(buf.slice(0, n).replace(/\r$/, '')); buf = buf.slice(n + 1); }
    },
    end() { line(buf.replace(/\r$/, '')); buf = ''; },
  };
}

// ─────────────────────────── 页面内脚本（toString 序列化，避免转义地狱） ───────────────────────────

// 聊天请求：页面内 fetch + 流式读取，每块通过 window.__arenaChunk 绑定回传 Node
function pageChatScript() {
  return (async () => {
    const p = window.__zzArenaPayload;
    if (!p) return JSON.stringify({ status: 0, errText: 'payload missing' });
    window.__zzArenaAbort = false;
    // reCAPTCHA Enterprise token：GPT 系模型无 token 会 403 "recaptcha validation failed"
    // 页面未预载 enterprise.js 时动态注入再取 token（best-effort，取不到照发）
    let token = null;
    try {
      const SITEKEY = '6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0';
      if (!window.grecaptcha || !window.grecaptcha.enterprise) {
        await new Promise((resolve) => {
          const s = document.createElement('script');
          s.src = 'https://www.google.com/recaptcha/enterprise.js?render=' + SITEKEY;
          s.onload = resolve; s.onerror = resolve;
          document.head.appendChild(s);
          setTimeout(resolve, 6000);
        });
        await new Promise((r) => setTimeout(r, 300));
      }
      if (window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.execute) {
        await new Promise((r) => { try { window.grecaptcha.enterprise.ready(r); } catch (e) { r(); } });
        token = await window.grecaptcha.enterprise.execute(SITEKEY, { action: 'chat_submit' });
      }
    } catch (e) {}
    if (token) p.recaptchaV3Token = token;
    window.__zzArenaToken = token ? 'minted' : 'missing'; // 诊断标记
    let r;
    try {
      r = await fetch('/nextjs-api/stream/create-evaluation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(p),
        credentials: 'include',
      });
    } catch (e) {
      return JSON.stringify({ status: 0, errText: 'fetch: ' + String(e && e.message || e) });
    }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return JSON.stringify({ status: r.status, errText: String(t).slice(0, 500) });
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let n = 0;
    while (true) {
      if (window.__zzArenaAbort) { try { await reader.cancel(); } catch (e) {} break; }
      const { done, value } = await reader.read();
      if (done) break;
      const text = dec.decode(value, { stream: true });
      if (text) { n++; window.__arenaChunk(text); }
    }
    return JSON.stringify({ status: r.status, ok: true, chunks: n });
  })();
}

// 模型注册表：扫描页面 script 标签里的 initialModels（RSC 数据）
function pageRegistryScript() {
  return (() => {
    try {
      let all = '';
      for (const s of document.querySelectorAll('script')) all += (s.textContent || '') + '\n';
      all = all.replace(/\\"/g, '"');
      const key = '"initialModels":';
      const at = all.indexOf(key);
      if (at < 0) return JSON.stringify({ ok: false, error: 'initialModels not found' });
      const start = all.indexOf('[', at);
      let depth = 0, i = start, inStr = false, esc = false;
      for (; i < all.length; i++) {
        const ch = all[i];
        if (esc) { esc = false; continue; }
        if (inStr && ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '[' || ch === '{') depth++;
        else if (ch === ']' || ch === '}') { depth--; if (depth === 0) { i++; break; } }
      }
      const arr = JSON.parse(all.slice(start, i));
      const out = [];
      for (const m of (arr || [])) {
        if (!m || !m.id) continue;
        out.push({
          id: m.id,
          displayName: m.displayName || '',
          name: m.name || '',
          publicName: m.publicName || '',
          rank: typeof m.rank === 'number' ? m.rank : null,
          userSelectable: m.userSelectable,
          capabilities: m.capabilities || null,
        });
      }
      return JSON.stringify({ ok: true, models: out });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
  })();
}

// 会话续期：POST /nextjs-api/refresh（浏览器自动应用 set-cookie 轮换）
function pageRefreshScript() {
  return (async () => {
    try {
      const r = await fetch('/nextjs-api/refresh', { method: 'POST', credentials: 'include' });
      await r.text().catch(() => '');
      return JSON.stringify({ status: r.status });
    } catch (e) { return JSON.stringify({ status: 0, err: String(e && e.message || e) }); }
  })();
}

function pageCookieScript() {
  return document.cookie;
}

// ─────────────────────────── CDP 客户端（零依赖，用内置 WebSocket） ───────────────────────────

class Cdp {
  constructor() { this.nextId = 1; this.pending = new Map(); this.handlers = new Map(); this.ws = null; this.closed = false; }
  connect(wsUrl, timeoutMs) {
    return new Promise((resolve, reject) => {
      const WS = globalThis.WebSocket;
      if (!WS) return reject(new Error('global WebSocket unavailable (need Node >= 22)'));
      const ws = new WS(wsUrl);
      this.ws = ws;
      const to = setTimeout(() => reject(new Error('cdp connect timeout')), timeoutMs || 10000);
      ws.addEventListener('open', () => { clearTimeout(to); resolve(); });
      ws.addEventListener('error', (e) => { clearTimeout(to); reject(new Error('cdp ws error')); });
      ws.addEventListener('close', () => { this.closed = true; for (const p of this.pending.values()) p.reject(new Error('cdp closed')); this.pending.clear(); });
      ws.addEventListener('message', (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.method + ': ' + (m.error.message || m.error.code)));
          else p.resolve(m.result);
        } else if (m.method) {
          const list = this.handlers.get(m.method);
          if (list) for (const fn of list) { try { fn(m.params, m.sessionId); } catch {} }
        }
      });
    });
  }
  send(method, params, sessionId) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('cdp not connected'));
    const id = this.nextId++;
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(msg)); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  close() { try { this.ws && this.ws.close(); } catch {} this.closed = true; }
}

// ─────────────────────────── Chromium 探测 ───────────────────────────

function findChromium() {
  if (process.env.ZZCSAPI_CHROMIUM && fs.existsSync(process.env.ZZCSAPI_CHROMIUM)) return process.env.ZZCSAPI_CHROMIUM;
  const cands = [];
  if (process.platform === 'win32') {
    // Chrome 优先：reCAPTCHA v3 对 Google Chrome 的信号收集更深（Edge headless 下
    // mint 的 token 会被 arena 服务端判 "recaptcha validation failed"，GPT 系模型被拦）
    cands.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    );
  } else {
    cands.push('/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium');
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

// ─────────────────────────── Arena sidecar ───────────────────────────

class ArenaSidecar {
  constructor() {
    this.proc = null;
    this.cdp = null;
    this.sessionId = null;
    this.targetId = null;
    this.profileDir = null;
    this.starting = null;     // 启动互斥
    this.chatLock = Promise.resolve(); // 聊天串行互斥
    this.cookieString = '';   // 当前页面已注入的 cookie（检测 config 更新）
    this.registry = null;     // {byName: Map, count, at}
    this.lastReadyAt = 0;
    this.refreshTimer = null;
    this.onPersist = null;    // server 注入的持久化回调 (cookieString) => void
  }

  log(...a) { try { console.log('[arena]', ...a); } catch {} }

  // 完整启动链：浏览器 → 标签页 → cookie 注入 → 导航 → 模型注册表
  async ensure(cookieString, opts) {
    if (this.starting) return this.starting;
    this.starting = this._ensure(cookieString, opts).finally(() => { this.starting = null; });
    return this.starting;
  }

  async _ensure(cookieString, opts) {
    opts = opts || {};
    const needRestart = !this.proc || this.proc.exitCode !== null || !this.cdp || this.cdp.closed;
    if (needRestart) {
      // 优先远程 CDP（宿主机真 Chrome）；失败再退回本地 spawn（Windows 开发环境可用）
      if (REMOTE_CDP_URL) {
        try { await this._connectRemote(); } catch (e) { this.log('remote cdp fail, fallback spawn:', e.message); }
      }
      if (!this.cdp || this.cdp.closed) await this._startBrowser(opts);
      await this._attachPage();
      this.cookieString = '';
    }
    // cookie 变更（用户重新上传了登录凭据）→ 重新注入 + 刷新页面
    if (cookieString && cookieString !== this.cookieString) {
      await this._setCookies(cookieString);
      this.cookieString = cookieString;
      await this._navigate();
    }
    // 页面注册表缺失 / 过期（1 小时）
    const regFresh = this.registry && (Date.now() - this.registry.at < 3600_000);
    if (!regFresh) await this._loadRegistry();
    // 定时续期（20 分钟一次）
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => { this._tick().catch(() => {}); }, 20 * 60_000);
      this.refreshTimer.unref();
    }
    return this.registry;
  }

  // 连接宿主机 Chrome 的远程 CDP（HTTP /json/version → webSocketDebuggerUrl）
  async _connectRemote() {
    const ver = await fetch(REMOTE_CDP_URL + '/json/version', { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    const raw = ver.webSocketDebuggerUrl || '';
    if (!raw) throw new Error('no webSocketDebuggerUrl');
    // ws 地址里的 127.0.0.1 对容器不可达 → 替换成 REMOTE_CDP_URL 的 host
    const remoteHost = new URL(REMOTE_CDP_URL).host;
    const wsUrl = raw.replace(/ws:\/\/[^/]+/, 'ws://' + remoteHost);
    this.cdp = new Cdp();
    await this.cdp.connect(wsUrl, 10000);
    // 假 proc（远程模式无子进程；exitCode 恒 null → 不触发重启链）
    this.proc = { exitCode: null, kill: () => {}, on: () => {}, stderr: { removeAllListeners: () => {}, on: () => {} } };
    this.log('remote cdp connected:', wsUrl);
    // 清理上次网关运行残留的 arena 标签页
    try {
      const { targetInfos } = await this.cdp.send('Target.getTargets', {});
      for (const t of targetInfos || []) {
        if (t.url && t.url.startsWith('https://arena.ai')) {
          try { await this.cdp.send('Target.closeTarget', { targetId: t.targetId }); } catch {}
        }
      }
    } catch {}
  }

  async _startBrowser(opts) {
    const exe = findChromium();
    if (!exe) throw new Error('Chromium not found (set ZZCSAPI_CHROMIUM)');
    this.profileDir = this.profileDir || PROFILE_DIR;
    fs.mkdirSync(this.profileDir, { recursive: true });
    // headful 模式：reCAPTCHA v3 对 headless 页面行为评分低 → arena GPT 系模型 403
    // （headful 真实窗口 + CDP 行为预热的 token 可通过服务端校验）
    const headful = process.env.ZZCSAPI_ARENA_HEADFUL === '1';
    const args = [
      ...(headful ? [] : ['--headless=new']),
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
      // 反无头检测：UA 覆盖（默认 HeadlessChrome UA 会被 Cloudflare 直接拦截）+ 去 webdriver 特征
      `--user-agent=${ARENA_UA}`,
      '--disable-blink-features=AutomationControlled',
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profileDir}`,
      ...(headful ? ['--window-size=1280,860', '--app=about:blank'] : ['about:blank']),
    ];
    this.log('launch chromium:', exe, headful ? '(headful)' : '(headless)');
    this.proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((resolve, reject) => {
      let acc = '';
      const to = setTimeout(() => reject(new Error('chromium start timeout (no devtools ws)')), 20000);
      this.proc.stderr.on('data', (d) => {
        acc += d.toString();
        const m = acc.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(to); resolve(m[1]); }
      });
      this.proc.on('exit', (code) => { clearTimeout(to); reject(new Error('chromium exited early: ' + code)); });
    });
    this.proc.stderr.removeAllListeners('data');
    this.proc.removeAllListeners('exit');
    this.proc.on('exit', () => { this.log('chromium exited'); try { this.cdp && this.cdp.close(); } catch {} this.cdp = null; });
    this.cdp = new Cdp();
    await this.cdp.connect(wsUrl, 10000);
  }

  async _attachPage() {
    const cdp = this.cdp;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.targetId = targetId;
    this.sessionId = sessionId;
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Runtime.addBinding', { name: '__arenaChunk' }, sessionId);
    // navigator.userAgent / userAgentData 层面也覆盖（--user-agent 只改 HTTP 头）
    try {
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: ARENA_UA,
        platform: 'Win32',
        userAgentMetadata: {
          brands: [
            { brand: 'Chromium', version: '146' },
            { brand: 'Not.A/Brand', version: '99' },
          ],
          fullVersion: '146.0.0.0',
          platform: 'Windows',
          platformVersion: '15.0.0',
          architecture: 'x86',
          model: '',
          mobile: false,
          bitness: '64',
          wow64: false,
        },
      }, sessionId);
    } catch (e) { this.log('UA override fail:', e.message); }
  }

  async _setCookies(cookieString) {
    const sid = this.sessionId;
    for (const kv of String(cookieString || '').split('; ')) {
      const i = kv.indexOf('=');
      if (i < 0) continue;
      const name = kv.slice(0, i), value = kv.slice(i + 1);
      if (!value) continue;
      try {
        await this.cdp.send('Network.setCookie', {
          name, value, domain: 'arena.ai', path: '/',
          secure: true, httpOnly: false, sameSite: 'Lax',
        }, sid);
      } catch (e) { this.log('setCookie fail', name, e.message); }
    }
  }

  async _navigate(timeoutMs) {
    const sid = this.sessionId;
    const loaded = new Promise((resolve) => {
      const to = setTimeout(() => { this.cdp.handlers.delete('Page.loadEventFired'); resolve(); }, timeoutMs || 45000);
      this.cdp.on('Page.loadEventFired', () => { clearTimeout(to); resolve(); });
    });
    await this.cdp.send('Page.navigate', { url: ARENA_ORIGIN + '/?mode=direct' }, sid);
    await loaded;
    await new Promise((r) => setTimeout(r, 2500)); // RSC hydration + grecaptcha 加载
  }

  async _evaluate(expression, awaitPromise, timeoutMs) {
    const sid = this.sessionId;
    const r = await this.cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: !!awaitPromise,
      returnByValue: true,
      timeout: timeoutMs || 300000, // evaluate 自身超时
    }, sid);
    if (r.exceptionDetails) {
      throw new Error('page eval exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300));
    }
    return r.result && r.result.value;
  }

  async _loadRegistry() {
    const navT0 = Date.now();
    await this._navigate(); // 保证新页面（含最新 initialModels + 会话自动续期）
    const raw = await this._evaluate(`(${pageRegistryScript.toString()})()`, false, 30000);
    const j = safeParseJson(raw);
    if (!j || !j.ok) {
      // 失败诊断：页面实际加载成了什么
      try {
        const url = await this._evaluate('location.href', false, 5000);
        const title = await this._evaluate('document.title', false, 5000);
        const scripts = await this._evaluate('document.querySelectorAll("script").length', false, 5000);
        const bodySnippet = await this._evaluate('document.body ? document.body.innerText.slice(0, 200) : "(no body)"', false, 5000);
        this.log('registry FAIL diag:', JSON.stringify({
          navMs: Date.now() - navT0,
          url: String(url), title: String(title), scripts: Number(scripts),
          body: String(bodySnippet).replace(/\n+/g, ' | ').slice(0, 180),
        }));
      } catch (e) { this.log('registry FAIL diag err:', e.message); }
      throw new Error('registry: ' + ((j && j.error) || 'invalid'));
    }
    const byName = new Map();
    for (const m of j.models) {
      const key = String(m.displayName || m.publicName || '').toLowerCase().trim();
      if (!key || byName.has(key)) continue;
      if (m.userSelectable === false) continue;
      byName.set(key, m);
    }
    this.registry = { byName, count: j.models.length, at: Date.now() };
    this.log('registry loaded:', this.registry.count, 'models,', byName.size, 'unique names');
  }

  // 周期续期：页面内调 /nextjs-api/refresh → 轮换后的 cookie 回写 config
  async _tick() {
    if (!this.cdp || this.cdp.closed) return;
    try {
      const raw = await this._evaluate(`(${pageRefreshScript.toString()})()`, true, 30000);
      const j = safeParseJson(raw);
      if (j && (j.status === 200 || j.status === 0)) {
        await this._persistCookies();
      }
    } catch { /* 静默 */ }
  }

  async _persistCookies() {
    if (!this.onPersist) return;
    const cookie = await this._evaluate(`(${pageCookieScript.toString()})()`, false, 10000);
    const keep = [];
    for (const kv of String(cookie || '').split('; ')) {
      const i = kv.indexOf('=');
      if (i < 0) continue;
      const name = kv.slice(0, i), val = kv.slice(i + 1);
      if ((name === 'arena-auth-prod-v1.0' || name === 'arena-auth-prod-v1.1') && val) keep.push(name + '=' + val);
    }
    if (keep.length >= 2) {
      const s = keep.join('; ');
      if (s !== this.cookieString) {
        this.cookieString = s;
        try { this.onPersist(s); } catch {}
      }
    }
  }

  // ── 聊天主入口（串行互斥） ──
  // opts: {payload, onChunk(text), firstChunkTimeoutMs, onFirstChunk}
  // 返回 {ok, status, errText, chunks}
  // 行为预热：reCAPTCHA v3 按行为信号评分，无交互的 headless 页面分数低 → GPT 系模型 403。
  // 用 CDP Input 事件（isTrusted:true，评分器认可）模拟鼠标轨迹 + 滚动，积累信号后再取 token。
  async _warmup(durMs) {
    const sid = this.sessionId;
    const steps = Math.max(6, Math.floor((durMs || 2500) / 120));
    try {
      for (let i = 0; i < steps; i++) {
        const x = 80 + Math.floor(Math.random() * 800);
        const y = 80 + Math.floor(Math.random() * 500);
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse',
        }, sid).catch(() => {});
        if (i % 5 === 4) {
          await this.cdp.send('Input.synthesizeScrollGesture', {
            x: 400, y: 300, xDistance: 0, yDistance: -60 - Math.floor(Math.random() * 90), speed: 800,
          }, sid).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 90 + Math.floor(Math.random() * 120)));
      }
    } catch {}
  }

  async chat(opts) {
    const run = this._chatLocked(opts);
    // 排队：后续请求等待前一个完成
    const p = this.chatLock.then(() => run);
    this.chatLock = p.catch(() => {});
    return p;
  }

  async _chatLocked(opts) {
    const { payload, onChunk, firstChunkTimeoutMs, onFirstChunk } = opts;
    const sid = this.sessionId;
    await this._warmup(2500); // 行为信号积累（真实 CDP 输入事件）
    // 大 JSON 负载分两步注入页面（存字符串 → 页面内 parse），避免表达式双重转义问题
    await this._evaluate(`window.__zzArenaData = ${JSON.stringify(JSON.stringify(payload))}`, false, 10000);
    await this._evaluate('window.__zzArenaPayload = JSON.parse(window.__zzArenaData)', false, 10000);

    let firstChunkSeen = false;
    let chunkResolve;
    const firstChunkPromise = new Promise((r) => { chunkResolve = r; });
    const bindingHandler = (params) => {
      if (params && typeof params.payload === 'string') {
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          try { onFirstChunk && onFirstChunk(); } catch {}
          try { chunkResolve(); } catch {}
        }
        try { onChunk && onChunk(params.payload); } catch {}
      }
    };
    this.cdp.on('Runtime.bindingCalled', bindingHandler);

    // 首块守门：在 evaluate 的 Promise 之外并行超时
    const gateMs = firstChunkTimeoutMs || 120000;
    const evalPromise = this._evaluate(`(${pageChatScript.toString()})()`, true, 600000);
    let result = null;
    let timedOut = false;
    try {
      result = await Promise.race([
        evalPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('zz-first-chunk-timeout')), gateMs)),
      ]);
    } catch (e) {
      if (String(e.message) === 'zz-first-chunk-timeout') {
        timedOut = true;
        // 通知页面中断 fetch 流
        try { await this.cdp.send('Runtime.evaluate', { expression: 'window.__zzArenaAbort = true', returnByValue: true }, sid); } catch {}
        try { await this.cdp.send('Runtime.terminateExecution', {}, sid); } catch {}
      } else throw e;
    } finally {
      const list = this.cdp.handlers.get('Runtime.bindingCalled') || [];
      const idx = list.indexOf(bindingHandler);
      if (idx >= 0) list.splice(idx, 1);
      if (!firstChunkSeen) { try { chunkResolve(); } catch {} }
    }
    if (timedOut) return { ok: false, status: 0, errText: 'zz-first-chunk-timeout', chunks: 0 };
    const j = safeParseJson(result) || {};
    if (!j.ok) return { ok: false, status: j.status || 0, errText: j.errText || 'unknown arena error', chunks: j.chunks || 0 };
    // 成功后异步把轮换 cookie 回写 config
    this._persistCookies().catch(() => {});
    return { ok: true, status: j.status, errText: '', chunks: j.chunks || 0 };
  }

  stop() {
    try { if (this.refreshTimer) clearInterval(this.refreshTimer); } catch {}
    try { this.cdp && this.cdp.close(); } catch {}
    try { this.proc && this.proc.kill(); } catch {}
    this.proc = null; this.cdp = null;
  }
}

function safeParseJson(s) { try { return JSON.parse(s); } catch { return null; } }

// ─────────────────────────── 对外接口 ───────────────────────────

const sidecar = new ArenaSidecar();

// 解析模型：displayName（大小写不敏感）→ {id, displayName}
function resolveModelId(registry, displayName) {
  if (!registry) return null;
  const key = String(displayName || '').toLowerCase().trim();
  const hit = registry.byName.get(key);
  return hit ? { id: hit.id, displayName: hit.displayName } : null;
}

module.exports = {
  ARENA_UA,
  sidecar,
  buildArenaContent,
  buildArenaPayload,
  createArenaStreamParser,
  resolveModelId,
  uuidv7,
};
