// ZZCSAPI - 本地多渠道 OpenAI / Anthropic / Gemini 兼容聚合网关
// 用法：  1) node server.js                        （用 ./config.json）
//        2) DSH 模型地址填 http://127.0.0.1:8787/v1
// 目标：多渠道 API key 统一调度，失败自动切换，全失败才报错
// 依赖：仅 Node 18+ 内置模块（出站用自带 http/https 长连接客户端，见 zzFetch；不再依赖全局 fetch）

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { URL } = require('url');
const notion = require('./notion.js');
const notionAgent = require('./notion-agent.js');
const toolEmu = require('./tool-emu.js');
// Genspark 网页会话渠道常量：必须在启动探测路径（probeAll 在下方模块加载期同步触发）之前初始化，
// 放文件底部会因 const TDZ 使首轮探测静默失败
const crypto = require('crypto');
const GENSPARK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const GENSPARK_REFERER = 'https://www.genspark.ai/agents?type=ai_chat';

// ── 出站 HTTP 客户端（v1.16：零依赖替代全局 fetch）────────────────────────────
// 为什么换：Node 的全局 fetch 走 undici。同一台机器对同一回环目标实测——
//   容器内(Linux)  每跳 1.28ms vs keep-alive http.request 0.54ms（2.4×）；
//                  并发 32 的吞吐 881 vs 2012 req/s（只有 44%）；
//   Windows 开发机 每请求 +13ms（同项 http.request 0.6ms）。
// 网关的出站就在流式首字节路径上，所以这里换成 http/https + 长连接 Agent 的小客户端。
// 接口保持 fetch 形状（status/ok/headers.get/text/json/body.getReader + signal 中止），
// 调用点零改动；redirect 跟随、Content-Encoding 解压、AbortError 名称都按 fetch 对齐。
const zlib = require('zlib');
const OUT_HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 128 });
const OUT_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 128 });

function makeResponseLite(res, url) {
  const lower = {};
  for (const [k, v] of Object.entries(res.headers || {})) {
    lower[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  const enc = String(lower['content-encoding'] || '').toLowerCase();
  let stream = res;
  try {
    if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
    else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
    else if (enc.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());
  } catch { stream = res; }
  let textCache = null, consumed = false;
  // fetch 的 text() 语义：可重复调用（这里把首次结果缓存下来）
  const readAll = () => new Promise((resolve, reject) => {
    if (textCache !== null) return resolve(textCache);
    if (consumed) return resolve('');
    consumed = true;
    const bufs = [];
    stream.on('data', (c) => bufs.push(c));
    stream.on('end', () => { textCache = Buffer.concat(bufs).toString('utf8'); resolve(textCache); });
    stream.on('error', reject);
  });
  const body = {
    getReader() {
      consumed = true;
      let ended = false;
      const queue = [], waiters = [];
      const finish = () => { ended = true; while (waiters.length) waiters.shift()({ done: true, value: undefined }); };
      stream.on('data', (c) => {
        const v = new Uint8Array(c);            // 复制一份：Buffer 可能来自共享池，不能外借
        const w = waiters.shift();
        w ? w({ done: false, value: v }) : queue.push(v);
      });
      stream.on('end', finish);
      stream.on('close', finish);
      stream.on('error', finish);
      return {
        read: () => (queue.length
          ? Promise.resolve({ done: false, value: queue.shift() })
          : ended ? Promise.resolve({ done: true, value: undefined }) : new Promise((r) => waiters.push(r))),
        cancel: async () => { try { stream.destroy(); } catch { /* 已关 */ } },
      };
    },
  };
  return {
    ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
    status: res.statusCode || 0,
    statusText: res.statusMessage || '',
    url,
    redirected: false,
    headers: {
      get: (k) => { const v = lower[String(k).toLowerCase()]; return v === undefined ? null : v; },
      has: (k) => lower[String(k).toLowerCase()] !== undefined,
      forEach: (cb) => { for (const [k, v] of Object.entries(lower)) cb(v, k); },
    },
    text: readAll,
    json: async () => JSON.parse(await readAll()),
    body,
  };
}

function zzFetch(urlStr, opts = {}) {
  const start = String(urlStr);
  const baseHeaders = {};
  for (const [k, v] of Object.entries(opts.headers || {})) if (v !== undefined && v !== null) baseHeaders[k] = String(v);
  const method0 = (opts.method || 'GET').toUpperCase();
  const bodyBuf = opts.body == null ? null : Buffer.from(String(opts.body), 'utf8');
  // undici 默认请求 gzip 并自动解压；这里先要明文，上游硬塞压缩体时按头解压（见 makeResponseLite）
  if (!Object.keys(baseHeaders).some((k) => k.toLowerCase() === 'accept-encoding')) baseHeaders['Accept-Encoding'] = 'identity';
  const maxHops = opts.redirect === 'manual' ? 0 : 5;

  // 每一跳单独算 Content-Length：302/303 跟随时会退化成 GET 且丢掉请求体，
  // 此时若还留着上一跳的 Content-Length，上游会一直等那几字节 —— 表现为请求挂死。
  const headersFor = (method, payload) => {
    const h = { ...baseHeaders };
    const has = (n) => Object.keys(h).some((k) => k.toLowerCase() === n);
    if (has('content-length')) return h;
    if (payload) h['Content-Length'] = String(payload.length);
    else if (method !== 'GET' && method !== 'HEAD') h['Content-Length'] = '0';
    return h;
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const send = (target, method, payload, hop) => {
      let tu;
      try { tu = new URL(target); } catch (e) { return done(reject, e); }
      const isTls = tu.protocol === 'https:';
      const req = (isTls ? https : http).request({
        protocol: tu.protocol,
        hostname: tu.hostname,
        port: tu.port || (isTls ? 443 : 80),
        path: tu.pathname + tu.search,
        method,
        headers: headersFor(method, payload),
        agent: isTls ? OUT_HTTPS_AGENT : OUT_HTTP_AGENT,
        servername: isTls ? tu.hostname : undefined,
      }, (res) => {
        const st = res.statusCode || 0;
        const loc = res.headers.location;
        if (loc && maxHops > 0 && st >= 300 && st < 400 && hop < maxHops) {
          res.resume();
          const keepMethod = st === 307 || st === 308;   // 与 fetch 一致：其它 3xx 退化成 GET
          let next;
          try { next = new URL(loc, tu); } catch { return done(resolve, makeResponseLite(res, tu.href)); }
          return send(next.href, keepMethod ? method : 'GET', keepMethod ? payload : null, hop + 1);
        }
        done(resolve, makeResponseLite(res, tu.href));
      });
      req.on('error', (err) => {
        if (opts.signal && opts.signal.aborted) return done(reject, Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        done(reject, err);
      });
      if (opts.signal) {
        if (opts.signal.aborted) { try { req.destroy(); } catch { } return done(reject, Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })); }
        const onAbort = () => { try { req.destroy(); } catch { } done(reject, Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })); };
        opts.signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => { try { opts.signal.removeEventListener('abort', onAbort); } catch { } });
      } else {
        // 没有外部中止信号时留一条兜底，避免连接阶段永久挂住
        req.setTimeout(300_000, () => req.destroy(new Error('outbound timeout 300s')));
      }
      if (payload) req.end(payload); else req.end();
    };
    send(start, method0, bodyBuf, 0);
  });
}


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
// 密钥解析优先级：显式环境变量 > config.json 里首启生成的值 > 首启生成并写回 config.json。
// 生成动机：分发的部署不带公共默认密钥（compose 默认空），首启自动生成 48 位随机串、
// 打印一次到容器日志（能看到 docker logs 的人即主机主人），写入挂载的 config.json 以便重启不变。
const NOAUTH = process.env.ZZCSAPI_NOAUTH === '1';  // 本地开发：完全关闭鉴权
let GATEWAY_KEY = process.env.GATEWAY_KEY || ''; // 客户端调 /v1/* / /anthropic/* / /gemini/*
let ADMIN_KEY   = process.env.ADMIN_KEY   || ''; // 调 /admin/* + Web 控制台

/* 恒定时间比较：先 sha256 再 timingSafeEqual，长度不同的输入也不会抛异常、也不泄漏长度差异。
   （普通 === 的短路比较会随"前几个字符对上了"而变慢，理论上可被逐字节爆破；管理密钥就这么被保护的。）
   NOAUTH 模式下 need 为空串，此时任何输入都不匹配 —— 但 NOAUTH 在 checkAuth 开头就已整体放行。 */
function safeEqual(a, b) {
  const A = crypto.createHash('sha256').update(String(a == null ? '' : a), 'utf8').digest();
  const B = crypto.createHash('sha256').update(String(b == null ? '' : b), 'utf8').digest();
  return crypto.timingSafeEqual(A, B);
}

/* 管理面失败限流（v1.18.4）：只统计**失败**尝试，成功一次即清零。
   目的不是防"打不进来"（那是网络层的事），而是把"本地静态密钥 + 无失败计数"变成
   "每分钟最多 30 次瞎试"——离线爆破从"想试多少试多少"变成"需要一年"。
   刻意做成窗口式而非永久锁定：正密钥永远不受影响，也不存在把自己锁在门外的状态。 */
const AUTH_FAIL = { admin: { n: 0, until: 0 }, gateway: { n: 0, until: 0 } };
const AUTH_FAIL_MAX = 30;          // 每个窗口内允许的失败次数
const AUTH_FAIL_WINDOW_MS = 60000; // 窗口长度
function authThrottle(kind) {
  const st = AUTH_FAIL[kind];
  const now = Date.now();
  if (st.until > now) return Math.ceil((st.until - now) / 1000); // 命中限流，返回还需等待的秒数
  if (st.n >= AUTH_FAIL_MAX) { st.n = 0; st.until = now + AUTH_FAIL_WINDOW_MS; } // 攒够了，开始下一个窗口的静默期
  return 0;
}
function authFail(kind) {
  const st = AUTH_FAIL[kind];
  if (st.until <= Date.now()) st.n++;
}
function authOk(kind) { const st = AUTH_FAIL[kind]; st.n = 0; st.until = 0; }

/* ═══ 控制台会话（v1.18.6）═══════════════════════════════════════════════
   问题：管理密钥常驻浏览器 localStorage（任何 XSS 可读、即永久主钥匙），且 ?key= 会把密钥写进浏览器历史。
   处置：登录门把密钥交给 POST /admin/api/session **一次**，换回 HttpOnly + SameSite=Strict 的会话 cookie；
   之后管理面调用只带 cookie，真实密钥从浏览器里消失（JS 也读不到 HttpOnly cookie）。
   - 会话表在内存：重启即全部掉线需重新登录（本网关重启频繁，这是刻意接受的代价）。
   - TTL 12 小时；懒过期 + 周期清扫；上限 256 条（防爆内存）。
   - 轮换/重置管理密钥时整表清空（旧会话不该在换锁后继续开门）；发起轮换的浏览器由该次响应补发新会话。
   - 脚本仍可用 Bearer ADMIN_KEY 直连管理面（CI/curl 不受影响）——会话只为浏览器而生。 */
const SESSIONS = new Map();            // token -> expiresAt（插入序即新旧序）
const SESSION_TTL_MS = 12 * 3600 * 1000;
const SESSION_MAX = 256;
const SESSION_COOKIE = 'zz_session';
function newSessionToken() {
  if (SESSIONS.size >= SESSION_MAX) {  // 先清过期（免费腾位），不够再逐一个最旧的活会话——不过度逐人
    const now = Date.now();
    for (const [t, exp] of SESSIONS) {
      if (exp <= now) { SESSIONS.delete(t); if (SESSIONS.size < SESSION_MAX) break; continue; }
      SESSIONS.delete(t); break;
    }
  }
  const token = crypto.randomBytes(32).toString('hex');
  SESSIONS.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}
function sessionCookieValue(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  // 不加 Secure：本网关设计上就跑在 http 本地/局域网；加了 cookie 反而种不下去
}
function readSessionToken(req) {
  const c = req.headers.cookie;
  if (!c) return '';
  for (const part of c.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}
function sessionValid(req) {
  const t = readSessionToken(req);
  if (!t) return false;
  const exp = SESSIONS.get(t);
  if (!exp) return false;
  if (exp <= Date.now()) { SESSIONS.delete(t); return false; }  // 懒过期
  return true;
}
function clearSessions() { SESSIONS.clear(); }
setInterval(() => { const now = Date.now(); for (const [t, exp] of SESSIONS) if (exp <= now) SESSIONS.delete(t); }, 600000).unref();

function checkAuth(req, kind) {
  // kind: 'gateway' | 'admin'
  if (NOAUTH) return true;                            // 本地免鉴权（显式选择的开发模式）
  // NOAUTH 关闭时密钥恒非空（空则首启已生成，见 resolveGeneratedKeys），不再存在"没设置就放行"
  const need = kind === 'admin' ? ADMIN_KEY : GATEWAY_KEY;
  if (kind === 'admin' && sessionValid(req)) { authOk(kind); return true; }   // 浏览器会话 cookie（v1.18.6）
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m && safeEqual(m[1], need)) { authOk(kind); return true; }
  // 原生 SDK 兼容（仅 gateway 侧）：Gemini SDK 发 x-goog-api-key（其默认鉴权头，另一模式是 ?key=），
  // Anthropic SDK 发 x-api-key。不认这两个头 → 官方 SDK 直连一律 401（OpenAI SDK 走 Bearer 本来就通）。
  // 管理面不接受它们：admin 只能 Bearer 或会话 cookie，避免把客户端密钥语义混进管理面。
  if (kind !== 'admin') {
    if (req.headers['x-goog-api-key'] !== undefined && safeEqual(req.headers['x-goog-api-key'], need)) { authOk(kind); return true; }
    if (req.headers['x-api-key'] !== undefined && safeEqual(req.headers['x-api-key'], need)) { authOk(kind); return true; }
    // 兼容 ?key=...（仅 gateway：Gemini SDK 的另一默认鉴权模式）
    // v1.18.6 起管理面不再认 ?key=——那是渗透报告点名的"密钥进浏览器历史"残留面，浏览器改用会话 cookie
    const u = new URL(req.url, 'http://127.0.0.1');
    const qk = u.searchParams.get('key');
    if (qk !== null && safeEqual(qk, need)) { authOk(kind); return true; }
  }
  authFail(kind);
  return false;
}

/* 下发前掩码：管理面默认只给"能认出是哪把密钥"的程度，原文要靠按需揭示端点单取。 */
function maskSecret(k) {
  const s = String(k == null ? '' : k);
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return s.slice(0, 4) + '…' + s.slice(-4);
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
  // 空数组是**合法**配置：控制台把最后一个渠道删掉后 persistConfig 写回来的就是 `"channels": []`。
  // 以前这里要求 length > 0，于是"删光渠道 → 重启 → 起不来"（配置错误信息还会误导成文件损坏）。
  if (!Array.isArray(cfg.channels)) {
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
const RETRIES = config.retries || { perChannel: 0, maxModelFallbacks: 99 };

// ★ perChannel（v1.9.3 起真正接线，此前只读不用）＝ **同一个渠道**失败后原地再试几次，试完才换下一家。
//   语义钉死三条：① 只对"可重试的失败"生效（5xx / 网络错误 / 超时），4xx 一律不重试——重发同一个请求
//   只会再收一次同样的拒绝，该切下家就切；② 每次尝试都各记一次失败（recordFailure 在 tryChannel 内），
//   所以连败计数与指数退避按**真实尝试次数**增长，不被打折；③ 钳制 0..5，配置写错不该把上游调用量放大十倍。
//   注意默认值：配置里没有这个键时是 **0**（不重试 = 与接线前的行为一致），要重试必须显式写 ≥1。
const PER_CHANNEL_RETRIES = Math.max(0, Math.min(5, Math.floor(Number(RETRIES.perChannel) || 0)));

// ★ 熔断冷却（v1.10 起分级；此前是"一条公式复制 11 份"）＝ 连续失败后把这个渠道从候选链上挪开的时长。
//   两类真实世界的失败需要完全不同的耐心，混在一起用同一条 1s→60s 的曲线才是根本问题：
//     · transient（瞬时）：超时 / 5xx / 网络抖动——下一分钟可能就好了，起步 5s、封顶 10 分钟；
//     · credential（凭证/额度）：401 / 402 / 403、key 失效、余额耗尽——**一分钟内绝不可能自愈**，
//       起步 5 分钟、封顶 6 小时，别拿真流量一次次去撞墙（旧代码里手写的 300s 特例就是这个意思）；
//     · rate_limit（限流）：429——上游说了"别急"，起步 1 分钟；若它给了 Retry-After 就听它的（见主路径）。
//   曲线都按"连续失败次数"指数增长、各自封顶；次数由 recordFailure 统一维护，成功路径清零。
const COOLDOWN = (() => {
  const c = (config && config.cooldown) || {};
  const pick = (v, lo, hi, dflt) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, n)) : dflt;
  };
  return {
    transientBaseMs: pick(c.transientBaseMs, 1000, 300_000, 5_000),
    transientMaxMs: pick(c.transientMaxMs, 5_000, 86_400_000, 600_000),
    hardBaseMs: pick(c.hardBaseMs, 10_000, 86_400_000, 300_000),
    hardMaxMs: pick(c.hardMaxMs, 60_000, 604_800_000, 6 * 3600_000),
    rateLimitBaseMs: pick(c.rateLimitBaseMs, 1000, 86_400_000, 60_000),
  };
})();

// ─────────────────────────── 会话粘性（v1.17）───────────────────────────
// 做什么：同一条"会话"上的请求尽量落在**同一个上游渠道**上——上游侧因此可以复用提示缓存 /
// KV cache，订阅类上游也不会因为来回换家而反复触发风控（同类项目里 sub2api 与 CLIProxyAPI 都有）。
// 边界（刻意收窄，避免变成"悄悄绕过加权轮询"）：
//   · 只改**谁是第一位**：粘住的渠道不在候选里、在冷却里、或已 down 时，一切照旧（不硬塞）；
//   · 粘性命中**不消耗** SWRR 状态、也不记 weightedHits——权重份额统计反映的仍是轮询的分流，
//     不会被粘性流量污染（否则"权重没生效"这类假象会从统计里冒出来）；
//   · 默认**关闭**（enabled:false = 与老行为逐字节一致），配置里显式打开才生效。
// 会话键来源（按优先级，取不到就是"无粘性"，退回普通调度）：
//   ① 显式头 X-Session-Id / X-Claude-Code-Session-Id / X-Conversation-Id / X-ZZCSAPI-Session（≥8 字符）
//   ② 正文里的会话标识：prompt_cache_key（OpenAI 系客户端用来表达"这段前缀可缓存"）/
//      session_id / conversation_id
//   ③ 可选（deriveFromBody:true）："系统提示 + 首条用户消息"的稳定哈希——给不带任何会话标识的
//      客户端兜底。默认关闭：正文哈希会让**相同提示的不同请求**互相抢占同一家。
//   刻意**不**用 anthropic 的 metadata.user_id：Claude Code 带的是**账号级** id，
//   拿它做粘性等于把整个账号钉死在一家（那不是会话粘性，是把加权轮询关掉）。
// 把"从 config 算出运行期设置"抽成函数：启动路径与控制台保存路径**必须共用同一份**，
// 否则哪天两边各改一半，就会变成"控制台里存的是 A、重启后读的是 B"这种最难查的分叉。
function normAffinityCfg(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  const pickInt = (v, lo, hi, dflt) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, n)) : dflt;
  };
  return {
    enabled: c.enabled === true,
    ttlMs: pickInt(c.ttlSec, 30, 7 * 86_400, 3600) * 1000,
    maxEntries: pickInt(c.maxEntries, 16, 100_000, 2000),
    deriveFromBody: c.deriveFromBody === true,
  };
}
const AFFINITY_CFG = normAffinityCfg(config && config.sessionAffinity);
const AFFINITY = new Map();        // key → { channelId, ts }（Map 迭代序=插入序，淘汰最旧用）
const AFFINITY_STAT = { hits: 0, misses: 0, learned: 0, evicted: 0, expired: 0, reordered: 0 };
const AFFINITY_HEADERS = ['x-session-id', 'x-claude-code-session-id', 'x-conversation-id', 'x-zzcsapi-session'];

function affinityKeyFor(req, body, ignoreEnabled) {
  if (!ignoreEnabled && !AFFINITY_CFG.enabled) return '';
  const h = (req && req.headers) || {};
  for (const name of AFFINITY_HEADERS) {
    const v = h[name];
    if (v && String(v).trim().length >= 8) return 'h:' + name + ':' + String(v).trim().slice(0, 160);
  }
  const b = body || {};
  for (const [field, tag] of [['prompt_cache_key', 'pc'], ['session_id', 'sid'], ['conversation_id', 'cid']]) {
    const v = b[field];
    if (v && String(v).trim().length >= 8) return 'b:' + tag + ':' + String(v).trim().slice(0, 160);
  }
  if (AFFINITY_CFG.deriveFromBody) {
    const sys = (typeof b.system === 'string' ? b.system : '') || '';
    const first = (Array.isArray(b.messages) && b.messages.find((m) => m && m.role === 'user')) || null;
    const text = sys + '\u0000' + ((first && (typeof first.content === 'string' ? first.content
      : Array.isArray(first.content) ? first.content.map((p) => (p && (p.text || '')) || '').join('') : '')) || '');
    if (text.trim().length >= 32) {
      return 'b:hash:' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 20);
    }
  }
  return '';
}

// 取粘住的渠道；过期即丢（懒清理，不额外起定时器）
// 每个入口都再兜一次 enabled：关闭时"一个字节状态都不留"是这个特性最容易失守的地方
// （上层拿的是空键，但守卫不该只靠调用方——免得将来多一个调用点就把状态漏出来）
function affinitySticky(key) {
  if (!AFFINITY_CFG.enabled || !key) return '';
  const rec = AFFINITY.get(key);
  if (!rec) { AFFINITY_STAT.misses++; return ''; }
  if (Date.now() - rec.ts > AFFINITY_CFG.ttlMs) {
    AFFINITY.delete(key);
    AFFINITY_STAT.expired++;
    return '';
  }
  AFFINITY_STAT.hits++;
  return rec.channelId;
}

function affinityLearn(key, channelId) {
  if (!AFFINITY_CFG.enabled || !key || !channelId) return;
  if (!AFFINITY.has(key) && AFFINITY.size >= AFFINITY_CFG.maxEntries) {
    const oldest = AFFINITY.keys().next().value;
    if (oldest !== undefined) { AFFINITY.delete(oldest); AFFINITY_STAT.evicted++; }
  }
  AFFINITY.set(key, { channelId, ts: Date.now() });
  AFFINITY_STAT.learned++;
}

// 粘住的那家提到链首——只在"它确实还在候选里且可上场"时动手
function applyAffinity(list, key) {
  const sticky = affinitySticky(key);
  if (!sticky) return list;
  const now = Date.now();
  const idx = list.findIndex((c) => c.channelId === sticky && !(c.cooldownUntil > now) && c.status !== 'down');
  if (idx <= 0) return list;
  list.unshift(list.splice(idx, 1)[0]);
  AFFINITY_STAT.reordered++;
  return list;
}

function affinityStatus() {
  return { enabled: AFFINITY_CFG.enabled, ttlSec: AFFINITY_CFG.ttlSec, deriveFromBody: AFFINITY_CFG.deriveFromBody, entries: AFFINITY.size, ...AFFINITY_STAT };
}

// ─────────────────────────── 客户端限流（v1.17）───────────────────────────
// 做什么：给客户端面（/v1/*、/anthropic/*、/gemini/*）加**整机**速率与并发上限，
//   超限回 429 + Retry-After（而不是让上游先把额度烧完 / 让订阅号被风控）。
// 边界：
//   · 默认**关闭**（enabled:false），打开后才有行为；rpm=0 表示不限速率，maxConcurrent=0 表示不限并发；
//   · 令牌桶按**整机**算（本网关是单点自用定位，不需要按客户端分桶；分桶要有稳定的客户端标识才有意义）；
//   · 计数发生在**鉴权之前**：这样连"刷鉴权"的流量也被挡住（代价是未带密钥的请求也占额度，
//     这是刻意的取舍——宁可挡在门口，也不让无效流量穿到后面的候选链上）；
//   · 并发数在响应结束时归还（含客户端中断：挂 res 'close'，不依赖正常收尾）。
function normRateCfg(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  const int = (v, dflt) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  const rpm = int(c.rpm, 0);
  const burst = int(c.burst, 0);
  return {
    enabled: c.enabled === true,
    rpm,
    burst: burst > 0 ? burst : rpm,        // 默认桶容量 = 每分钟额度（允许"一分钟的量一次性打完"）
    maxConcurrent: int(c.maxConcurrent, 0),
  };
}
const RATE_CFG = normRateCfg(config && config.rateLimit);
const RATE_BUCKET = { tokens: 0, last: 0 };
const RATE_STAT = { inflight: 0, peakInflight: 0, limitedRate: 0, limitedConcurrent: 0, released: 0 };

function rateCheck() {
  if (!RATE_CFG.enabled) return { ok: true };
  const now = Date.now();
  if (RATE_CFG.rpm > 0) {
    const cap = RATE_CFG.burst;
    if (!RATE_BUCKET.last) { RATE_BUCKET.last = now; RATE_BUCKET.tokens = cap; }
    RATE_BUCKET.tokens = Math.min(cap, RATE_BUCKET.tokens + ((now - RATE_BUCKET.last) / 60000) * RATE_CFG.rpm);
    RATE_BUCKET.last = now;
    if (RATE_BUCKET.tokens < 1) {
      RATE_STAT.limitedRate++;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((1 - RATE_BUCKET.tokens) / RATE_CFG.rpm) * 60)) };
    }
    RATE_BUCKET.tokens -= 1;
  }
  if (RATE_CFG.maxConcurrent > 0 && RATE_STAT.inflight >= RATE_CFG.maxConcurrent) {
    RATE_STAT.limitedConcurrent++;
    return { ok: false, concurrent: true, retryAfterSec: 1 };
  }
  return { ok: true };
}

function rateAcquire() {
  RATE_STAT.inflight++;
  if (RATE_STAT.inflight > RATE_STAT.peakInflight) RATE_STAT.peakInflight = RATE_STAT.inflight;
}

function rateRelease() {
  if (RATE_STAT.inflight > 0) RATE_STAT.inflight--;
  RATE_STAT.released++;
}

function rateStatus() {
  return { enabled: RATE_CFG.enabled, rpm: RATE_CFG.rpm, burst: RATE_CFG.burst, maxConcurrent: RATE_CFG.maxConcurrent, tokens: Math.round(RATE_BUCKET.tokens * 100) / 100, ...RATE_STAT };
}

// ─────────────────────────── 指标（v1.17）───────────────────────────
// 做什么：把"现在到底什么情况"暴露成 Prometheus 文本格式（/metrics），不引入任何依赖。
// 口径说明：渠道维度用**渠道 id** 作标签（本机自用；控制台里显示的是 name）；
//   请求维度用"路由 + 最终状态码"；token 与延迟来自 recordUsage（真实对话与探测都走它）。
const METRICS = {
  startedAt: Date.now(),
  requests: new Map(),     // `${route}|${status}` → n
  channels: new Map(),     // channelId → { ok, fail, inTok, outTok, msSum, msCount, probes }
};

// 端点开关：默认**开**（本地自用，端点本身零成本、可用性信息本来就该拿得到），
// 但仍要 admin key；要放进 Prometheus 抓取（不带 Bearer）就显式写 metrics.public=true。
function normMetricsCfg(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  return {
    enabled: !(c.enabled === false),        // 默认开：唯一"默认开"的新开关（不配也能抓，且要 key）
    public: c.public === true,
  };
}
const METRICS_CFG = normMetricsCfg(config && config.metrics);

// ─────────────────────────── thinking 回放缓存（v1.18.8）───────────────────────────
// 做什么：Anthropic 同协议直通路径上，客户端把上一轮的 thinking 块**丢了 signature** 再送回来时
//   （部分开源 agent 框架重新序列化消息时会丢掉不认识的字段；Anthropic 规定回传的 thinking 块
//   必须带有效签名，否则 400），把网关记得的那枚**上游自己签的**签名补回去再转上游。
// 为什么现在做：v1.18 前置验证时判定"对本仓现有链路无收益"（跨协议路径根本不产出 thinking 块、
//   完好客户端走直通天然合法）；但项目开源给任意客户端用，"会弄丢签名的客户端"是真实存在的
//   受益人群（设计稿 §1.4 的重启前提），用户拍板为这类用户实现（设计稿 §9 第三次决策）。
// 边界（刻得越窄越好——这条缓存是全仓唯一一处"往用户请求里回写历史内容"的地方）：
//   · 只在 **Anthropic 客户端 → Anthropic 渠道（同协议直通）** 这一条路上学/修——
//     跨协议路径照旧整块丢弃 thinking（OpenAI 上游明确要求不回传 reasoning）；
//   · 只回放**上游自己签过的**签名：从不生成、从不猜测、从不跨渠道（签名与上游账号绑定，
//     渠道 A 的签名过不了渠道 B 的校验）；键 = 会话键 + 渠道 + 模型 + 块哈希，四元都不许跨；
//   · 取不到会话键就不回放（没有会话边界就没有安全边界）；会话键与粘性同一套推导但
//     **不受粘性开关牵连**（回放开、粘性关是完全合法的组合）；
//   · 请求里**没有缺签名的 thinking 块（或一条都没命中）就一个字节都不动**——
//     完好客户端的直通保真不变（修复只在"客户端已经弄坏了报文"的前提下出手）；
//   · 上游因签名问题回 4xx 时，这组会话/渠道/模型的记录立即作废（同一条坏记录不许反复引发 4xx）；
//   · 默认**关闭**（enabled:false = 零行为零状态，与 v1.17 三组开关同一风格）。
function normReplayCfg(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  const pickInt = (v, lo, hi, dflt) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, n)) : dflt;
  };
  return {
    enabled: c.enabled === true,
    ttlMs: pickInt(c.ttlSec, 30, 7 * 86_400, 3600) * 1000,
    maxEntries: pickInt(c.maxEntries, 16, 100_000, 2048),
  };
}
const REPLAY_CFG = normReplayCfg(config && config.thinkingReplay);
const REPLAY = new Map();    // `${sessionKey}|${channelId}|${model}|${sha1(thinking)前24位}` → { signature, ts }
const REPLAY_STAT = { learned: 0, hits: 0, misses: 0, evicted: 0, expired: 0, stale: 0 };

// 会话键与粘性同一套推导（显式头 → 正文标识 → 可选正文哈希），第三个参数跳过粘性开关的门槛
function replaySessionKeyFor(req, body) {
  if (!REPLAY_CFG.enabled) return '';
  return affinityKeyFor(req, body, true);
}

function replayBlockKey(sessionKey, channelId, model, thinking) {
  return `${sessionKey}|${channelId}|${String(model || '').toLowerCase().trim()}|${crypto.createHash('sha1').update(String(thinking)).digest('hex').slice(0, 24)}`;
}

// 学习：只存上游真签过的（没签名的存了也没用）；超限淘汰最旧（Map 迭代序=插入序）
function replayLearn(sessionKey, channelId, model, pairs) {
  if (!REPLAY_CFG.enabled || !sessionKey || !channelId || !Array.isArray(pairs)) return;
  for (const p of pairs) {
    if (!p || !p.thinking || !p.signature) continue;
    const k = replayBlockKey(sessionKey, channelId, model, p.thinking);
    if (!REPLAY.has(k) && REPLAY.size >= REPLAY_CFG.maxEntries) {
      const oldest = REPLAY.keys().next().value;
      if (oldest !== undefined) { REPLAY.delete(oldest); REPLAY_STAT.evicted++; }
    }
    REPLAY.set(k, { signature: String(p.signature), ts: Date.now() });
    REPLAY_STAT.learned++;
  }
}

// 查一枚签名：过期懒删（不额外起定时器）；命中/未命中都计数（长期 0 命中 = 该退役的信号）
function replaySignature(sessionKey, channelId, model, thinking) {
  if (!REPLAY_CFG.enabled) return '';
  const k = replayBlockKey(sessionKey, channelId, model, thinking);
  const rec = REPLAY.get(k);
  if (!rec) { REPLAY_STAT.misses++; return ''; }
  if (Date.now() - rec.ts > REPLAY_CFG.ttlMs) {
    REPLAY.delete(k);
    REPLAY_STAT.expired++;
    return '';
  }
  REPLAY_STAT.hits++;
  return rec.signature;
}

// 作废：上游因签名问题 4xx 后，这组会话/渠道/模型下的记录全部删除
function replayStale(sessionKey, channelId, model) {
  if (!REPLAY_CFG.enabled || !sessionKey) return;
  const prefix = `${sessionKey}|${channelId}|${String(model || '').toLowerCase().trim()}|`;
  for (const k of Array.from(REPLAY.keys())) {
    if (k.startsWith(prefix)) { REPLAY.delete(k); REPLAY_STAT.stale++; }
  }
}

// 修复入口：客户端原始报文的 assistant 消息里找「缺签名的 thinking 块」，命中缓存就补。
// 没有缺签名的块（或一条都没命中）返回 null —— 直通继续用原始报文，一个字段都不动。
function repairThinkingBody(sessionKey, channelId, model, raw) {
  if (!REPLAY_CFG.enabled || !sessionKey || !raw || typeof raw !== 'object' || !Array.isArray(raw.messages)) return null;
  let touched = 0;
  const messages = raw.messages.map((m) => {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) return m;
    const content = m.content.map((b) => {
      if (b && b.type === 'thinking' && b.thinking && !b.signature) {
        const sig = replaySignature(sessionKey, channelId, model, b.thinking);
        if (sig) { touched++; return { ...b, signature: sig }; }
      }
      return b;
    });
    return { ...m, content };
  });
  return touched ? { ...raw, messages } : null;
}

// 直通响应（Anthropic 报文）里的 thinking 对——只收「带签名的」
function thinkingPairsFromAnthropic(j) {
  if (!j || !Array.isArray(j.content)) return null;
  const out = [];
  for (const b of j.content) {
    if (b && b.type === 'thinking' && b.thinking && b.signature) out.push({ thinking: b.thinking, signature: b.signature });
  }
  return out.length ? out : null;
}

// 直通流式旁路扫描（与 usage 扫描同一个旁路位，不影响转发的字节）：
// content_block_start（thinking）→ thinking_delta / signature_delta 累积 → content_block_stop 收口；
// 没走到 stop 的块不收（上游截流时宁可不学，不学半截）。JSON 解析失败静默跳过（与 usage 扫描同款）。
function thinkingStreamScan(line, acc) {
  if (line.indexOf('content_block') < 0 && line.indexOf('_delta') < 0) return acc || null;
  const data = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
  if (!data || data === '[DONE]') return acc || null;
  let j; try { j = JSON.parse(data); } catch { return acc || null; }
  const out = acc || { open: new Map(), done: [] };
  const idx = Number(j.index);
  if (j.type === 'content_block_start' && j.content_block && j.content_block.type === 'thinking') {
    out.open.set(idx, { text: '', sig: '' });
  } else if (j.type === 'content_block_delta' && out.open.has(idx) && j.delta) {
    if (j.delta.type === 'thinking_delta' && j.delta.thinking) out.open.get(idx).text += j.delta.thinking;
    if (j.delta.type === 'signature_delta' && j.delta.signature) out.open.get(idx).sig = j.delta.signature;
  } else if (j.type === 'content_block_stop' && out.open.has(idx)) {
    const b = out.open.get(idx);
    out.open.delete(idx);
    if (b.text && b.sig) out.done.push({ thinking: b.text, signature: b.sig });
  }
  return out;
}

function replayStatus() {
  return { enabled: REPLAY_CFG.enabled, ttlSec: Math.round(REPLAY_CFG.ttlMs / 1000), maxEntries: REPLAY_CFG.maxEntries, entries: REPLAY.size, ...REPLAY_STAT };
}

// 运行期重新套用这四组设置（控制台保存后**立即生效**，不必重启）。
// 为什么值得做成热生效：限流/粘性/指标都是"调一下就想马上看效果"的旋钮，
// 要求重启容器才能验证，等于把试验成本抬到"每次都要断一次线上服务"。
// 注意只重算这四个收口常量，不碰渠道、不碰冷却、不碰 SWRR 状态、不碰 REPLAY 表内容（旋钮变了条目自然过期）。
function applyRuntimeSettings() {
  Object.assign(AFFINITY_CFG, normAffinityCfg(config && config.sessionAffinity));
  Object.assign(RATE_CFG, normRateCfg(config && config.rateLimit));
  Object.assign(METRICS_CFG, normMetricsCfg(config && config.metrics));
  Object.assign(REPLAY_CFG, normReplayCfg(config && config.thinkingReplay));
}

// 给控制台表单用的视图：raw 是"要回填进输入框的值"，effective 是"钳制之后真正生效的值"。
// 两者分开很重要——用户填 ttlSec:5 会被钳成 30，如果只回填生效值，他会以为"我填的 5 生效了"；
// 如果只回填原值，他又看不到实际跑的是什么。两个都给，前端就能做到"填的值保留 + 生效值标注"。
function runtimeSettingsView() {
  const raw = (config && config) || {};
  return {
    config: {
      sessionAffinity: {
        enabled: raw.sessionAffinity?.enabled === true,
        ttlSec: Number.isFinite(Number(raw.sessionAffinity?.ttlSec)) ? Number(raw.sessionAffinity.ttlSec) : AFFINITY_CFG.ttlMs / 1000,
        maxEntries: Number.isFinite(Number(raw.sessionAffinity?.maxEntries)) ? Number(raw.sessionAffinity.maxEntries) : AFFINITY_CFG.maxEntries,
        deriveFromBody: raw.sessionAffinity?.deriveFromBody === true,
      },
      rateLimit: {
        enabled: raw.rateLimit?.enabled === true,
        rpm: Number(raw.rateLimit?.rpm) || 0,
        burst: Number(raw.rateLimit?.burst) || 0,
        maxConcurrent: Number(raw.rateLimit?.maxConcurrent) || 0,
      },
      metrics: {
        enabled: !(raw.metrics?.enabled === false),
        public: raw.metrics?.public === true,
      },
      thinkingReplay: {
        enabled: raw.thinkingReplay?.enabled === true,
        ttlSec: Number.isFinite(Number(raw.thinkingReplay?.ttlSec)) ? Number(raw.thinkingReplay.ttlSec) : REPLAY_CFG.ttlMs / 1000,
        maxEntries: Number.isFinite(Number(raw.thinkingReplay?.maxEntries)) ? Number(raw.thinkingReplay.maxEntries) : REPLAY_CFG.maxEntries,
      },
    },
    effective: {
      sessionAffinity: { enabled: AFFINITY_CFG.enabled, ttlSec: Math.round(AFFINITY_CFG.ttlMs / 1000), maxEntries: AFFINITY_CFG.maxEntries, deriveFromBody: AFFINITY_CFG.deriveFromBody },
      rateLimit: { enabled: RATE_CFG.enabled, rpm: RATE_CFG.rpm, burst: RATE_CFG.burst, maxConcurrent: RATE_CFG.maxConcurrent },
      metrics: { enabled: METRICS_CFG.enabled, public: METRICS_CFG.public },
      thinkingReplay: { enabled: REPLAY_CFG.enabled, ttlSec: Math.round(REPLAY_CFG.ttlMs / 1000), maxEntries: REPLAY_CFG.maxEntries },
    },
    status: {
      affinity: affinityStatus(),
      rateLimit: rateStatus(),
      thinkingReplay: replayStatus(),
    },
  };
}

function metricRequest(route, status) {
  const k = route + '|' + status;
  METRICS.requests.set(k, (METRICS.requests.get(k) || 0) + 1);
}

function metricChannel(channelId, rec) {
  if (!channelId) return;
  let m = METRICS.channels.get(channelId);
  if (!m) { m = { ok: 0, fail: 0, inTok: 0, outTok: 0, msSum: 0, msCount: 0, probes: 0 }; METRICS.channels.set(channelId, m); }
  if (rec.ok) m.ok++; else m.fail++;
  if (rec.kind && String(rec.kind).includes('probe')) m.probes++;
  m.inTok += Math.max(0, Math.floor(Number(rec.inputTokens) || 0));
  m.outTok += Math.max(0, Math.floor(Number(rec.outputTokens) || 0));
  const ms = Number(rec.latencyMs) || 0;
  if (ms > 0) { m.msSum += ms; m.msCount++; }
}

const metricLabel = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function renderMetrics() {
  const L = [];
  const head = (name, type, help) => { L.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`); };
  head('zzcsapi_requests_total', 'counter', '客户端面请求数（按路由与最终状态码）');
  for (const [k, n] of METRICS.requests) {
    const [route, status] = k.split('|');
    L.push(`zzcsapi_requests_total{route="${metricLabel(route)}",status="${metricLabel(status)}"} ${n}`);
  }
  head('zzcsapi_channel_requests_total', 'counter', '渠道维度的成功/失败次数（含探测）');
  for (const [id, m] of METRICS.channels) {
    L.push(`zzcsapi_channel_requests_total{channel="${metricLabel(id)}",ok="true"} ${m.ok}`,
      `zzcsapi_channel_requests_total{channel="${metricLabel(id)}",ok="false"} ${m.fail}`);
  }
  head('zzcsapi_channel_tokens_total', 'counter', '渠道维度的 token 累计（真实 usage 优先）');
  for (const [id, m] of METRICS.channels) {
    L.push(`zzcsapi_channel_tokens_total{channel="${metricLabel(id)}",direction="in"} ${m.inTok}`,
      `zzcsapi_channel_tokens_total{channel="${metricLabel(id)}",direction="out"} ${m.outTok}`);
  }
  head('zzcsapi_channel_latency_ms', 'summary', '渠道维度耗时（sum/count）');
  for (const [id, m] of METRICS.channels) {
    L.push(`zzcsapi_channel_latency_ms_sum{channel="${metricLabel(id)}"} ${m.msSum}`,
      `zzcsapi_channel_latency_ms_count{channel="${metricLabel(id)}"} ${m.msCount}`);
  }
  head('zzcsapi_channels', 'gauge', '渠道状态计数（按健康分层）');
  const states = { ok: 0, down: 0, cooldown: 0, probation: 0, disabled: 0 };
  const now = Date.now();
  for (const ch of channels.values()) {
    if (ch.def.enabled === false) { states.disabled++; continue; }
    if (ch.cooldownUntil > now) states.cooldown++;
    else if (ch.status === 'down') states.down++;
    else if (ch.probation) states.probation++;
    else states.ok++;
  }
  for (const [s, n] of Object.entries(states)) L.push(`zzcsapi_channels{state="${s}"} ${n}`);
  head('zzcsapi_affinity_entries', 'gauge', '会话粘性表里当前的会话数');
  L.push(`zzcsapi_affinity_entries ${AFFINITY.size}`);
  head('zzcsapi_affinity_events_total', 'counter', '会话粘性事件（命中/未命中/学习/淘汰/过期/重排）');
  for (const k of ['hits', 'misses', 'learned', 'evicted', 'expired', 'reordered']) L.push(`zzcsapi_affinity_events_total{event="${k}"} ${AFFINITY_STAT[k]}`);
  head('zzcsapi_thinking_replay_entries', 'gauge', 'thinking 回放缓存里的记录数');
  L.push(`zzcsapi_thinking_replay_entries ${REPLAY.size}`);
  head('zzcsapi_thinking_replay_events_total', 'counter', 'thinking 回放事件（学习/修复命中/未命中/淘汰/过期/作废）');
  for (const k of ['learned', 'hits', 'misses', 'evicted', 'expired', 'stale']) L.push(`zzcsapi_thinking_replay_events_total{event="${k}"} ${REPLAY_STAT[k]}`);
  head('zzcsapi_rate_limit_events_total', 'counter', '限流事件（速率拒绝/并发拒绝/放行结束）');
  for (const [k, v] of [['rate_rejected', RATE_STAT.limitedRate], ['concurrent_rejected', RATE_STAT.limitedConcurrent], ['released', RATE_STAT.released]]) {
    L.push(`zzcsapi_rate_limit_events_total{event="${k}"} ${v}`);
  }
  head('zzcsapi_inflight_requests', 'gauge', '当前在飞的客户端请求数');
  L.push(`zzcsapi_inflight_requests ${RATE_STAT.inflight}`);
  head('zzcsapi_uptime_seconds', 'counter', '进程运行时长');
  L.push(`zzcsapi_uptime_seconds ${Math.floor((Date.now() - METRICS.startedAt) / 1000)}`);
  head('zzcsapi_process_resident_memory_bytes', 'gauge', '进程常驻内存');
  L.push(`zzcsapi_process_resident_memory_bytes ${process.memoryUsage().rss}`);
  head('zzcsapi_swrr_hits_total', 'counter', '加权轮询选中次数（份额统计）');
  L.push(`zzcsapi_swrr_hits_total ${SWRR_TOTAL}`);
  return L.join('\n') + '\n';
}


// 从状态码（优先）或错误文案判断失败属于哪一类。文案兜底是为了那些拿不到状态码的路径
// （原生客户端的异常、success:false 的 JSON 体）不至于全被当瞬时故障。
function failureKindFromStatus(status, msg) {
  const s = Number(status) || 0;
  if (s === 401 || s === 402 || s === 403) return 'credential';
  if (s === 429) return 'rate_limit';
  if (!s) {
    const t = String(msg || '');
    if (/not\s*login|未登录|登录失效|unauthor|invalid[\s_-]?key|insufficient|credit|exhaust|余额|额度|quota|expired/i.test(t)) return 'credential';
    if (/rate[\s_-]?limit|too many requests|限流|请求过于频繁/i.test(t)) return 'rate_limit';
  }
  return 'transient';
}

// Retry-After 解析（RFC 9110：秒数或 HTTP 日期两种写法）。拿不准就返回 undefined —— 让曲线说话。
// 只在 429 那条路径用；上限由 cooldownMsFor 统一钳到 hardMaxMs，坏上游没法用一个大数字把我们钉住。
function retryAfterMsFromHeaders(headers) {
  try {
    const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
    if (!raw) return undefined;
    const s = String(raw).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
    const at = Date.parse(s);
    if (!Number.isNaN(at)) return at - Date.now();
  } catch { /* ignore */ }
  return undefined;
}

// 第 n 次连续失败该冷却多久（n = recordFailure 自增后的 consecutiveFail，所以 n≥1）。
// 用 base * 2^(n-1)：第一次失败就是 base，读起来和配置一致（旧公式是 2^n，所以"第一次"是 2 秒，
// 而 README 一直写成 1 秒——文档与实现对不上，也是这次收敛的动因之一）。
function cooldownMsFor(ch, kind, retryAfterMs) {
  const n = Math.max(1, Number(ch.consecutiveFail) || 1);
  const cred = kind === 'credential', rate = kind === 'rate_limit';
  const base = cred ? COOLDOWN.hardBaseMs : rate ? COOLDOWN.rateLimitBaseMs : COOLDOWN.transientBaseMs;
  const max = cred ? COOLDOWN.hardMaxMs : COOLDOWN.transientMaxMs;
  // Retry-After 是上游明确的意图，优先于我们的曲线；但仍不许超过硬上限（别被一个坏上游钉住一天）
  const ra = Number(retryAfterMs);
  if (Number.isFinite(ra) && ra > 0) return Math.min(COOLDOWN.hardMaxMs, Math.max(1000, ra));
  return Math.min(max, base * Math.pow(2, n - 1));
}

// ─── 密钥轮换（v1.18.5）────────────────────────────────────────────────────────
// 背景：密钥原来只来自环境变量（.env → compose → 进程），容器里改不了 .env，
// 于是"轮换"只能手改文件 + 重开容器。现在控制台可以直接轮换。
//
// 优先级链（前者压后者）：
//   ① config.auth.gatewayKey / config.auth.adminKey —— 控制台轮换出来的值
//   ② 环境变量 GATEWAY_KEY / ADMIN_KEY
//   ③ config.gatewayKey / config.adminKey —— 首启自动生成并写回的值（旧机制，保持兼容）
//   ④ 随机生成并写回（见下面 resolveGeneratedKeys）
//
// ① 为什么必须压过 ②：否则 .env 里还写着旧值，一重启就把轮换结果顶掉，控制台看起来"改了却没生效"。
// 代价是 .env 从"唯一真源"降级为"初始值"，所以控制台必须显示当前值的来源、并提供「回到环境变量值」。
const KEY_MIN_LEN = 8, KEY_MAX_LEN = 128;
function genKey() {  // 48 位随机串，四样字符齐全（管理密钥的复杂度门槛对"随机生成"同样成立，否则生成出来的自己都过不了 normNewKey）
  const pools = ['abcdefghjkmnpqrstuvwxyz', 'ABCDEFGHJKMNPQRSTUVWXYZ', '23456789', '-_.!@#%*+'];
  const all = pools.join('');
  const pick = (s) => s[crypto.randomInt(s.length)];
  const chars = pools.map(pick);
  while (chars.length < 48) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }  // 洗牌，免得前四位永远是"四类各一"
  return chars.join('');
}
function managedAuth() { return (config && config.auth) || {}; }
function keySourceOf(kind) {
  const managed = managedAuth()[kind === 'gateway' ? 'gatewayKey' : 'adminKey'];
  if (managed) return 'console';
  if (process.env[kind === 'gateway' ? 'GATEWAY_KEY' : 'ADMIN_KEY']) return 'env';
  const legacy = config && (kind === 'gateway' ? config.gatewayKey : config.adminKey);
  if (legacy) return 'generated';
  return (kind === 'gateway' ? GATEWAY_KEY : ADMIN_KEY) ? 'generated' : 'none';
}
function keysInsecureNow() {
  return /change-me/i.test(GATEWAY_KEY || '') || /change-me/i.test(ADMIN_KEY || '');
}
function applyManagedKeys() {  // 启动时调用：让控制台轮换过的值压过环境变量
  const a = managedAuth();
  if (a.gatewayKey) GATEWAY_KEY = String(a.gatewayKey);
  if (a.adminKey) ADMIN_KEY = String(a.adminKey);
}
/* 新密钥的准入规则。宁可在这里挡住，也不要把"体检一眼就报不安全"的值放进配置：
   太短（可被枚举）、带空格或中文（HTTP 头里会被截断/编码，表现为时好时坏的 401）、
   change-me（示例默认串）、两个密钥相同（轮换时按错一个就整体失守）。
   管理密钥额外要求大小写字母 + 数字 + 特殊字符四样齐全——它是控制台与管理面的唯一门锁，
   复杂度必须高于"可被字典撞开"的底线；网关密钥只要求最低长度（用户拍板，v1.18.5 从 16 放宽到 8）。 */
function normNewKey(raw, label, other, kind) {
  const k = String(raw == null ? '' : raw).trim();
  if (!k) return { error: label + '不能为空' };
  if (k.length < KEY_MIN_LEN) return { error: label + '太短：至少 ' + KEY_MIN_LEN + ' 位（建议直接用「随机生成」）' };
  if (k.length > KEY_MAX_LEN) return { error: label + '太长：最多 ' + KEY_MAX_LEN + ' 位' };
  if (!/^[\x21-\x7e]+$/.test(k)) return { error: label + '只能包含可见 ASCII 字符（不能有空格、中文或控制字符）' };
  if (/change-me/i.test(k)) return { error: label + '不能包含 change-me（那是示例默认串，体检会判为不安全）' };
  if (kind === 'admin') {
    const missing = [];
    if (!/[a-z]/.test(k)) missing.push('小写字母');
    if (!/[A-Z]/.test(k)) missing.push('大写字母');
    if (!/[0-9]/.test(k)) missing.push('数字');
    if (!/[^a-zA-Z0-9]/.test(k)) missing.push('特殊字符');
    if (missing.length) return { error: label + '复杂度不够：还需包含' + missing.join('、') + '（管理密钥要求大小写字母 + 数字 + 特殊字符四样齐全）' };
  }
  if (other && k === other) return { error: '网关密钥与管理密钥不能相同' };
  return { key: k };
}
function resetAuthFailCounters() {   // 轮换即清零：旧密钥造成的失败不该让新密钥继续吃 429
  AUTH_FAIL.admin = { n: 0, until: 0 };
  AUTH_FAIL.gateway = { n: 0, until: 0 };
}
function rotateKeys(patch) {         // patch 里的值必须已经过 normNewKey
  const next = { ...managedAuth() };
  if (patch.gatewayKey !== undefined) next.gatewayKey = patch.gatewayKey;
  if (patch.adminKey !== undefined) next.adminKey = patch.adminKey;
  next.updatedAt = new Date().toISOString();
  config.auth = next;
  if (patch.gatewayKey !== undefined) GATEWAY_KEY = patch.gatewayKey;
  if (patch.adminKey !== undefined) ADMIN_KEY = patch.adminKey;
  resetAuthFailCounters();
  if (patch.adminKey !== undefined) clearSessions();   // 换锁后旧会话一律作废；发起方由响应补发新会话（见路由处）
  persistConfig();
  return next;
}
function resetManagedKeys() {        // 丢掉控制台的覆盖，回到「环境变量 → 首启生成」
  delete config.auth;
  if (!NOAUTH) {
    const envG = process.env.GATEWAY_KEY || '', envA = process.env.ADMIN_KEY || '';
    GATEWAY_KEY = envG || config.gatewayKey || GATEWAY_KEY || genKey();
    ADMIN_KEY = envA || config.adminKey || ADMIN_KEY || genKey();
  } else {
    GATEWAY_KEY = process.env.GATEWAY_KEY || '';
    ADMIN_KEY = process.env.ADMIN_KEY || '';
  }
  resetAuthFailCounters();
  clearSessions();                    // 控制权交还 .env：控制台签出的会话一并作废
  persistConfig();
}
function keysView() {
  const a = managedAuth();
  return {
    gatewayKey: { masked: maskSecret(GATEWAY_KEY), set: !!GATEWAY_KEY, source: keySourceOf('gateway') },
    adminKey: { masked: maskSecret(ADMIN_KEY), set: !!ADMIN_KEY, source: keySourceOf('admin') },
    rotatedAt: a.updatedAt || null,
    keysInsecure: keysInsecureNow(),
    minLen: KEY_MIN_LEN,
    noAuth: NOAUTH,
  };
}

// 首启密钥生成（见鉴权块注释的优先级链）。NOAUTH 开着就不生成——那是显式选择的零鉴权开发模式。
// 独立写回 config.json（而非走 persistConfig）：persistConfig 依赖 channels 初始化顺序，且会重建对象。
function resolveGeneratedKeys() {
  if (NOAUTH) return;
  const gen = () => require('crypto').randomBytes(24).toString('hex');
  const fresh = {};
  if (!ADMIN_KEY) {
    ADMIN_KEY = config.adminKey || gen();
    if (!config.adminKey) fresh.admin = ADMIN_KEY;
    config.adminKey = ADMIN_KEY;
  }
  if (!GATEWAY_KEY) {
    GATEWAY_KEY = config.gatewayKey || gen();
    if (!config.gatewayKey) fresh.gateway = GATEWAY_KEY;
    config.gatewayKey = GATEWAY_KEY;
  }
  if (fresh.admin || fresh.gateway) {
    let persisted = true;
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8'); } catch (e) { persisted = false; }
    console.log('');
    console.log('════════════════════ 首启密钥 ════════════════════');
    if (fresh.admin) console.log('  ADMIN_KEY   = ' + fresh.admin + '   （控制台 / 管理接口）');
    if (fresh.gateway) console.log('  GATEWAY_KEY = ' + fresh.gateway + '   （/v1 等客户端接口）');
    console.log('  控制台 http://127.0.0.1:' + PORT + '/console → 首次打开输入 ADMIN_KEY，浏览器记住后裸开即可');
    console.log(persisted ? '  已写入 config.json，重启不变；可用环境变量 ADMIN_KEY / GATEWAY_KEY 显式接管'
                          : '  ⚠ 写回 config.json 失败（只读挂载？）——密钥仅本次启动有效，重启将更换');
    console.log('════════════════════════════════════════════════════');
  }
}
applyManagedKeys();
resolveGeneratedKeys();

// ─── Codex 常量（必须在任何探测/请求路径之前初始化，否则 TDZ 报错）───
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_DEFAULT_BASE = 'https://chatgpt.com/backend-api/codex';
// codex 默认代理：容器经宿主机 Clash 出网（可用 ZZCSAPI_CODEX_PROXY 覆盖）
const CODEX_DEFAULT_PROXY = process.env.ZZCSAPI_CODEX_PROXY || 'http://host.docker.internal:7897';
// 与 sub2api 对齐的客户端身份：/backend-api/codex 推理面有 version 门槛，
// 陈旧版本拿不到模型列表（{"models":[]}）甚至被优先降载；UA 形态缺少 OS/终端后缀易被指纹识别
const CODEX_VERSION = '0.146.0';
const CODEX_UA = `codex_cli_rs/${CODEX_VERSION} (Ubuntu 22.4.0; x86_64) xterm-256color`;

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
// 别名近似建议：调用方用了已改名/手误的模型名时，提示当前真实可用的别名
function suggestAliases(model, limit) {
  const want = String(model || '').toLowerCase().trim();
  if (!want) return [];
  const all = new Set();
  for (const ch of channels.values()) {
    if (!ch.def.enabled) continue;
    for (const a of ch.aliasMap.keys()) all.add(a);
    if (ch.def.autoAlias !== false) for (const m of ch.models || []) all.add(String(m).toLowerCase());
  }
  // 去掉纯分隔符差异后比较，命中 -wr/_wr 之类的改名/手误
  const norm = (s) => s.replace(/[-_.\s]/g, '');
  const nw = norm(want);
  const scored = [];
  for (const a of all) {
    const na = norm(a);
    let score = 0;
    if (na === nw) score = 100;                                        // 仅分隔符不同
    else if (na.includes(nw) || nw.includes(na)) score = 80;            // 包含关系
    else {
      // 最长公共前后缀（处理前缀/后缀增删）
      let pre = 0; while (pre < na.length && pre < nw.length && na[pre] === nw[pre]) pre++;
      let suf = 0; while (suf < na.length - pre && suf < nw.length - pre && na[na.length - 1 - suf] === nw[nw.length - 1 - suf]) suf++;
      const overlap = pre + suf;
      if (overlap >= Math.min(na.length, nw.length) * 0.6) score = 60 + overlap;
    }
    if (score > 0) scored.push({ a, score });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, limit || 3).map((x) => x.a);
}

// ─────────────────────── 真正的加权轮询（SWRR） ───────────────────────
// 与「有效优先级」的分工，别混：
//   · `priority` / `effPriority` 决定**候选链顺序**——谁先试、谁兜底（排序语义）；
//   · `weight` 决定**同组内按比例分流**——真正的加权轮询（分流语义）。
// 只有**明确填了正数 `weight`** 的渠道进轮询池；没填（缺省 0）时行为与从前逐字节一致，
// 老配置零影响。填法：两个渠道 3:1 ⇒ 长期分流≈75%/25%。`weight: 0` 与不填等价（只做兜底）。
//
// 算法用平滑加权轮询（nginx upstream 的 smooth WRR，无随机数）：
//   每轮 pool 内各成员 curr += weight，取 curr 最大者，选中者 curr -= sum(weight)。
// 好处：长期比例精确等于权重比，且**不会突发扎堆**（加权随机会连着命中同一个）。
// 状态是内存态（重启清零，无副作用）；渠道处于冷却/down 时不进池，
// 份额自然分给健康成员 ✓，它恢复后 curr 不会被补上"欠账"（不会出现报复性突发）。
const SWRR_CUR = new Map();  // channelId → 当前权值
const SWRR_HITS = new Map(); // channelId → 被选中次数（可观测：/admin/api/status 的 weightedShare）
let SWRR_TOTAL = 0;

function pickWeighted(candidates) {
  const now = Date.now();
  // 加权轮询的池子：只有填了权重的渠道进来抢"谁排第一"。probation（探测半愈合过）不进池——
  // 它可以作为兜底被用到，但不该凭权重抢链首；否则"探测一成功就回链首"这个老毛病会从后门回来。
  const pool = candidates.filter((c) => Number(c.weight) > 0 && !(c.cooldownUntil > now) && c.status !== 'down' && !c.probation);
  if (!pool.length) return -1;
  let total = 0;
  for (const c of pool) {
    const w = Number(c.weight);
    total += w;
    SWRR_CUR.set(c.channelId, (SWRR_CUR.get(c.channelId) || 0) + w);
  }
  let best = pool[0];
  for (const c of pool) {
    if ((SWRR_CUR.get(c.channelId) || 0) > (SWRR_CUR.get(best.channelId) || 0)) best = c;
  }
  SWRR_CUR.set(best.channelId, (SWRR_CUR.get(best.channelId) || 0) - total);
  SWRR_HITS.set(best.channelId, (SWRR_HITS.get(best.channelId) || 0) + 1);
  SWRR_TOTAL++;
  return candidates.indexOf(best);
}

// 轮询选中者提到**候选链第一位**，其余保持原有（健康度→有效优先级→延迟）顺序作兜底链。
// 没有任何渠道填 weight 时这里什么都不做 —— 这是"老配置零影响"的关键。
function applyWeightedPick(list) {
  const idx = pickWeighted(list);
  if (idx > 0) list.unshift(list.splice(idx, 1)[0]);
  return list;
}

function weightedStats() {
  const out = {};
  for (const [id, n] of SWRR_HITS) out[id] = { hits: n, share: SWRR_TOTAL ? Math.round((n / SWRR_TOTAL) * 1000) / 10 : 0 };
  return { total: SWRR_TOTAL, channels: out };
}

function channelsServing(model, protocol) {
  const want = String(model || '').toLowerCase().trim();
  if (!want) return [];
  const out = [];
  const hasAny = { explicit: false, auto: false, blind: false };
  for (const ch of channels.values()) {
    if (!ch.def.enabled) continue;
    const chProto = ch.def.protocol || 'openai';
    // protocol 支持单个字符串（老用法不变）或数组（用于"这几套协议都能互通"的候选收集）
    if (protocol) {
      if (Array.isArray(protocol)) { if (!protocol.includes(chProto)) continue; }
      else if (chProto !== protocol) continue;
    }
    // 关闭 autoAlias 时跳过自动 alias
    const autoAlias = ch.def.autoAlias !== false;
    if (ch.aliasMap.has(want)) {
      hasAny.explicit = true;
      out.push({
        channelId: ch.def.id,
        upstream: ch.aliasMap.get(want),
        priority: effPriority(ch),
        weight: Number(ch.def.weight) > 0 ? Number(ch.def.weight) : 0,
        status: ch.status,
        latencyMs: ch.latencyMs,
        cooldownUntil: ch.cooldownUntil,
        consecutiveFail: ch.consecutiveFail,
        probation: !!ch.probation,
        protocol: chProto,
        kind: 'explicit',
      });
    } else if (autoAlias && ch.models.includes(want)) {
      hasAny.auto = true;
      out.push({
        channelId: ch.def.id,
        upstream: want,
        priority: effPriority(ch) - 0.5,
        weight: Number(ch.def.weight) > 0 ? Number(ch.def.weight) : 0,
        status: ch.status,
        latencyMs: ch.latencyMs,
        cooldownUntil: ch.cooldownUntil,
        consecutiveFail: ch.consecutiveFail,
        probation: !!ch.probation,
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
        weight: Number(ch.def.weight) > 0 ? Number(ch.def.weight) : 0,
        status: ch.status,
        latencyMs: ch.latencyMs,
        cooldownUntil: ch.cooldownUntil,
        consecutiveFail: ch.consecutiveFail,
        probation: !!ch.probation,
        protocol: chProto,
        kind: 'blind',
      });
      hasAny.blind = true;
    }
  }
  out.sort((a, b) => {
    // 分层：冷却中(3) → down(2) → probation(1：探测"半愈合"过、欠账还记着) → 健康(0)
    // probation 自成一档，就是为了让"探测救回来但对话仍然可疑"的渠道排在健康渠道之后，不去抢链首。
    // 注意别拿 status==='degraded' 当这个信号：那个状态另有含义（探测拉回了空模型列表），
    // 混用会把"列表为空但别名可用"的渠道也误降级（weighted-rr/console-weight 的回归就是这么发现的）。
    const healthy = (c) => (c.cooldownUntil > Date.now() ? 3 : c.status === 'down' ? 2 : c.probation ? 1 : 0);
    const ha = healthy(a), hb = healthy(b);
    if (ha !== hb) return ha - hb;
    if (a.priority !== b.priority) return b.priority - a.priority;
    const la = a.latencyMs < 0 ? 1e9 : a.latencyMs;
    const lb = b.latencyMs < 0 ? 1e9 : b.latencyMs;
    return la - lb;
  });
  // ★ 加权轮询：只有填了 weight 的渠道才改变"谁是第一位"；没填则原样返回（老配置零影响）
  return applyWeightedPick(out);
}

function aggregateModels(protocol) {
  const all = new Set();
  for (const ch of channels.values()) {
    // 停用渠道不出现在模型列表（与请求路由的 enabled 过滤保持一致）
    if (ch.def.enabled === false) continue;
    const chProto = ch.def.protocol || 'openai';
    // 别名跨协议聚合：三个入口都有跨协议候选链兜底（openai 入口同样把
    // notion 兜底候选计入——DSH 等客户端从 /v1/models 选 notion 模型时可见）
    const aliasedProto = ['openai', 'anthropic', 'gemini', 'notion', 'notion-agent', 'workbuddy', 'codex', 'genspark'];
    if (protocol && !aliasedProto.includes(chProto)) continue;
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
  // Notion 官方 Agent API 渠道：agents/query 列出智能体（名称当模型名）
  if ((ch.def.protocol || 'openai') === 'notion-agent') {
    const t0 = Date.now();
    try {
      const agents = await notionAgent.listAgents(ch.def.baseUrl, ch.def.apiKey, zzFetch, HEALTH.timeoutMs || 15000);
      ch.models = agents.map((a) => a.name).filter(Boolean);
      ch.agentModels = agents;
      ch.latencyMs = Date.now() - t0;
      healAfterProbe(ch, agents.length > 0);
    } catch (err) {
      recordFailure(ch, 'notion-agent: ' + (err.message || err));
    }
    return;
  }
  // Notion 渠道：getSpaces 验证（成功即 ok，刷新凭据缓存）
  if ((ch.def.protocol || 'openai') === 'notion') {
    const t0 = Date.now();
    try {
      const acct = await notion.notionDiscoverAccount(ch.def.baseUrl, ch.def.apiKey, zzFetch, HEALTH.timeoutMs || 15000);
      const first = acct.spaces[0];
      ch.notion = { userId: acct.userId, spaceId: first.spaceId, spaceViewId: first.spaceViewId || '', userName: acct.userName, userEmail: acct.userEmail, spaces: acct.spaces, at: Date.now() };
      try {
        const u = await notion.notionUsageEligibility(ch.def.baseUrl, ch.def.apiKey, acct, zzFetch, 10000);
        ch.notion.usage = { type: u.type, eligible: u.isEligible, userUsage: u.userUsage, userLimit: u.userLimit, at: Date.now() };
      } catch { /* 额度查询失败不影响健康状态 */ }
      ch.models = notion.notionListModels();
      ch.latencyMs = Date.now() - t0;
      healAfterProbe(ch, true);
    } catch (err) {
      recordFailure(ch, 'notion: ' + (err.message || err));
    }
    return;
  }
  // WorkBuddy 国际版反代：无 /models 端点，探测走一次真实轻量聊天（免费 deepseek-v4.1-flash）
  if ((ch.def.protocol || 'openai') === 'workbuddy' || ch.def.protocol === 'genspark') {
    const t0 = Date.now();
    try {
      const probe = ch.def.protocol === 'genspark' ? await gensparkIsLogin(ch.def, HEALTH.timeoutMs || 15000) : await workbuddyChatProbe(ch.def, HEALTH.timeoutMs || 15000);
      if (!probe.ok) {
        // 把探测的分类带出来：额度/频率用尽要走 rate_limit（并按上游给的重置时刻定冷却），
        // 不能当作"渠道故障"记一笔瞬时失败
        const e = new Error(probe.error || 'probe failed');
        e.status = probe.status; e.rateLimited = probe.rateLimited; e.retryAfterMs = probe.retryAfterMs;
        throw e;
      }
      // 无 /models 端点 → 模型列表直接用 def.models 的 upstream 值（用户配置的别名映射）
      ch.models = Object.values(ch.def.models || {}).filter(Boolean);
      ch.latencyMs = Date.now() - t0;
      // 这一支里 workbuddy 的探测本身就是一次真实对话（真凭实据 → 可满血）；genspark 只是验登录态（半愈合）
      healAfterProbe(ch, true, ch.def.protocol !== 'genspark');
    } catch (err) {
      if (err.rateLimited || err.retryAfterMs) recordFailure(ch, 'workbuddy: ' + (err.message || err), 'rate_limit', err.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : {});
      else recordFailure(ch, 'workbuddy: ' + (err.message || err));
    }
    return;
  }
  // Codex（ChatGPT 官方订阅）：探测 = 一次令牌刷新（验证 RT 活性，轮转自动写回）
  if ((ch.def.protocol || 'openai') === 'codex') {
    const t0 = Date.now();
    try {
      await codexEnsureToken(ch);
      ch.models = Object.values(ch.def.models || {}).filter(Boolean);
      ch.latencyMs = Date.now() - t0;
      healAfterProbe(ch, true);   // 令牌刷新只证明凭据活着，不证明对话能成 → 半愈合
    } catch (err) {
      // RT 失效是致命错误：按凭证类退避（起步 5 分钟、封顶 6 小时），不再只给 300 秒
      recordFailure(ch, String(err.message || err), err.fatal ? 'credential' : undefined);
    }
    return;
  }
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH.timeoutMs || 8000);
  const probeUrl = probeUrlForDef(ch.def);
  let resp;
  let usedFallback = false;
  try {
    if (ch.def.proxy) {
      // PT02：渠道配了代理 → 探测同样必须走代理（undici fetch 无代理支持），curl -x
      const out = await wbCurlRequest('GET', probeUrl, probeHeadersForDef(ch.def), null, HEALTH.timeoutMs || 8000, ch.def.proxy);
      if (out.status > 0) {
        usedFallback = true;
        resp = { ok: out.status >= 200 && out.status < 300, status: out.status, text: async () => out.body };
      } else {
        throw new Error('proxy: ' + (out.error || 'empty'));
      }
    } else {
    resp = await zzFetch(probeUrl, {
      method: 'GET',
      headers: probeHeadersForDef(ch.def),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    // Cloudflare 拦截 → PS Schannel 回退
    if (resp.status === 403) {
      let body = '';
      try { body = await resp.text(); } catch {}
      if (isCloudflareBlock(403, body)) {
        const ps = await psHttpRequest('GET', probeUrl, probeHeadersForDef(ch.def), null, HEALTH.timeoutMs || 8000);
        if (ps.status > 0) {
          usedFallback = true;
          resp = { ok: ps.status >= 200 && ps.status < 300, status: ps.status, text: async () => ps.body };
        }
      }
    }
    }
    const ms = Date.now() - t0;
    if (!resp.ok) {
      recordFailure(ch, `probe ${resp.status}`, failureKindFromStatus(resp.status));
      return;
    }
    const text = await resp.text();
    const j = safeJson(text);
    const ids = extractModelIds(j, ch.def.protocol || 'openai');
    ch.models = ids;
    ch.latencyMs = ms;
    // 列表拉得回来 ≠ 对话能成 → 半愈合（见 healAfterProbe：欠账减半、状态 degraded、排在健康渠道之后）
    healAfterProbe(ch, ids.length > 0);
  } catch (err) {
    clearTimeout(timer);
    recordFailure(ch, String(err && err.message || err));
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
  if (proto === 'notion')    return applyCustomHeaders({ 'User-Agent': notion.NOTION_UA, 'Cookie': `token_v2=${def.apiKey}` }, def);
  if (proto === 'anthropic') return applyCustomHeaders({ 'x-api-key': def.apiKey, 'anthropic-version': '2023-06-01' }, def);
  if (proto === 'gemini')    return applyCustomHeaders({ 'x-goog-api-key': def.apiKey }, def);
  return applyCustomHeaders({ 'Authorization': `Bearer ${def.apiKey}` }, def);
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
  // Notion 官方 Agent API 协议：agents/query 列智能体（名称 = 可用模型）
  if ((def.protocol || 'openai') === 'notion-agent') {
    const t0 = Date.now();
    try {
      const agents = await notionAgent.listAgents(def.baseUrl, def.apiKey, zzFetch, timeoutMs || 15000);
      return {
        ok: true, latencyMs: Date.now() - t0, status: 200,
        models: agents.map((a) => a.name).filter(Boolean),
        agents: agents.map((a) => ({ name: a.name, model: a.model, status: a.status })),
      };
    } catch (err) {
      return { ok: false, status: err.status || 0, error: 'notion-agent: ' + (err.message || err), latencyMs: Date.now() - t0 };
    }
  }
  // Notion 协议：getSpaces（POST）验证 token_v2，模型列表用内置映射；顺带查 AI 额度
  if ((def.protocol || 'openai') === 'notion') {
    const t0 = Date.now();
    try {
      const acct = await notion.notionDiscoverAccount(def.baseUrl, def.apiKey, zzFetch, timeoutMs || 15000);
      let usage = null;
      try {
        const u = await notion.notionUsageEligibility(def.baseUrl, def.apiKey, acct, zzFetch, 10000);
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
  // WorkBuddy 国际版反代：无 /models 端点，探测走真实轻量聊天
  if ((def.protocol || 'openai') === 'workbuddy') {
    const t0 = Date.now();
    try {
      const r = await workbuddyChatProbe(def, timeoutMs || 15000);
      if (!r.ok) throw new Error(r.error || 'probe failed');
      let models = Object.values(def.models || {}).filter(Boolean);
      if (!models.length) models = ['deepseek-v4.1-flash']; // 探测时表单尚无别名配置，给出免费默认模型作为建议
      return { ok: true, models, latencyMs: Date.now() - t0, status: 200, account: { note: 'workbuddy 无 /models 端点，模型列表来自别名配置（默认建议 deepseek-v4.1-flash）' } };
    } catch (err) {
      return { ok: false, status: err.status || 0, error: 'workbuddy: ' + (err.message || err), latencyMs: Date.now() - t0 };
    }
  }
  // Genspark 网页会话反代：探测 = GET /api/is_login（免费，不消耗 credit），必须走 def.proxy
  if ((def.protocol || 'openai') === 'genspark') {
    const t0 = Date.now();
    try {
      const r = await gensparkIsLogin(def, timeoutMs || 12000);
      if (!r.ok) throw new Error(r.error || 'probe failed');
      let models = Object.values(def.models || {}).filter(Boolean);
      if (!models.length) models = ['gpt-6-luna', 'gpt-6-sol', 'claude-opus-5-5', 'glm-5p3', 'deep-seek-v4.1-flash', 'kimi-k3'];
      return { ok: true, models, latencyMs: Date.now() - t0, status: 200, account: { email: r.email, note: '网页会话鉴权通过（is_login 免费探测，不消耗 credit）；网页端无 models 接口，模型列表来自别名配置' } };
    } catch (err) {
      return { ok: false, status: err.status || 0, error: 'genspark: ' + (err.message || err), latencyMs: Date.now() - t0 };
    }
  }
  // Codex（ChatGPT 官方订阅）：探测 = 一次令牌刷新
  if ((def.protocol || 'openai') === 'codex') {
    const t0 = Date.now();
    const tmpCh = { def, codex: null };
    const origRt = def.apiKey;
    try {
      const acct = await codexEnsureToken(tmpCh);
      let models = Object.values(def.models || {}).filter(Boolean);
      if (!models.length) models = ['gpt-5.1']; // 探测时表单尚无别名配置，给出订阅默认模型建议
      const resp = { ok: true, models, latencyMs: Date.now() - t0, status: 200, account: { accountId: acct.accountId || undefined, note: 'codex 无 /models 端点，模型列表来自别名配置（默认建议 gpt-5.1）' } };
      // RT 轮转：探测消费了旧 RT → 把新 RT 回给前端回填，否则用户保存旧值渠道即死
      if (tmpCh.def.apiKey !== origRt) resp.rotatedApiKey = tmpCh.def.apiKey;
      return resp;
    } catch (err) {
      return { ok: false, status: err.status || 0, error: String(err.message || err), latencyMs: Date.now() - t0 };
    }
  }
  // 常见配置错误提示：域名对不上协议 → 直接给出可读指引
  {
    const host = String((def || {}).baseUrl || '').toLowerCase();
    if (/chatgpt\.com/.test(host) && (def.protocol || 'openai') !== 'codex') {
      return { ok: false, status: 0, error: '检测到 chatgpt.com 域名但协议不是 codex——请把「协议」下拉框改成 codex（ChatGPT 订阅走 backend-api/codex，openai 协议的 /models 探测对它无效）', latencyMs: 0 };
    }
    if (/workbuddy\.ai/.test(host) && (def.protocol || 'openai') !== 'workbuddy') {
      return { ok: false, status: 0, error: '检测到 workbuddy.ai 域名但协议不是 workbuddy——请把「协议」下拉框改成 workbuddy（openai 协议的 /models 探测对 workbuddy 无效，且该接口只支持流式）', latencyMs: 0 };
    }
    if (/notion\.(so|com)/.test(host)) {
      return { ok: false, status: 0, error: '检测到 notion 域名但协议不是 notion——请把「协议」下拉框改成 notion（openai 协议的 /models 探测对 notion 无效）', latencyMs: 0 };
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || HEALTH.timeoutMs || 8000);
  const t0 = Date.now();
  try {
    if (def.proxy) {
      // PT02：渠道配了代理 → 表单探测也走代理（undici fetch 无代理支持），curl -x
      const out = await wbCurlRequest('GET', probeUrlForDef(def), probeHeadersForDef(def), null, timeoutMs || 12000, def.proxy);
      const ms = Date.now() - t0;
      if (!(out.status > 0)) return { ok: false, status: 0, error: 'proxy: ' + (out.error || 'empty'), latencyMs: ms, via: 'proxy' };
      if (out.status >= 200 && out.status < 300) {
        const j = safeJson(out.body);
        const models = extractModelIds(j, def.protocol || 'openai');
        return { ok: true, models, latencyMs: ms, status: out.status, via: 'proxy' };
      }
      return { ok: false, status: out.status, error: `HTTP ${out.status}: ${String(out.body).slice(0, 150)}`, latencyMs: ms, via: 'proxy' };
    }
    const resp = await zzFetch(probeUrlForDef(def), { method: 'GET', headers: probeHeadersForDef(def), signal: ctrl.signal });
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

// 健康探测的目标集合。
// ★ 自动探测（启动时 + 定时器）**跳过停用渠道**：停用就是"别碰它"——不该继续消耗它的配额，
//   也不该让探测失败把它的状态越推越糟。手动动作不受此限（见下面两处调用）。
async function probeAll(opts = {}) {
  const includeDisabled = opts.includeDisabled === true;
  const targets = Array.from(channels.values()).filter((ch) => includeDisabled || ch.def.enabled !== false);
  await Promise.all(targets.map((ch) => probeChannel(ch)));
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
function readBody(req) { return new Promise((resolve, reject) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); }); }
function sendJson(res, code, obj) { const body = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }); res.end(body); }
function unauthorized(res, kind) { sendJson(res, 401, { error: { message: `${kind} key required` } }); }

/* 鉴权闸门（v1.18.4）：先看失败限流窗口，再走 checkAuth，最后才 401。
   9 处鉴权点全部改走它 —— 于是 /admin/api/*、/metrics、五条客户端路由共用同一套失败计数。 */
function authGate(req, res, kind) {
  const wait = authThrottle(kind);
  if (wait) {
    res.setHeader('Retry-After', String(wait));
    sendJson(res, 429, { error: { message: `too many failed ${kind} auth attempts, retry in ${wait}s`, type: 'rate_limited' } });
    return false;
  }
  if (checkAuth(req, kind)) return true;
  unauthorized(res, kind);
  return false;
}
function upstreamErrorPayload(status, msg) { return { error: { message: msg, type: 'upstream_error', code: status } }; }
function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

// 渠道级自定义请求头。def.headers 支持两种写法：
//   对象：{"User-Agent":"claude-cli/2.0.0 (external, cli)"}
//   文本：每行 "Name: value"（控制台里直接粘贴多行更顺手）
// 值为空的行忽略；不许覆盖 Authorization（防误配把 key 冲掉）。
function parseCustomHeaders(def) {
  const src = def && def.headers;
  if (!src) return {};
  const out = {};
  if (typeof src === 'object' && !Array.isArray(src)) {
    for (const [k, v] of Object.entries(src)) {
      if (k && v !== undefined && v !== null && String(v).trim()) out[String(k).trim()] = String(v).trim();
    }
  } else {
    for (const line of String(src).split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf(':');
      if (i <= 0) continue;
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim();
      if (k && v) out[k] = v;
    }
  }
  delete out.Authorization;
  delete out.authorization;
  return out;
}

function applyCustomHeaders(base, def) {
  const extra = parseCustomHeaders(def);
  return Object.keys(extra).length ? Object.assign({}, base, extra) : base;
}

// WorkBuddy 专用 curl 请求：该上游对 Node/undici TLS 指纹 ECONNRESET，必须走 curl 子进程。
// 与 notionCurlRequest 同构：body 写临时文件避免转义，stdout 全量缓冲（SSE 短文本够用）。
// 返回 {status, body, error}；status>0 且 body 非空时为成功响应
function wbCurlRequest(method, url, headers, bodyStr, timeoutMs, proxy) {
  return new Promise((resolve) => {
    const os = require('os');
    const fsSync = require('fs');
    const pathSync = require('path');
    const bodyFile = pathSync.join(os.tmpdir(), `zzwb_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    let written = false;
    try { fsSync.writeFileSync(bodyFile, bodyStr || '', 'utf8'); written = true; } catch {}
    const args = ['-sS', '-N', '-X', String(method).toUpperCase(), '--max-time', String(Math.max(1, Math.floor((timeoutMs || 120000) / 1000)))];
    if (proxy) args.push('-x', String(proxy));
    for (const [k, v] of Object.entries(headers || {})) args.push('-H', `${k}: ${v}`);
    if (written) args.push('--data', '@' + bodyFile);
    args.push('-w', '\n__ZZCODE__%{http_code}');
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
      const text = stdout.toString('utf8');
      const m = text.match(/__ZZCODE__(\d+)\s*$/);
      const body = m ? text.slice(0, text.lastIndexOf('__ZZCODE__')).replace(/\n$/, '') : text;
      const status = m ? Number(m[1]) : (code === 0 ? 200 : 0);
      if (code !== 0 && !body) { resolve({ status: 0, body: '', error: `curl exit ${code}: ${stderr.slice(0, 200)}` }); return; }
      resolve({ status, body, error: null });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (written) try { fsSync.unlinkSync(bodyFile); } catch {}
      resolve({ status: 0, body: '', error: 'curl spawn: ' + err.message });
    });
  });
}

// ── WorkBuddy 上游错误的三个判据（v1.14.1）────────────────────────────────────
// 背景：上游额度耗尽时回 HTTP 429 + {"code":6004,"msg":"usage exceeds frequency limit … your
// usage will reset at 2026-09-28 10:00:39 UTC+8 …"}。旧代码把这个响应体当成"未知响应"，
// 探测只抛一句 'non-SSE response'——用户看到的就是「同样复制了 token，却提示 non-SSE」，
// 完全看不出真实原因是额度用完（而且重置时刻上游已经明说了）。

// 额度/频率已用尽类文案（与普通 429 同义，但要带重置时刻）
function wbQuotaLimited(text) {
  return /usage exceeds frequency limit|frequency limit|too many requests|rate limit/i.test(String(text || ''));
}

// 从上游文案里抠出「重置时刻」→ 距现在的毫秒数（抠不到返回 0）。
// 有了它，冷却期可以精确对齐到额度回血的那一刻，而不是按曲线瞎猜（默认起步 1 小时，
// 常常在额度早就恢复之后还继续空等，或反过来提早去撞墙被反复判失败）。
function wbQuotaResetMs(text, now = Date.now()) {
  const m = String(text || '').match(/reset at\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC\s*([+-]\d{1,2})?/i);
  if (!m) return 0;
  const offH = m[7] ? Number(m[7]) : 0;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - offH, +m[5], +m[6]);
  return Number.isFinite(ms) && ms > now ? ms - now : 0;
}

// 非 SSE、非 JSON 的响应不该只说一句 'non-SSE response'：把 HTTP 码与响应开头带上，
// 才分得清是 CF 挑战页、代理错误页还是上游改了报文格式。
function wbOpaqueBodyMsg(status, text) {
  const snip = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `non-SSE response (HTTP ${status || 0}${snip ? '，响应开头: ' + snip : '，响应体为空'})`;
}

// CodeBuddy 新版把 auth 文件里的 accessToken 加密了（{$wbEncrypted:1, envelope:"{suite,keyId,nonce,authTag,ciphertext}"}）。
// 粘这个字符串一定失败——它不是 JWT，是 AES-GCM 密文。早点说清楚，别让用户以为是自己复制错了。
function wbEncryptedKeyHint(apiKey) {
  const s = String(apiKey || '').trim();
  if (!s) return '';
  if (/wbEncrypted|ciphertext|authTag/.test(s) || s.includes('"suite"')) {
    return 'apiKey 是 CodeBuddy 加密后的 envelope（不是 JWT）——不能直接当 Bearer 用；' +
      '请用明文 accessToken（JWT，形如 eyJhbG… 三段点分），或从客户端实际请求里取一次新的';
  }
  return '';
}

// WorkBuddy 探测：/v2 下没有 /models 端点（404），只能走一次真实轻量聊天。
// 用 def.models 里第一个 upstream 模型（通常是 deepseek-v4.1-flash），
// system+user、max_tokens=1、stream=true，读到首个 SSE chunk 即判活。
// 注意：必须走 curl 子进程——该上游对 Node/undici 的 TLS 指纹直接 ECONNRESET。
async function workbuddyChatProbe(def, timeoutMs) {
  const t0 = Date.now();
  const keyHint = wbEncryptedKeyHint(def.apiKey);
  if (keyHint) return { ok: false, error: keyHint, latencyMs: 0, status: 0 };   // 密文不用发请求，直接说清楚
  const model = (Object.values(def.models || {})[0]) || 'deepseek-v4.1-flash';
  const bodyStr = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'ping' },
    ],
    stream: true,
    max_tokens: 1,
  });
  const out = await wbCurlRequest('POST', joinUrl(def.baseUrl, 'chat/completions'), {
    'Content-Type': 'application/json', 'Authorization': `Bearer ${def.apiKey}`,
  }, bodyStr, timeoutMs || 15000, def.proxy);
  if (out.error || !out.body) {
    return { ok: false, error: out.error || 'empty body', latencyMs: Date.now() - t0, status: out.status || 0 };
  }
  const text = out.body;
  // 响应体可能以换行/BOM 开头 → 必须 trim 后再判断（旧写法 startsWith('{') 会把 JSON 错误体
  // 误判成「未知响应」，于是 429 额度提示被吞成一句 non-SSE response）
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('{') || wbQuotaLimited(trimmed)) {
    const j = safeJson(trimmed);
    const msg = (j && (j.msg || (j.error && j.error.message))) || trimmed.slice(0, 120) || 'json error';
    const retryAfterMs = wbQuotaResetMs(msg) || wbQuotaResetMs(trimmed);
    return {
      ok: false, error: msg, latencyMs: Date.now() - t0, status: out.status,
      rateLimited: wbQuotaLimited(msg) || out.status === 429, retryAfterMs,
    };
  }
  if (!/^data:/m.test(text)) {
    return { ok: false, error: wbOpaqueBodyMsg(out.status, text), latencyMs: Date.now() - t0, status: out.status };
  }
  return { ok: true, latencyMs: Date.now() - t0, status: 200 };
}

// ─────────────────────────── Anthropic ↔ OpenAI 转换 ───────────────────────────
// 极简适配。功能：
//   Anthropic Request -> OpenAI Chat Request
//   OpenAI Chat Response -> Anthropic Response (non-stream)
//   OpenAI Chat Stream chunks -> Anthropic SSE events
// 内部约定：工具结果里的图片没法塞进 OpenAI 的 tool 消息（只允许文本部件），
// 于是紧跟一条以该标记打头的 user 消息承载图片；转到原生 Anthropic 出站时会被并回 tool_result 块。
const TOOL_RESULT_IMAGE_MARK = '[tool_result image]';
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
    else if (tc.type === 'none') out.tool_choice = 'none';
    // Anthropic 的 disable_parallel_tool_use（一次只准调一个工具）↔ OpenAI 的 parallel_tool_calls:false
    if (tc.disable_parallel_tool_use) out.parallel_tool_calls = false;
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
    const toolResultImages = []; // 工具结果里带的图片（不能塞进 tool 消息，见下）
    for (const b of m.content) {
      if (b.type === 'text') textParts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') {
        // Anthropic 的图片源有两种：{type:'base64', media_type, data} 与 {type:'url', url}。
        // 以前只拼 base64 形态，遇到 url 型会把 undefined 拼进 data URL（变成一张空图）——那是静默丢图的另一种写法。
        const src = b.source || {};
        if (src.type === 'url' && src.url) imageParts.push({ type: 'image_url', image_url: { url: src.url } });
        else if (src.data) imageParts.push({ type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } });
        // 两种都没有（空 source）→ 不产出任何 block，胜过产出一张空图
      } else if (b.type === 'tool_use') {
        toolUses.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
      } else if (b.type === 'tool_result') {
        // tool_result 的 content 可能是 string，也可能是 blocks（text / image 混排，例如"截图"类工具）。
        const parts = Array.isArray(b.content)
          ? b.content
          : [{ type: 'text', text: typeof b.content === 'string' ? b.content : '' }];
        const texts = [];
        for (const c of parts) {
          if (c.type === 'text') texts.push(c.text);
          else if (c.type === 'image') {
            const src = c.source || {};
            if (src.type === 'url' && src.url) toolResultImages.push({ type: 'image_url', image_url: { url: src.url } });
            else if (src.data) toolResultImages.push({ type: 'image_url', image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` } });
          }
        }
        let text = texts.filter(Boolean).join('\n').trim();
        // Anthropic 的 is_error 语义是"这个工具执行失败了"。OpenAI 协议没有等价字段，
        // 只能带一个显式标记——否则模型会把失败信息当成正常结果，接着往下编。
        if (b.is_error) text = ('[tool_error] ' + text).trim();
        toolResults.push({ tool_call_id: b.tool_use_id, content: text || '(ok)' });
      }
      // 刻意丢弃的块（不是漏了）：
      //   · thinking / redacted_thinking —— OpenAI 格式的上游没有签名校验需求，把思维链塞回 content 反而会
      //     污染上下文（DeepSeek 一类还明确要求不要把 reasoning_content 回传）；结构上也不会因此缺件，
      //     因为紧随其后的 tool_use 已经被转成 tool_calls。
      //   · server_tool_use / web_search_tool_result / document 等服务端块 —— 无法在"转成 OpenAI 格式再发给
      //     第三方渠道"的链路上复现。
      //   · cache_control / metadata / top_k —— 无对应字段，转发也是噪音。
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
      // 工具结果里的图片：OpenAI 的 tool 消息只允许文本部件（塞 image_url 会被上游 400），
      // 所以紧跟在本轮 tool 消息之后补一条 user 消息把这（几）张图带上——视觉模型照样看得到，
      // 且顺序上紧挨着对应的工具结果，语义不散。
      if (toolResultImages.length) {
        out.messages.push({ role: 'user', content: [{ type: 'text', text: TOOL_RESULT_IMAGE_MARK }, ...toolResultImages] });
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
      // id 必须与客户端回传 tool_result.tool_use_id 一致：走 sanitizeToolId 保证它是 Anthropic 允许的字符集
      // （非法字符会被上游或被客户端 SDK 拒），且与请求侧 sanitizeOpenAIToolIds 的做法保持一致
      content.push({ type: 'tool_use', id: sanitizeToolId(tc.id), name: tc.function?.name || '', input });
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
      // OpenAI 的 cached_tokens ↔ Anthropic 的 cache_read_input_tokens（Claude 客户端拿它算成本/命中率）
      ...(oai.usage?.prompt_tokens_details?.cached_tokens != null
        ? { cache_read_input_tokens: oai.usage.prompt_tokens_details.cached_tokens }
        : {}),
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

// 把 OpenAI 流式 chunk 转 Anthropic SSE —— ★ 必须**有状态**。
// block 索引、tool_calls 的参数分片累积、usage 与 stop_reason 都要跨 chunk 保持；
// 早期实现是"上游每来一行就新建一个生成器转一次"，于是每个 chunk 都重发一次 message_start，
// 工具参数的 JSON 分片也各转各的（`{"city"` 与 `:"上海"}` 落在两个不同的 tool_use 块里），
// 客户端拼出来必然是碎的 —— 流式工具调用因此完全不可用。改为转换器实例 + start/push/end。
function createAnthropicStreamConverter(modelAlias) {
  const msgId = `msg_${Date.now()}`;
  let nextIndex = 0;
  let textIndex = -1;
  let finishReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  const toolBlock = new Map(); // deltaIndex → { index, id, name, argsBuf, started }
  let ended = false;
  return {
    start() {
      return [{ event: 'message_start', data: { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: modelAlias, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } } }];
    },
    push(c) {
      const out = [];
      const choice = c.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        if (textIndex < 0) {
          textIndex = nextIndex++;
          out.push({ event: 'content_block_start', data: { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } } });
        }
        out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta } } });
      }
      // tool_calls 增量：OpenAI 按 index 分流，每个 index 一个 tool_use block
      if (Array.isArray(choice?.delta?.tool_calls)) {
        for (const tc of choice.delta.tool_calls) {
          const di = tc.index ?? 0;
          let blk = toolBlock.get(di);
          if (!blk) { blk = { index: nextIndex++, id: '', name: '', argsBuf: '', started: false }; toolBlock.set(di, blk); }
          if (tc.id && !blk.id) blk.id = tc.id;
          if (tc.function?.name && !blk.name) blk.name = tc.function.name;
          if (tc.function?.arguments) blk.argsBuf += tc.function.arguments;
          if (!blk.started && (blk.name || blk.id)) {
            blk.started = true;
            // tool_use block 起始要带 input:{}（官方 SDK 以它为累积 base，再叠 input_json_delta）
            out.push({ event: 'content_block_start', data: { type: 'content_block_start', index: blk.index, content_block: { type: 'tool_use', id: sanitizeToolId(blk.id), name: blk.name, input: {} } } });
          }
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (c.usage) usage = { input_tokens: c.usage.prompt_tokens || 0, output_tokens: c.usage.completion_tokens || 0 };
      return out;
    },
    end() {
      if (ended) return []; // 幂等：上游既发了 [DONE] 又走收尾钩子时不重复发
      ended = true;
      const out = [];
      if (textIndex >= 0) out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } });
      for (const [, blk] of toolBlock) {
        if (!blk.started) continue;
        out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: blk.index, delta: { type: 'input_json_delta', partial_json: blk.argsBuf || '{}' } } });
        out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: blk.index } });
      }
      out.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null }, usage } });
      out.push({ event: 'message_stop', data: { type: 'message_stop' } });
      return out;
    },
  };
}

// 兼容入口：把一批 chunk 一次性转成事件序列（单元测试与一次性调用点用）
function* openAIStreamToAnthropicSSE(chunks, modelAlias) {
  const conv = createAnthropicStreamConverter(modelAlias);
  yield* conv.start();
  for (const c of chunks) yield* conv.push(c);
  yield* conv.end();
}

// 事件数组 → Anthropic SSE 文本（路由逐行转换时用）
function anthropicEventsToSSE(events) {
  return events.map((e) => sseEncode(e.event, e.data)).join('');
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
  // functionCall / functionResponse 的配对：Gemini **认函数名不认 id**，而 OpenAI 内部格式要求
  // assistant.tool_calls[].id 与 role:'tool'.tool_call_id 严格配对（上游不配对就 400）。
  // 所以在入站这一层替它合成 id（沿用出站方向 geminiPartsToOai 的 `call_g<n>_<name>` 命名），
  // 用"同名 FIFO 队列"配对 —— 同一轮里同一函数被调多次也能按出现顺序对上。
  const idQueues = new Map(); // name → [id, ...]
  let callSeq = 0;
  for (const c of contents) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    // Gemini 部件 → OpenAI content blocks。**顺序必须保留**：图片与文本的相对位置对视觉模型有语义
    // （先图后问 vs 先问后图，回答会不一样）。text 原样转文本；inlineData（base64）与 fileData（fileUri）
    // 转 image_url；functionCall / functionResponse 走**真工具报文**（见下）。
    const blocks = [];
    const calls = [];      // 本条目里的 functionCall → 挂到 assistant 消息的 tool_calls
    const toolMsgs = [];   // 本条目里的 functionResponse → 各成一条 role:'tool'
    for (const p of (c.parts || [])) {
      const inline = p.inlineData || p.inline_data;
      const file = p.fileData || p.file_data;
      if (p.text) blocks.push({ type: 'text', text: p.text });
      else if (inline && inline.data) {
        blocks.push({ type: 'image_url', image_url: { url: `data:${inline.mimeType || inline.mime_type || 'image/png'};base64,${inline.data}` } });
      } else if (file && (file.fileUri || file.file_uri)) {
        blocks.push({ type: 'image_url', image_url: { url: file.fileUri || file.file_uri } });
      } else if (p.functionCall) {
        // 工具调用（PT33）：以前这里降级成一段 `{"tool_calls": [...]}` JSON 文本 —— 那是给"没有工具能力的
        // 渠道"看的仿真文本，而 tool-emu.renderEmulatedMessages 本来就会把**真的** assistant.tool_calls
        // 渲染回同样的文本，所以改成真报文后，notion/genspark 这些仿真链一路上什么也没少。
        const name = p.functionCall.name || 'tool';
        const id = `call_g${callSeq++}_${name}`;
        if (!idQueues.has(name)) idQueues.set(name, []);
        idQueues.get(name).push(id);
        const args = p.functionCall.args;
        calls.push({ id, type: 'function', function: { name, arguments: JSON.stringify(args === undefined ? {} : args) } });
      } else if (p.functionResponse) {
        const name = p.functionResponse.name || 'tool';
        const resp = p.functionResponse.response === undefined ? {} : p.functionResponse.response;
        const content = typeof resp === 'string' ? resp : JSON.stringify(resp);
        const q = idQueues.get(name);
        if (q && q.length) {
          toolMsgs.push({ role: 'tool', tool_call_id: q.shift(), content });
        } else {
          // 配不上（客户端无状态：只回结果、不带上文的 functionCall）：**不能**硬造 tool_call_id ——
          // OpenAI 上游看到"有 tool 消息却没有配对的 assistant.tool_calls"会直接 400。
          // 退回文本形态（与旧行为一致），结果照样进得了上下文，且不会把请求弄坏。
          blocks.push({ type: 'text', text: '[工具 ' + name + ' 的执行结果如下]\n' + content + '\n[请根据以上工具结果继续]' });
        }
      }
    }
    const hasImage = blocks.some((b) => b.type === 'image_url');
    const textOfBlocks = () => blocks.map((b) => b.text).filter(Boolean).join('\n');
    if (role === 'assistant') {
      if (!blocks.length && !calls.length) { /* 空条目：跳过，别塞空消息惹上游 400 */ }
      else {
        const msg = { role: 'assistant', content: hasImage ? blocks : (textOfBlocks() || null) };
        if (calls.length) msg.tool_calls = calls;
        messages.push(msg);
      }
    } else if (hasImage) {
      messages.push({ role: 'user', content: blocks });
    } else {
      // 纯文本仍用字符串形态：上游与各回退渠道普遍只认 string（数组形态只有 OpenAI 官方语义能接受）
      const text = textOfBlocks();
      if (text) messages.push({ role: 'user', content: text });
    }
    for (const t of toolMsgs) messages.push(t);
  }
  const gen = body.generationConfig || {};
  // Gemini functionDeclarations → OpenAI tools
  const tools = [];
  const decls = (body.tools && body.tools[0] && body.tools[0].functionDeclarations)
    || (body.tools && body.tools[0] && body.tools[0].function_declarations) || [];
  // toolConfig.functionCallingConfig 三态（AUTO / ANY / NONE）。
  // 注意以前这里读的是 `body.tool_choice` —— 那是 **OpenAI 的字段名**，真正的 Gemini 客户端从来不发它，
  // 所以"声明了 tools 的 Gemini 客户端"拿到的永远是 auto，`NONE`/`ANY` 形同虚设（PT33 的一部分）。
  const fcc = (body.toolConfig && body.toolConfig.functionCallingConfig)
    || (body.tool_config && body.tool_config.function_calling_config) || {};
  const fccMode = String(fcc.mode || '').toUpperCase();
  const allowed = fcc.allowedFunctionNames || fcc.allowed_function_names || [];
  // ANY + 白名单 = "只准调这几个"：OpenAI 只有"强制某一个"这一种表达能力，
  // 于是把工具集**也跟着收窄**（比只写 required 更接近原意），多于一个时退化成 required（有损，docs/protocols.md 已记）。
  for (const d of decls) {
    if (fccMode === 'ANY' && allowed.length && !allowed.includes(d.name)) continue;
    tools.push({
      type: 'function',
      function: {
        name: d.name,
        description: d.description || '',
        parameters: d.parameters || {},
      },
    });
  }
  let toolChoice;
  if (fccMode === 'ANY') toolChoice = allowed.length === 1 ? { type: 'function', function: { name: allowed[0] } } : 'required';
  else if (fccMode === 'NONE') toolChoice = 'none';
  else toolChoice = body.tool_choice || 'auto';   // 兼顾"用 OpenAI 字段名硬塞进来"的客户端
  return {
    model,
    messages,
    max_tokens: gen.maxOutputTokens,
    temperature: gen.temperature,
    top_p: gen.topP,
    stream: !!body.stream,
    ...(tools.length ? { tools, tool_choice: toolChoice } : {}),
  };
}

function openAIToGeminiResponse(oai) {
  const choice = oai.choices?.[0];
  const msg = choice?.message || {};
  const text = oaiTextOf(msg.content);   // 用 oaiTextOf：content 是数组（跨协议带图）时也能取到文本
  const calls = (msg.tool_calls || []).filter((tc) => tc && tc.function && tc.function.name);
  const parts = [];
  if (text) parts.push({ text });
  // 工具调用 → Gemini 的 functionCall（PT33：以前只取 content，客户端拿不到任何 functionCall）。
  // Gemini 的 args 必须是**对象**，所以这里把 OpenAI 的 JSON 字符串解析回来；解析不了就原样塞进
  // _raw_arguments（宁可让模型看到半截字符串，也不静默丢件）。
  for (const tc of calls) {
    let args = {};
    try { const a = JSON.parse(tc.function.arguments || '{}'); args = a && typeof a === 'object' ? a : { value: a }; }
    catch { args = { _raw_arguments: String(tc.function.arguments || '') }; }
    parts.push({ functionCall: { name: tc.function.name, args } });
  }
  // Gemini 没有 "tool_calls" 这个 finishReason：有工具调用时按 STOP 结束（与 geminiStopToFinish 互逆）
  const fr = choice?.finish_reason === 'length' ? 'MAX_TOKENS'
    : (choice?.finish_reason === 'content_filter' || choice?.finish_reason === 'refusal') ? 'SAFETY'
      : 'STOP';
  return {
    candidates: [{
      content: { role: 'model', parts },
      finishReason: fr,
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

// canonical OpenAI SSE → Gemini 客户端 SSE。
// state（可选）：同一路流式请求内复用，用来攒 functionCall 的参数分片。
// 为什么必须有状态：OpenAI 的 tool_calls 是**按 index 拆片**发的（先给 name，再一片片给 arguments），
// 而 Gemini 的 functionCall.args 必须是**一个完整对象** —— 所以缓冲到收尾再发。
// 这个取舍与反方向（createGeminiToOaiStream 也是把 functionCall 攒到收尾）完全对称：
// 宁可晚一点，也不能把半个参数交给客户端。
function openAIStreamToGeminiSSE(chunks, state) {
  const st = state || {};
  if (!st.calls) st.calls = new Map();
  const out = [];
  for (const c of chunks) {
    const choice = c.choices?.[0];
    const d = choice?.delta || {};
    const text = d.content || '';
    if (text) {
      out.push({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] });
    }
    for (const tc of d.tool_calls || []) {
      const idx = tc.index == null ? 0 : tc.index;
      const cur = st.calls.get(idx) || { name: '', args: '' };
      if (tc.function && tc.function.name) cur.name = tc.function.name;
      if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
      if (cur.name) st.calls.set(idx, cur);
    }
    // 结束分片必须带上 finishReason —— 否则 Gemini 流式客户端永远等不到"回答结束"，
    // 只能靠连接断开猜（此前这里只转发 text，结束帧被整帧丢弃）。
    if (choice?.finish_reason) {
      const fr = choice.finish_reason === 'length' ? 'MAX_TOKENS'
        : (choice.finish_reason === 'content_filter' || choice.finish_reason === 'refusal') ? 'SAFETY' : 'STOP';
      // 攒好的 functionCall 先单独发一帧（这正是真实 Gemini 的形状：functionCall 一帧、finishReason 一帧），
      // 免得客户端在读到 finishReason 时就停手、把工具调用漏掉。
      const callParts = [];
      for (const idx of [...st.calls.keys()].sort((a, b) => a - b)) {
        const cur = st.calls.get(idx);
        if (!cur || !cur.name) continue;
        let args = {};
        try { const a = JSON.parse(cur.args || '{}'); args = a && typeof a === 'object' ? a : { value: a }; }
        catch { args = { _raw_arguments: String(cur.args || '') }; }
        callParts.push({ functionCall: { name: cur.name, args } });
      }
      st.calls.clear();
      if (callParts.length) {
        out.push({ candidates: [{ content: { role: 'model', parts: callParts }, index: 0 }] });
      }
      const g = { candidates: [{ content: { role: 'model', parts: [] }, finishReason: fr, index: 0 }] };
      if (c.usage) {
        g.usageMetadata = {
          promptTokenCount: c.usage.prompt_tokens || 0,
          candidatesTokenCount: c.usage.completion_tokens || 0,
          totalTokenCount: c.usage.total_tokens || ((c.usage.prompt_tokens || 0) + (c.usage.completion_tokens || 0)),
        };
      }
      out.push(g);
    }
  }
  return out;
}

// ═══════════════════ 原生出站：内部 OpenAI ⇄ Anthropic / Gemini ═══════════════════
// 背景：过去 `protocol` 只决定**探活方式**与对外路由，出站一律 OpenAI 格式（chat/completions + Bearer）
// ⇒ 声明成 anthropic / gemini 协议的渠道**根本无法用于聊天**（拿 OpenAI 格式去敲 /v1/messages 必 400）。
// 这一节补齐出站：内部统一格式(OpenAI) → 上游原生格式，回来再把原生响应转回 OpenAI，
// 于是"客户端说哪套协议"与"渠道讲哪套协议"彻底解耦：三条客户端路由 × 两种原生渠道都能通。
//
// 架构落点（刻意只动两处）：
//   · dispatchRequest：按候选渠道的 protocol 覆盖 encodeOutgoing / buildOutgoingUrl / buildOutgoingHeaders，
//     并挂上响应翻译钩子 —— 单点注入，路由侧代码一行不用改；
//   · tryChannel：非流式把翻译后的文本交给既有回调，流式把原生 SSE 逐行翻译成 OpenAI SSE 后再喂给既有 onStreamChunk。
// 信息损失（诚实记录）：跨到 OpenAI 内部格式时，Anthropic 的 cache_control / metadata / top_k、
// thinking 块的签名无法携带；tool_use.id 会经 sanitizeToolId 清洗。原生渠道与客户端同为 Anthropic 时
// 也会走这一遍（当前不做"同协议直通"，两条路径维护成本更高）。

function oaiContentBlocks(content) {
  // 内部 content（字符串 or blocks）→ [{text}|{image_url}]，供两种原生协议各自取用
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text });
    else if (b.type === 'image_url' && b.image_url) out.push({ type: 'image_url', url: typeof b.image_url === 'string' ? b.image_url : b.image_url.url });
  }
  return out;
}
function oaiTextOf(content) {
  return oaiContentBlocks(content).filter((b) => b.type === 'text').map((b) => b.text).join('');
}
function parseDataUrl(url) {
  // data:image/png;base64,AAAA → {mediaType, data}
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(url || ''));
  if (!m) return null;
  return { mediaType: m[1] || 'image/png', base64: !!m[2], data: m[3] };
}

// ── OpenAI 请求 → Anthropic /v1/messages 请求体 ──
function oaiRequestToAnthropic(oai, candidate) {
  const out = {
    model: candidate.upstream,
    // Anthropic 强制要求 max_tokens（OpenAI 可省略）——缺省给 4096，否则上游直接 400
    max_tokens: Number(oai.max_tokens) > 0 ? Math.floor(Number(oai.max_tokens)) : 4096,
  };
  if (oai.temperature !== undefined) out.temperature = oai.temperature;
  if (oai.top_p !== undefined) out.top_p = oai.top_p;
  if (oai.stop) out.stop_sequences = Array.isArray(oai.stop) ? oai.stop : [oai.stop];
  if (oai.stream) out.stream = true;

  const sys = [];
  const msgs = [];
  const seenIds = new Map();
  const pushMsg = (role, blocks) => {
    // Anthropic 要求角色交替：连续的同类角色必须合并
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else msgs.push({ role, content: blocks });
  };

  for (const m of Array.isArray(oai.messages) ? oai.messages : []) {
    if (!m) continue;
    if (m.role === 'system' || m.role === 'developer') { const t = oaiTextOf(m.content); if (t) sys.push(t); continue; }

    if (m.role === 'tool') {
      // OpenAI 的 tool 消息 → Anthropic 的 user + tool_result（原生就支持图片块）
      const blocks = [];
      const text = oaiTextOf(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const b of oaiContentBlocks(m.content)) {
        if (b.type !== 'image_url') continue;
        const img = anthropicImageSource(b.url);
        if (img) blocks.push({ type: 'image', source: img });
      }
      pushMsg('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id || 'tool', content: blocks.length ? blocks : '' }]);
      continue;
    }

    if (m.role === 'assistant') {
      const blocks = [];
      const t = oaiTextOf(m.content);
      if (t) blocks.push({ type: 'text', text: t });
      for (const tc of m.tool_calls || []) {
        const fn = tc && tc.function ? tc.function : {};
        if (!fn.name) continue;
        let input = {};
        try { input = JSON.parse(fn.arguments || '{}'); } catch { input = { _raw_arguments: String(fn.arguments || '') }; }
        blocks.push({ type: 'tool_use', id: sanitizeToolId(tc.id, seenIds), name: fn.name, input });
      }
      if (blocks.length) pushMsg('assistant', blocks);
      continue;
    }

    // user：注意"工具结果图片"的内部约定 —— 工具结果后面那条 user 消息以 [tool_result image] 打头，
    // 这里把图**并回前一条 tool_result 的 content 里**，并丢掉锚点文本（原生上游看不到我们的内部约定）
    const blocks = oaiContentBlocks(m.content);
    const isImageAnchor = blocks.length > 1 && blocks[0].type === 'text' && blocks[0].text === TOOL_RESULT_IMAGE_MARK;
    const prev = msgs[msgs.length - 1];
    if (isImageAnchor && prev && prev.role === 'user') {
      const tr = prev.content.find((b) => b.type === 'tool_result');
      if (tr) {
        if (typeof tr.content === 'string') tr.content = tr.content ? [{ type: 'text', text: tr.content }] : [];
        for (const b of blocks.slice(1)) {
          const img = anthropicImageSource(b.url);
          if (img) tr.content.push({ type: 'image', source: img });
        }
        continue;
      }
    }
    const ub = [];
    for (const b of blocks) {
      if (b.type === 'text') ub.push({ type: 'text', text: b.text });
      else if (b.type === 'image_url') { const img = anthropicImageSource(b.url); if (img) ub.push({ type: 'image', source: img }); }
    }
    if (ub.length) pushMsg('user', ub);
  }
  if (sys.length) out.system = sys.join('\n\n');
  out.messages = msgs;

  // tools / tool_choice：Anthropic 没有 "none" 语义（保留 tools 就等于 auto），所以 none 时直接去掉 tools
  if (Array.isArray(oai.tools) && oai.tools.length && oai.tool_choice !== 'none') {
    out.tools = oai.tools
      .filter((t) => t && t.function && t.function.name)
      .map((t) => ({ name: t.function.name, description: t.function.description || undefined, input_schema: t.function.parameters || { type: 'object', properties: {} } }));
    const tc = oai.tool_choice;
    if (tc === 'required') out.tool_choice = { type: 'any' };
    else if (tc && typeof tc === 'object' && tc.function && tc.function.name) out.tool_choice = { type: 'tool', name: tc.function.name };
    else out.tool_choice = { type: 'auto' };
    if (oai.parallel_tool_calls === false) out.disable_parallel_tool_use = true;
  }
  return out;
}
function anthropicImageSource(url) {
  const d = parseDataUrl(url);
  if (d) return d.base64 ? { type: 'base64', media_type: d.mediaType, data: d.data } : null; // 非 base64 的 data: 无法表达
  if (/^https?:\/\//i.test(String(url || ''))) return { type: 'url', url };                 // Anthropic 支持 url 型 source
  return null;
}

// ── Anthropic 响应 → OpenAI 响应 ──
function anthropicStopToFinish(sr) {
  return { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', stop_sequence: 'stop', refusal: 'content_filter', pause_turn: 'stop' }[sr] || 'stop';
}
function anthropicToOaiResponse(ant, model) {
  const texts = [];
  const toolCalls = [];
  let reasoning = '';
  const seenIds = new Map();
  for (const b of (ant && ant.content) || []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') texts.push(b.text || '');
    else if (b.type === 'thinking') reasoning += b.thinking || '';
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: sanitizeToolId(b.id, seenIds), type: 'function',
        function: { name: b.name || 'tool', arguments: JSON.stringify(b.input === undefined ? {} : b.input) },
      });
    }
  }
  const text = texts.join('');
  const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const inp = (ant && ant.usage && ant.usage.input_tokens) || 0;
  const outp = (ant && ant.usage && ant.usage.output_tokens) || 0;
  const cached = ant && ant.usage && ant.usage.cache_read_input_tokens;
  const usage = { prompt_tokens: inp, completion_tokens: outp, total_tokens: inp + outp };
  if (cached) usage.prompt_tokens_details = { cached_tokens: cached };
  return {
    id: (ant && ant.id) || 'chatcmpl-native',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || (ant && ant.model) || undefined,
    choices: [{ index: 0, message, finish_reason: anthropicStopToFinish(ant && ant.stop_reason) }],
    usage,
  };
}
function oaiChunkLine(id, model, delta, finish, usage) {
  const c = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish === undefined ? null : finish }] };
  if (usage) c.usage = usage;
  return `data: ${JSON.stringify(c)}\n\n`;
}
const OAI_SSE_DONE = 'data: [DONE]\n\n';

// ── 有状态：Anthropic SSE → OpenAI SSE（跨 chunk 状态：块序号、工具序号、是否已收尾）──
function createAnthropicToOaiStream(model) {
  let id = 'chatcmpl-native', mdl = model, roleSent = false, done = false, finishSent = false;
  const toolIndexByBlock = new Map();
  let nextToolIdx = 0, usage = null;
  const out = [];
  const push = (raw) => {
    out.length = 0;
    if (done) return out;
    const line = String(raw || '').trim();
    if (!line.startsWith('data:')) return out;              // event: 行 / 空行直接忽略
    let ev = null;
    try { ev = JSON.parse(line.slice(5).trim()); } catch { return out; }
    if (!ev || typeof ev !== 'object') return out;
    if (ev.type === 'message_start') {
      const msg = ev.message || {};
      if (msg.id) id = msg.id;
      if (msg.model) mdl = model || msg.model;
      if (msg.usage) usage = { prompt_tokens: msg.usage.input_tokens || 0, completion_tokens: 0, total_tokens: msg.usage.input_tokens || 0 };
      roleSent = true;
      out.push(oaiChunkLine(id, mdl, { role: 'assistant', content: '' }, null));
    } else if (ev.type === 'content_block_start') {
      const cb = ev.content_block || {};
      if (cb.type === 'tool_use') {
        const idx = nextToolIdx++;
        toolIndexByBlock.set(ev.index, idx);
        out.push(oaiChunkLine(id, mdl, { tool_calls: [{ index: idx, id: sanitizeToolId(cb.id), type: 'function', function: { name: cb.name || 'tool', arguments: '' } }] }, null));
      } else if (!roleSent) {
        roleSent = true;
        out.push(oaiChunkLine(id, mdl, { role: 'assistant', content: '' }, null));
      }
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta' && d.text) out.push(oaiChunkLine(id, mdl, { content: d.text }, null));
      else if (d.type === 'thinking_delta' && d.thinking) out.push(oaiChunkLine(id, mdl, { reasoning_content: d.thinking }, null));
      else if (d.type === 'input_json_delta') {
        const idx = toolIndexByBlock.has(ev.index) ? toolIndexByBlock.get(ev.index) : 0;
        out.push(oaiChunkLine(id, mdl, { tool_calls: [{ index: idx, function: { arguments: d.partial_json || '' } }] }, null));
      }
    } else if (ev.type === 'message_delta') {
      const d = ev.delta || {};
      if (ev.usage && ev.usage.output_tokens) {
        usage = usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        usage.completion_tokens = ev.usage.output_tokens;
        usage.total_tokens = (usage.prompt_tokens || 0) + (ev.usage.output_tokens || 0);
      }
      out.push(oaiChunkLine(id, mdl, {}, anthropicStopToFinish(d.stop_reason), null));
      finishSent = true;
    } else if (ev.type === 'message_stop') {
      if (!finishSent) { out.push(oaiChunkLine(id, mdl, {}, 'stop', null)); finishSent = true; }
      out.push(OAI_SSE_DONE);
      done = true;
    }
    return out;
  };
  // 幂等收尾：上游没发 message_stop（异常断流）时也必须给客户端一个完整结束
  const end = () => {
    out.length = 0;
    if (done) return out;
    if (!finishSent) out.push(oaiChunkLine(id, mdl, {}, 'stop', usage || null));
    out.push(OAI_SSE_DONE);
    done = true;
    return out;
  };
  return { push, end };
}

// ── OpenAI 请求 → Gemini generateContent 请求体 ──
function oaiRequestToGemini(oai) {
  const contents = [];
  const sys = [];
  const toolNameById = new Map();
  const pushPart = (role, part) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(part);
    else contents.push({ role, parts: [part] });
  };
  for (const m of Array.isArray(oai.messages) ? oai.messages : []) {
    if (!m) continue;
    if (m.role === 'system' || m.role === 'developer') { const t = oaiTextOf(m.content); if (t) sys.push(t); continue; }
    if (m.role === 'tool') {
      // Gemini 的 functionResponse 认**函数名**不认 id → 从上游 assistant 的 tool_calls 里查名字
      const name = toolNameById.get(m.tool_call_id) || m.tool_call_id || 'tool';
      const text = oaiTextOf(m.content);
      let response = {};
      try { const p = JSON.parse(text); response = p && typeof p === 'object' ? p : { result: text }; } catch { response = { result: text }; }
      pushPart('user', { functionResponse: { name, response } });
      continue;
    }
    if (m.role === 'assistant') {
      const t = oaiTextOf(m.content);
      if (t) pushPart('model', { text: t });
      for (const tc of m.tool_calls || []) {
        const fn = tc && tc.function ? tc.function : {};
        if (!fn.name) continue;
        if (tc.id) toolNameById.set(tc.id, fn.name);
        let args = {};
        try { const a = JSON.parse(fn.arguments || '{}'); args = a && typeof a === 'object' ? a : { value: a }; } catch { args = { _raw_arguments: String(fn.arguments || '') }; }
        pushPart('model', { functionCall: { name: fn.name, args } });
      }
      continue;
    }
    for (const part of oaiContentToGeminiParts(m.content)) pushPart('user', part);
  }
  const out = { contents };
  if (sys.length) out.systemInstruction = { parts: [{ text: sys.join('\n\n') }] };
  const gc = {};
  if (Number(oai.max_tokens) > 0) gc.maxOutputTokens = Math.floor(Number(oai.max_tokens));
  if (oai.temperature !== undefined) gc.temperature = oai.temperature;
  if (oai.top_p !== undefined) gc.topP = oai.top_p;
  if (oai.stop) gc.stopSequences = Array.isArray(oai.stop) ? oai.stop : [oai.stop];
  if (Object.keys(gc).length) out.generationConfig = gc;
  if (Array.isArray(oai.tools) && oai.tools.length) {
    const decls = oai.tools.filter((t) => t && t.function && t.function.name)
      .map((t) => ({ name: t.function.name, description: t.function.description || undefined, parameters: t.function.parameters || { type: 'object', properties: {} } }));
    if (decls.length) {
      out.tools = [{ functionDeclarations: decls }];
      const tc = oai.tool_choice;
      // 好消息：Gemini 有 NONE（Anthropic 没有），所以三态能完整映射
      const fcc = { mode: tc === 'required' ? 'ANY' : tc === 'none' ? 'NONE' : 'AUTO' };
      if (tc && typeof tc === 'object' && tc.function && tc.function.name) fcc.allowedFunctionNames = [tc.function.name];
      out.toolConfig = { functionCallingConfig: fcc };
    }
  }
  return out;
}
function oaiContentToGeminiParts(content) {
  const parts = [];
  for (const b of oaiContentBlocks(content)) {
    if (b.type === 'text') parts.push({ text: b.text });
    else if (b.type === 'image_url') {
      const d = parseDataUrl(b.url);
      if (d && d.base64) parts.push({ inlineData: { mimeType: d.mediaType, data: d.data } });
      else if (/^https?:\/\//i.test(String(b.url || ''))) parts.push({ fileData: { fileUri: b.url } });
    }
  }
  return parts;
}

// ── Gemini 响应 → OpenAI 响应 ──
function geminiStopToFinish(fr) {
  if (fr === 'MAX_TOKENS') return 'length';
  if (fr === 'SAFETY' || fr === 'RECITATION' || fr === 'BLOCKLIST' || fr === 'PROHIBITED_CONTENT' || fr === 'SPII') return 'content_filter';
  return 'stop';
}
function geminiPartsToOai(parts) {
  const texts = [];
  const toolCalls = [];
  let n = 0;
  for (const p of parts || []) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.text === 'string') texts.push(p.text);
    else if (p.functionCall && p.functionCall.name) {
      toolCalls.push({
        id: `call_g${n++}_${p.functionCall.name}`, type: 'function',
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args === undefined ? {} : p.functionCall.args) },
      });
    }
  }
  return { text: texts.join(''), toolCalls };
}
function geminiToOaiResponse(gem, model) {
  const cand = (gem && gem.candidates && gem.candidates[0]) || {};
  const { text, toolCalls } = geminiPartsToOai(cand.content && cand.content.parts);
  const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const um = (gem && gem.usageMetadata) || {};
  return {
    id: (gem && gem.responseId) || 'chatcmpl-native',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || (gem && gem.modelVersion) || undefined,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : geminiStopToFinish(cand.finishReason) }],
    usage: {
      prompt_tokens: um.promptTokenCount || 0,
      completion_tokens: um.candidatesTokenCount || 0,
      total_tokens: um.totalTokenCount || ((um.promptTokenCount || 0) + (um.candidatesTokenCount || 0)),
    },
  };
}

// ── 有状态：Gemini SSE → OpenAI SSE ──
// alt=sse 的每个 chunk 带增量 text；functionCall 可能整块到达（也可能被切分），
// 所以把 functionCall 缓冲到收尾再发 —— 宁可晚一点，也不能发半个参数给客户端。
function createGeminiToOaiStream(model) {
  let id = 'chatcmpl-native', mdl = model, roleSent = false, finishSent = false, usage = null;
  const pendingCalls = [];
  const out = [];
  const emitCalls = (finish) => {
    if (!pendingCalls.length) return false;
    out.push(oaiChunkLine(id, mdl, { tool_calls: pendingCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: '' } })) }, null));
    out.push(oaiChunkLine(id, mdl, { tool_calls: pendingCalls.map((c, i) => ({ index: i, function: { arguments: c.args } })) }, finish || null));
    pendingCalls.length = 0;
    return true;
  };
  const push = (raw) => {
    out.length = 0;
    if (finishSent) return out;
    const line = String(raw || '').trim();
    if (!line.startsWith('data:')) return out;
    let ev = null;
    try { ev = JSON.parse(line.slice(5).trim()); } catch { return out; }
    if (!ev || typeof ev !== 'object') return out;
    if (!roleSent) { roleSent = true; out.push(oaiChunkLine(id, mdl, { role: 'assistant', content: '' }, null)); }
    if (ev.modelVersion) mdl = model || ev.modelVersion;
    if (ev.responseId) id = ev.responseId;
    const cand = (ev.candidates && ev.candidates[0]) || {};
    const { text, toolCalls } = geminiPartsToOai(cand.content && cand.content.parts);
    if (text) out.push(oaiChunkLine(id, mdl, { content: text }, null));
    for (const tc of toolCalls) pendingCalls.push({ id: tc.id, name: tc.function.name, args: tc.function.arguments });
    if (ev.usageMetadata) {
      usage = {
        prompt_tokens: ev.usageMetadata.promptTokenCount || 0,
        completion_tokens: ev.usageMetadata.candidatesTokenCount || 0,
        total_tokens: ev.usageMetadata.totalTokenCount || 0,
      };
    }
    if (cand.finishReason) {
      const finish = geminiStopToFinish(cand.finishReason);
      if (!emitCalls(finish)) out.push(oaiChunkLine(id, mdl, {}, finish, usage));
      else if (usage) out.push(oaiChunkLine(id, mdl, {}, null, usage));
      finishSent = true;
      out.push(OAI_SSE_DONE);
    }
    return out;
  };
  const end = () => {
    out.length = 0;
    if (finishSent) return out;
    if (!emitCalls('tool_calls')) out.push(oaiChunkLine(id, mdl, {}, 'stop', usage));
    finishSent = true;
    out.push(OAI_SSE_DONE);
    return out;
  };
  return { push, end };
}

// ── 原生渠道的出站 URL / 请求头（与探活保持同一套约定）──
function nativeOutgoingUrl(proto, ch, candidate, isStream) {
  const base = String(ch.def.baseUrl || '').replace(/\/+$/, '');
  if (proto === 'anthropic') {
    // baseUrl 写 https://api.anthropic.com 或 .../v1 都认
    return /\/v1$/.test(base) ? base + '/messages' : joinUrl(base, 'v1/messages');
  }
  // Gemini：模型名在 URL 路径里（请求体里没有 model），流式是 :streamGenerateContent?alt=sse
  const root = /\/v1beta$/.test(base) ? base : (/\/v1$/.test(base) ? base.replace(/\/v1$/, '/v1beta') : joinUrl(base, 'v1beta'));
  const action = isStream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return `${root}/models/${encodeURIComponent(candidate.upstream)}:${action}`;
}
function nativeOutgoingHeaders(proto, ch) {
  if (proto === 'anthropic') return { 'Content-Type': 'application/json', 'x-api-key': ch.def.apiKey, 'anthropic-version': '2023-06-01' };
  return { 'Content-Type': 'application/json', 'x-goog-api-key': ch.def.apiKey };
}
// 原生响应是"成功体"才翻译；错误体（{error:...}）原样返回，否则 4xx 判定与客户端拿到的错误就失真了
function nativeResponseTranslator(proto, requestedModel) {
  return (raw) => {
    const j = safeJson(raw);
    if (!j || typeof j !== 'object') return raw;
    if (proto === 'anthropic') {
      if (!Array.isArray(j.content)) return raw;
      return JSON.stringify(anthropicToOaiResponse(j, requestedModel));
    }
    if (!Array.isArray(j.candidates)) return raw;
    return JSON.stringify(geminiToOaiResponse(j, requestedModel));
  };
}
function nativeStreamTranslator(proto, requestedModel) {
  return () => (proto === 'anthropic' ? createAnthropicToOaiStream(requestedModel) : createGeminiToOaiStream(requestedModel));
}
// dispatchRequest 单点注入：只有 anthropic / gemini 协议渠道会覆盖这几件事
function nativeChannelOpts(proto, requestedModel) {
  return {
    encodeOutgoing: (b, c) => (proto === 'anthropic' ? oaiRequestToAnthropic(b, c) : oaiRequestToGemini(b, c)),
    buildOutgoingUrl: (ch, c, isStream) => nativeOutgoingUrl(proto, ch, c, isStream),
    buildOutgoingHeaders: (ch) => nativeOutgoingHeaders(proto, ch),
    translateResponse: nativeResponseTranslator(proto, requestedModel),
    makeStreamTranslator: nativeStreamTranslator(proto, requestedModel),
  };
}

// ── 同协议直通（v1.15）────────────────────────────────────────────────────────
// 客户端协议与渠道协议相同时**不做任何翻译**：请求用客户端原始报文（anthropic 只把 model 换成上游名；
// gemini 的模型名本来就在 URL 里），响应（含流式 SSE 字节）原样回传。
// 为什么值得：以前这条链路是"客户端报文 → 内部 OpenAI → 原生报文"，来回两趟翻译，
// 每次都要丢掉内部格式**承载不了**的字段——`thinking` / `cache_control` / `top_k` / `metadata` /
// 多段 system / `stop_sequences` 细节 / `generationConfig.seed` 之类。直通之后它们原样到达上游、
// 响应侧也不再被重排（连 `message_start` 都不再是网关"补"出来的，而是上游那一个）。
// 出站 URL/请求头与原生路径完全一致，只是不再提供 encodeOutgoing 的格式转换，
// 也不提供 translateResponse / makeStreamTranslator —— 由 tryChannel 原样读写。
function passthroughChannelOpts(proto, rawBody) {
  const raw = (rawBody && typeof rawBody === 'object') ? rawBody : {};
  return {
    passthrough: proto,
    encodeOutgoing: (b, c) => (proto === 'anthropic' ? { ...raw, model: c.upstream } : raw),
    buildOutgoingUrl: (ch, c, isStream) => nativeOutgoingUrl(proto, ch, c, isStream),
    buildOutgoingHeaders: (ch) => nativeOutgoingHeaders(proto, ch),
  };
}
// 直通模式下 token 统计仍要如实：从原生响应体里读 usage，归一成内部字段名
function nativeUsageToOpenAI(proto, j) {
  if (!j || typeof j !== 'object') return null;
  if (proto === 'anthropic' && j.usage) {
    const i = Number(j.usage.input_tokens) || 0, o = Number(j.usage.output_tokens) || 0;
    if (i || o) return { prompt_tokens: i, completion_tokens: o, total_tokens: i + o };
  }
  const g = j.usageMetadata;
  if (proto === 'gemini' && g) {
    const i = Number(g.promptTokenCount) || 0, o = Number(g.candidatesTokenCount) || 0;
    if (i || o) return { prompt_tokens: i, completion_tokens: o, total_tokens: Number(g.totalTokenCount) || i + o };
  }
  return null;
}
// 直通流式：逐行扫 usage（anthropic 的 message_start/message_delta、gemini 的 usageMetadata），
// 与原生路径一样给出真实 token 数，而不是永远退回估算
function nativeStreamUsageScan(proto, line, acc) {
  if (line.indexOf('usage') < 0) return acc || null;
  const data = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
  if (!data || data === '[DONE]') return acc || null;
  let j; try { j = JSON.parse(data); } catch { return acc || null; }
  const out = acc || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const u = nativeUsageToOpenAI(proto, j) || nativeUsageToOpenAI(proto, j.message);
  if (u) {
    if (u.prompt_tokens) out.prompt_tokens = u.prompt_tokens;
    if (u.completion_tokens) out.completion_tokens = u.completion_tokens;
    out.total_tokens = out.prompt_tokens + out.completion_tokens;
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

/* 安全响应头（v1.18.3）：纯加法，不改任何既有行为。
   - nosniff：禁止浏览器把 JSON 错误体当 HTML 解释（配合未转义回显的历史问题）
   - X-Frame-Options: DENY：控制台不需要被任何页面嵌套，直接掐掉点击劫持
   - Referrer-Policy: no-referrer：顺带治「/console?key=… 把 admin key 带进 Referer」
   - Permissions-Policy：控制台不用摄像头/麦克风/定位，一并关掉
   - CSP（v1.18.6，渗透报告第三批）：控制台是单文件内联脚本/样式，故 script/style 只能放 'unsafe-inline'
     ——真正的兜底在 connect-src 'self'（偷到 cookie 也发不出去）与 img-src/frame-ancestors。
     字体走小米 CDN：样式表在 font.sec.miui.com、字体文件在 cdn-file.hyperos.mi.com（head.html 的 preconnect 可证）。 */
const SEC_HEADERS = [
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'no-referrer'],
  ['Permissions-Policy', 'geolocation=(), microphone=(), camera=()'],
  ['Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://font.sec.miui.com; font-src 'self' https://font.sec.miui.com https://cdn-file.hyperos.mi.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  for (const [k, v] of SEC_HEADERS) res.setHeader(k, v);
  // 管理面与探针的响应不该被任何中间层缓存（含密钥与否都别留在缓存里）
  if (url.pathname.startsWith('/admin/api/') || url.pathname === '/healthz') res.setHeader('Cache-Control', 'no-store');
  try {
    // 控制台 HTML 壳：零机密（密钥不落页面，数据全走 /admin/api），放行壳本身、
    // 由前端登录门负责收 key、由 /admin/api 的每次调用强制 Bearer——「页面能开 ≠ 有权限」
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/console' || url.pathname === '/console/')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      return res.end(CONSOLE_HTML);
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      // 渗透整改 V-08：匿名面只回答"活着吗"。渠道数与密钥配置状态是内部信息，
      // 之前一并下发等于免费给未鉴权者做侦察（规模、是否值得打、密钥是否在用）。
      return sendJson(res, 200, { ok: true });
    }

    // 控制台会话登录/退出（v1.18.6）——必须在 authGate 之前：登录门手里还没有会话。
    // 登录本身计入 admin 失败限流（瞎试密钥与瞎试接口同等对待）；Bearer 直连管理面不受影响。
    if (url.pathname === '/admin/api/session') {
      if (req.method === 'POST') {
        const wait = authThrottle('admin');
        if (wait) {
          res.setHeader('Retry-After', String(wait));
          return sendJson(res, 429, { error: `too many failed admin auth attempts, retry in ${wait}s` });
        }
        const body = await safeReadJson(req);
        const key = body && typeof body === 'object' ? String(body.key == null ? '' : body.key) : '';
        if (!NOAUTH && !safeEqual(key, ADMIN_KEY)) { authFail('admin'); return unauthorized(res, 'admin'); }
        authOk('admin');
        res.setHeader('Set-Cookie', sessionCookieValue(newSessionToken()));
        return sendJson(res, 200, { ok: true, expiresInSec: Math.floor(SESSION_TTL_MS / 1000) });
      }
      if (req.method === 'DELETE') {
        const t = readSessionToken(req);
        if (t) SESSIONS.delete(t);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // 控制台 API（用 admin key 鉴权）
    if (url.pathname.startsWith('/admin/api/')) {
      if (!authGate(req, res, 'admin')) return;
      return handleAdminApi(req, res, url);
    }

    // 兼容旧的 admin 路径
    if (url.pathname === '/admin/status') {
      if (!authGate(req, res, 'admin')) return;
      return sendJson(res, 200, channelStatusAll());
    }
    if (req.method === 'POST' && url.pathname === '/admin/recheck') {
      if (!authGate(req, res, 'admin')) return;
      await probeAll();
      return sendJson(res, 200, { ok: true, checked: channels.size });
    }

    // 指标端点（v1.17）：Prometheus 文本格式（text/plain; version=0.0.4）。
    // 默认要 admin key；`metrics.public: true` 时才允许匿名抓取（放进 Prometheus 的常见做法）。
    if (req.method === 'GET' && url.pathname === '/metrics') {
      if (!METRICS_CFG.enabled) return sendJson(res, 404, upstreamErrorPayload(404, 'metrics disabled'));
      if (!METRICS_CFG.public && !authGate(req, res, 'admin')) return;
      const text = renderMetrics();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(text);
    }

    // 客户端面（/v1/*、/anthropic/*、/gemini/*）：客户端限流 + 请求计数（v1.17）。
    // 位置刻意放在**鉴权之前**：这样连"刷鉴权"的无效流量也被挡在门外（取舍见 RATE_CFG 注释）。
    // 计数用 res 的 finish/close 收尾——流式请求的 close 由客户端中断触发，也照样归还并发额度。
    if (url.pathname === '/v1/models' || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/anthropic/') || url.pathname.startsWith('/gemini/')) {
      const verdict = rateCheck();
      if (!verdict.ok) {
        res.setHeader('Retry-After', String(verdict.retryAfterSec || 1));
        metricRequest(url.pathname, 429);
        return sendJson(res, 429, upstreamErrorPayload(429, verdict.concurrent
          ? `too many concurrent requests（并发上限 ${RATE_CFG.maxConcurrent}）`
          : `rate limit exceeded（上限 ${RATE_CFG.rpm} 次/分钟）`));
      }
      rateAcquire();
      const route = url.pathname;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        rateRelease();
        metricRequest(route, res.statusCode || 0);
      };
      res.on('close', settle);
      res.on('finish', settle);
    }

    // OpenAI 兼容
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      if (!authGate(req, res, 'gateway')) return;
      return sendJson(res, 200, { object: 'list', data: aggregateModels('openai').map((id) => ({ id, object: 'model', created: 0, owned_by: 'zzcsapi' })) });
    }
    if (req.method === 'POST' && (
      url.pathname === '/v1/chat/completions' ||
      url.pathname === '/v1/embeddings' ||
      url.pathname === '/v1/responses' ||
      url.pathname === '/v1/completions'
    )) {
      if (!authGate(req, res, 'gateway')) return;
      return handleOpenAIRequest(req, res, url);
    }
    // 图片生成：OpenAI 兼容 /v1/images/generations，走 openai 协议渠道直透（复用调度/兜底/记账）
    if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
      if (!authGate(req, res, 'gateway')) return;
      return handleImageRequest(req, res, url);
    }

    // Anthropic 兼容：/anthropic/v1/messages
    if (url.pathname.startsWith('/anthropic/')) {
      if (!authGate(req, res, 'gateway')) return;
      return handleAnthropicRequest(req, res, url);
    }

    // Gemini 兼容：/gemini/v1beta/models/{model}:{action}
    if (url.pathname.startsWith('/gemini/')) {
      if (!authGate(req, res, 'gateway')) return;
      return handleGeminiRequest(req, res, url);
    }

    return sendJson(res, 404, upstreamErrorPayload(404, 'not found'));
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendJson(res, 500, upstreamErrorPayload(500, String(err && err.message || err)));
  }
});

function channelStatusAll() {
  const wstats = weightedStats(); // 轮询命中统计（算一次，避免每个渠道重算）
  const autoObs = autoWeightObserve(); // 自动权重观测（只算不生效，v1.6）
  return {
    channels: Array.from(channels.values()).map((ch) => {
      const ast = AUTO_STATE.get(ch.def.id);
      return {
      id: ch.def.id,
      name: ch.def.name || ch.def.id,
      baseUrl: ch.def.baseUrl,
      apiKey: maskSecret(ch.def.apiKey), apiKeySet: !!ch.def.apiKey,
      protocol: ch.def.protocol || 'openai',
      priority: ch.def.priority ?? 0,
      effectivePriority: effPriority(ch),
      weight: Number(ch.def.weight) > 0 ? Number(ch.def.weight) : 0,
      weightedHits: wstats.channels[ch.def.id]?.hits || 0,
      weightedShare: wstats.channels[ch.def.id]?.share || 0,
      // 自动权重观测（静默：不影响分流，只是"若启用会怎么算"的输入）
      autoH: ast ? ast.h : null,
      autoFailRate: ast ? ast.failRate : null,
      autoSamples: ast ? ast.samples : 0,
      autoLatMs: ast ? ast.latMs : null,
      autoSpeedRatio: ast ? ast.speedRatio : null,
      rollFailRate: rollFailRate(ch),
      roll: ch.roll || undefined,
      enabled: ch.def.enabled !== false,
      autoAlias: ch.def.autoAlias !== false,
      proxy: ch.def.proxy || undefined,
      headers: ch.def.headers || undefined,
      status: ch.status,
      lastCheck: ch.lastCheck,
      latencyMs: ch.latencyMs,
      consecutiveFail: ch.consecutiveFail,
      cooldownUntil: ch.cooldownUntil,
      // 观察期（探测"半愈合"过、还欠着失败的账）：排序排在健康渠道之后、不进加权池，控制台/回归都靠它判读
      probation: !!ch.probation,
      lastError: ch.lastError,
      codexQuota: ch.codexQuota || undefined,
      aliases: Array.from(ch.aliasMap.entries()).map(([a, u]) => ({ alias: a, upstream: u })),
      upstreamModels: ch.models,
      notionUsage: ch.notion && ch.notion.usage ? ch.notion.usage : undefined,
      };
    }),
    // 自动权重观测总览：旋钮现值 + 每个"多候选模型"的预测份额（静默版的核心产出）
    autoWeight: {
      enabled: AUTO_W.enabled,
      effective: false, // 观测版恒为 false：只算不生效，见 docs/scheduling.md「自动权重」
      knobs: { ...AUTO_W },
      at: AUTO_LAST_AT || null,
      // 后台节拍计数：观测的 EWMA/死区是"一拍一算"的，而触发点原来只有"有人拉 /admin/api/status"，
      // 等于"没人开控制台就没有观测数据"。ticks 只数后台定时器那一路，用来证明节拍真的在跑。
      ticks: AUTO_TICKS,
      models: autoObs,
    },
    aggregated: {
      openai: aggregateModels('openai'),
      anthropic: aggregateModels('anthropic'),
      gemini: aggregateModels('gemini'),
    },
    // v1.17 运行时观测：会话粘性（命中/学习/淘汰）与客户端限流（在飞/拒绝）当前状态；
    // v1.18.8 增 thinking 回放（学习/修复/作废）当前状态
    affinity: affinityStatus(),
    rateLimit: rateStatus(),
    metrics: { enabled: METRICS_CFG.enabled, public: METRICS_CFG.public },
    thinkingReplay: replayStatus(),
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
    // 自动权重旋钮：必须在白名单里——否则控制台随便保存一次渠道就会把用户调好的参数从 config.json 里抹掉
    // （与渠道 weight 字段同一个坑，见 PT29）
    autoWeight: { ...AUTO_W },
    // v1.17 的三组开关同理必须在白名单里：漏一个，控制台保存任一渠道时就会把那段配置从 config.json 里抹掉
    sessionAffinity: (config && config.sessionAffinity) || undefined,
    rateLimit: (config && config.rateLimit) || undefined,
    metrics: (config && config.metrics) || undefined,
    // v1.18.8 的 thinking 回放开关同理（第四组）：不进白名单就会被任一次渠道保存抹掉
    thinkingReplay: (config && config.thinkingReplay) || undefined,
    // 首启生成的密钥随配置一起持久化（env 显式提供的密钥不落盘——config.adminKey 保持未设置）
    adminKey: config.adminKey || undefined,
    gatewayKey: config.gatewayKey || undefined,
    // 控制台轮换过的密钥（v1.18.5）：**必须在白名单里**，否则随后保存任意一个渠道就会把轮换结果
    // 从 config.json 里抹掉——表现是"重启后密钥又变回 .env 的值"，且用户完全不知道为什么。
    auth: (config && config.auth) || undefined,
    channels: Array.from(channels.values()).map((ch) => ({
      id: ch.def.id,
      name: ch.def.name,
      baseUrl: ch.def.baseUrl,
      apiKey: ch.def.apiKey,
      protocol: ch.def.protocol || 'openai',
      priority: ch.def.priority ?? 0,
      // 加权轮询权重：必须随配置持久化，否则控制台保存任一渠道都会把权重从 config.json 里抹掉
      weight: ch.def.weight ?? undefined,
      enabled: ch.def.enabled !== false,
      autoAlias: ch.def.autoAlias !== false,
      proxy: ch.def.proxy || undefined,
      models: ch.def.models || {},
      // 渠道级自定义请求头（解析成纯净对象后持久化）
      headers: (ch.def.headers && Object.keys(parseCustomHeaders(ch.def)).length) ? parseCustomHeaders(ch.def) : undefined,
      // codex 专有：持久化 AT 及其元信息（10 天有效，重启免刷 RT）
      accessToken: ch.def.accessToken || undefined,
      accountId: ch.def.accountId || undefined,
      email: ch.def.email || undefined,
      expiresAt: ch.def.expiresAt || undefined,
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

// ─── 渠道滚动健康分（自动优先级）───
// 近期成败滚动窗口：总量 ≥120 时整体减半（旧样本指数衰减，新表现主导）。
// ≥5 个样本才计算失败率；有效优先级 = 静态 priority − 失败率×3：
// 常败渠道自动沉底（惩罚上限 -3，仍高于刻意调低的兜底渠道如 genspark -5），
// 恢复后新成功稀释失败率、优先级自动回升——不需要手动调整。
// ponytail: 滚动窗口纯内存态，容器重启清零——要跨重启的健康记忆，将来写进 usage.json byChannel
function bumpRoll(ch, ok) {
  if (!ch) return;
  const r = ch.roll || (ch.roll = { w: 0, f: 0 });
  if (ok) r.w++; else r.f++;
  if (r.w + r.f >= 120) { r.w = Math.ceil(r.w / 2); r.f = Math.ceil(r.f / 2); }
}
function rollFailRate(ch) {
  const r = ch.roll;
  if (!r) return null;
  const t = r.w + r.f;
  return t >= 5 ? r.f / t : null;
}
function effPriority(ch) {
  const p = ch.def.priority ?? 0;
  const fr = rollFailRate(ch);
  return fr === null ? p : Math.round((p - fr * 3) * 100) / 100;
}

/* ══════════════════ 自动权重（静默观测版，v1.6）══════════════════
 *
 * 想要的效果：不手填 weight，也让"同一个模型的多个候选"按**实测表现**自动分配份额
 * （有的能用有的不能用、有的快有的慢 ⇒ 好的多拿、坏的少拿、坏透的本来就进不了池）。
 *
 * 本版**只算与只显示**：pickWeighted 仍旧只认 ch.def.weight，一行都不碰真实路由。
 * 理由：自动权重天然有反馈回路（份额改流量 → 流量改统计 → 统计改份额），
 * 先让人对着真实数据看它算得对不对，确认无误再打开开关让它生效。
 * 因此 `enabled` 目前是**预留字段**——就算置 true，本版也不改分流（docs/scheduling.md 里写明了）。
 *
 * 健康系数 h（0 到 1，地板 AUTO_FLOOR）由两个已有信号合成，不引入新统计：
 *   1) 成功率：复用滚动窗口 ch.roll（bumpRoll 已在每次请求里维护，120 样本自动减半）
 *      —— 失败证据优先：h 的主力是它。
 *   2) 速度：该渠道最近成功请求的延迟 EWMA（ch.latEwma）相对池内最快者的比值
 *      —— 只做**温和**惩罚且给地板，因为"慢"常常是长上下文/推理模型在思考，饿死它反而丢质量。
 * 抗振荡三件套：低频（updateMs 才重算一次）+ 指数平滑（ewma）+ 死区（变化小于 deadband 不动）。
 */
const AUTO_W = { enabled: false };
const AUTO_STATE = new Map(); // channelId → { h, at, failRate, samples, latMs, speedRatio }
let AUTO_LAST_AT = 0;
let AUTO_TICKS = 0;           // 后台节拍跑了几拍（只数定时器那一路，见 autoWeightTick）

function normAutoWeight(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    enabled: o.enabled === true,                              // 打开观测（含后台节拍）；仍然一行不碰分流
    minSamples: Math.round(num(o.minSamples, 10, 1, 1000)),    // 样本不足不动
    floor: num(o.floor, 0.2, 0, 1),                            // 健康系数地板
    latencyPenalty: num(o.latencyPenalty, 0.5, 0, 1),          // 速度惩罚强度（0 = 不看速度）
    maxShare: num(o.maxShare, 70, 1, 100),                     // 单渠道预测份额上限（%）
    updateMs: Math.round(num(o.updateMs, 30000, 1000, 3600000)), // 重算间隔（低频抗振荡）
    ewma: num(o.ewma, 0.5, 0.05, 1),                           // 新值权重
    deadband: num(o.deadband, 0.1, 0, 1),                      // 死区（相对）
  };
}
Object.assign(AUTO_W, normAutoWeight(config.autoWeight));

// 后台观测节拍。
// 为什么必须有它：观测里的健康系数是"一拍一算"的（指数平滑 + 死区），而触发点原来只有
// /admin/api/status —— 也就是**没人开着控制台就没有观测数据**。想拿它跑几天看趋势，
// 必须让节拍自己走，否则你看到的 h 永远停留在"上次打开控制台那一刻"的值。
// 关掉时（enabled:false）不建定时器：不观测、不算、不占 CPU，静默不变式照旧。
// 注：AUTO_W 只在启动时从 config 读一次，改 autoWeight 需要重启（与其它旋钮一致）。
function autoWeightTick() {
  if (!AUTO_W.enabled) return;      // 运行时兜底：即便定时器还在，关了就不再观测
  try {
    autoWeightObserve();
    AUTO_TICKS++;
  } catch (e) { /* 观测绝不允许影响服务：宁可这一拍不记，也不能把请求路径搞挂 */ }
}
if (AUTO_W.enabled) {
  // 节拍 = updateMs 本人（normAutoWeight 已把它钳在 ≥1s）。不再另加隐藏下限：
  // 配置说多少就跑多少，否则"我设了 5s 怎么还是 30s"这种事又会变成下一个坑。
  setInterval(autoWeightTick, AUTO_W.updateMs).unref();
}

// 同模型候选的**纯枚举**：与 channelsServing 的别名规则一致，但绝不调用它
// —— channelsServing 末尾会走 applyWeightedPick，动 SWRR_CUR/SWRR_HITS（有副作用）。
// 观测必须是无副作用的，否则"看一眼"就把分流改了。
function pureCandidatesFor(model) {
  const want = String(model || '').toLowerCase().trim();
  if (!want) return [];
  const out = [];
  for (const ch of channels.values()) {
    if (ch.def.enabled === false) continue;
    if (ch.aliasMap.has(want)) out.push({ ch, kind: 'explicit', upstream: ch.aliasMap.get(want) });
    else if (ch.def.autoAlias !== false && ch.models.includes(want)) out.push({ ch, kind: 'auto', upstream: want });
  }
  return out;
}

// 按 maxShare 归一化成百分比。两条规则别搞混：
//   · `manual: true`（用户手填了 weight）的候选**永不封顶**——手工权重是硬意图，护栏不该反过来压制它；
//   · maxShare 只兜自动算出来的份额（防"最快的那家被顶到 90% → 被打爆 → 反而更慢"的赢家通吃）。
// 单个候选不封顶（只有一个提供方时它就是 100%，谈不上抢份额）；候选多到 maxShare×n < 100 时
// 数学上不可能人人都不超上限，退化成平均分（cap 取 max(maxShare, 100/n)）而不是留下一个永远不收敛的循环。
function capShares(items, maxShare) {
  const n = items.length;
  const total = items.reduce((s, it) => s + it.w, 0);
  if (!n || total <= 0) return items.map(() => 0);
  if (n === 1) return [100];
  const cap = Math.max(maxShare, 100 / n);
  let share = items.map((it) => (it.w / total) * 100);
  for (let round = 0; round < n + 2; round++) {
    const over = share.map((s, i) => (s > cap + 1e-9 && !items[i].manual ? i : -1)).filter((i) => i >= 0);
    if (!over.length) break;
    for (const i of over) share[i] = cap;
    const rest = 100 - over.reduce((s, i) => s + share[i], 0);
    const free = share.map((s, i) => (over.includes(i) ? -1 : i)).filter((i) => i >= 0);
    const freeW = free.reduce((s, i) => s + items[i].w, 0);
    for (const i of free) share[i] = freeW > 0 ? (items[i].w / freeW) * rest : rest / free.length;
  }
  const sum = share.reduce((s, v) => s + v, 0);
  return share.map((s) => (sum > 0 ? Math.round((s / sum) * 1000) / 10 : 0));
}

// 单个渠道的**原始**健康分（只看失败率与延迟，不含速度项/平滑）。
// 低频：updateMs 内复用缓存——失败率与延迟都是慢变量，每秒重算只会让份额在噪声里抖。
function autoRawFor(ch, now) {
  const prev = AUTO_STATE.get(ch.def.id);
  if (prev && now - prev.at < AUTO_W.updateMs) return prev;
  const r = ch.roll || { w: 0, f: 0 };
  const samples = r.w + r.f;
  const failRate = samples >= AUTO_W.minSamples ? r.f / samples : null; // 样本不足 = 不动它（新渠道不被噪声打死）
  const latMs = ch.latEwma != null ? Math.round(ch.latEwma) : null;
  const st = Object.assign(prev || {}, {
    at: now, samples, failRate, latMs,
    rawH: failRate === null ? 1 : Math.max(0, 1 - failRate),           // 失败证据：主力信号
  });
  AUTO_STATE.set(ch.def.id, st);
  return st;
}

// 一次观测：算每个渠道的健康系数（原始分 → 速度项 → 平滑/死区），再给每个有 ≥2 候选的模型算预测份额。
// 全程只读：不碰 SWRR_*、不改 ch.def、不发请求。
function autoWeightObserve() {
  const now = Date.now();
  const all = Array.from(channels.values());
  for (const ch of all) autoRawFor(ch, now);

  // 速度项：以"所有有延迟数据的渠道"里最快者为 1×，慢的按强度温和打折（默认 2× 慢只打 0.75）
  const lats = all.map((ch) => AUTO_STATE.get(ch.def.id)?.latMs).filter((v) => v > 0);
  const fastest = lats.length ? Math.min(...lats) : null;
  const clamp01 = (v) => Math.max(AUTO_W.floor, Math.min(1, v));
  for (const ch of all) {
    const st = AUTO_STATE.get(ch.def.id);
    if (!st) continue;
    let target = st.rawH;
    if (fastest && st.latMs > 0) {
      st.speedRatio = Math.round((st.latMs / fastest) * 100) / 100;
      target *= 1 - AUTO_W.latencyPenalty * (1 - Math.min(1, fastest / st.latMs));
    } else {
      st.speedRatio = null;                                            // 没有延迟数据 = 不因速度扣分
    }
    target = clamp01(target);
    // 指数平滑 + 死区：变化小于 deadband（相对）就不动 → 抗振荡的核心
    if (st.h == null) st.h = target;
    else {
      const smoothed = st.h * (1 - AUTO_W.ewma) + target * AUTO_W.ewma;
      st.h = Math.abs(smoothed - st.h) < AUTO_W.deadband * st.h ? st.h : smoothed;
    }
    st.h = Math.round(clamp01(st.h) * 1000) / 1000;
  }

  // 预测份额：只看有 ≥2 个候选的模型（一个候选谈不上分流），按请求量取前 12 个
  const u = ensureUsage();
  const reqOf = (m) => (u.byModel && u.byModel[m] ? u.byModel[m].requests || 0 : 0);
  const models = [];
  for (const model of aggregateModels()) {
    const cands = pureCandidatesFor(model);
    if (cands.length < 2) continue;
    models.push({ model, cands, req: reqOf(model) });
  }
  models.sort((a, b) => b.req - a.req || a.model.localeCompare(b.model));

  const out = [];
  for (const { model, cands } of models.slice(0, 12)) {
    const dead = (ch) => ch.cooldownUntil > now || ch.status === 'down';
    const live = cands.filter((c) => !dead(c.ch));                     // 冷却/down 本来就不进池
    const items = live.map((c) => {
      const st = AUTO_STATE.get(c.ch.def.id) || { h: 1 };
      // 没填权重时基础权重取 1 —— 这正是"不配置也能自动分流"的关键：开了开关，所有候选都进池
      const base = Number(c.ch.def.weight) > 0 ? Number(c.ch.def.weight) : 1;
      return { c, base, h: st.h, w: base * st.h, manual: Number(c.ch.def.weight) > 0 };
    });
    const shares = capShares(items.map((it) => ({ w: it.w, manual: it.manual })), AUTO_W.maxShare);
    // 对照：**当前**（手工权重）在同样候选里的份额；全都没填 weight 时 = 未启用加权轮询（走排序第一位）
    const manual = live.filter((c) => Number(c.ch.def.weight) > 0);
    const manualTotal = manual.reduce((s, c) => s + Number(c.ch.def.weight), 0);
    out.push({
      model,
      requests: reqOf(model),
      excluded: cands.filter((c) => dead(c.ch)).map((c) => c.ch.def.id),
      manualOff: manual.length === 0,
      candidates: items.map((it, i) => ({
        id: it.c.ch.def.id,
        kind: it.c.kind,
        base: it.base,
        manual: it.manual,
        h: it.h,
        share: shares[i],
        nowShare: Number(it.c.ch.def.weight) > 0 && manualTotal > 0
          ? Math.round((Number(it.c.ch.def.weight) / manualTotal) * 1000) / 10 : null,
        status: it.c.ch.status,
        cooldown: it.c.ch.cooldownUntil > now,
        failRate: AUTO_STATE.get(it.c.ch.def.id)?.failRate ?? null,
        samples: AUTO_STATE.get(it.c.ch.def.id)?.samples ?? 0,
        latMs: AUTO_STATE.get(it.c.ch.def.id)?.latMs ?? null,
        speedRatio: AUTO_STATE.get(it.c.ch.def.id)?.speedRatio ?? null,
        weight: Number(it.c.ch.def.weight) > 0 ? Number(it.c.ch.def.weight) : 0,
      })),
    });
  }
  AUTO_LAST_AT = now;
  return out;
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
    bumpRoll(channels.get(channelId), ok !== false); // 滚动健康分（自动优先级用；失败经 recordFailure 也流经此处）
    // 延迟 EWMA（只记成功请求）：给自动权重观测当"速度"输入，避免每次去扫 usage.recent 全表
    if (ok !== false && Number(latencyMs) > 0) {
      const lch = channels.get(channelId);
      if (lch) {
        lch.latEwma = lch.latEwma == null ? Number(latencyMs) : lch.latEwma * 0.7 + Number(latencyMs) * 0.3;
        lch.latN = (lch.latN || 0) + 1;
      }
    }
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
    // v1.17 指标：渠道维度的成功/失败、token、耗时（口径与 usage 相同——真实 usage 优先，
    // 两根通道共用这一处收口，避免"指标好看、usage 难看"的分叉）
    metricChannel(channelId, { ok: ok !== false, kind, inputTokens: inTok, outputTokens: outTok, latencyMs });
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

function validateChannelDef(def, opts) {
  if (!def || typeof def !== 'object') return 'body must be an object';
  if (!def.id || !/^[a-zA-Z0-9_\-]+$/.test(def.id)) return 'id is required and must be [a-zA-Z0-9_-]+';
  if (!def.baseUrl || typeof def.baseUrl !== 'string') return 'baseUrl is required';
  // 更新已有渠道时允许不带 apiKey：控制台现在只拿到掩码，留空即"保持原密钥"（见 POST 分支）
  if ((!def.apiKey || typeof def.apiKey !== 'string') && !(opts && opts.allowMissingApiKey)) return 'apiKey is required';
  if (def.protocol && !['openai', 'anthropic', 'gemini', 'notion', 'notion-agent', 'workbuddy', 'codex', 'genspark'].includes(def.protocol)) return 'protocol must be openai|anthropic|gemini|notion|notion-agent|workbuddy|codex|genspark';
  if (def.models && typeof def.models !== 'object') return 'models must be an object {alias: upstream}';
  // 加权轮询权重：必须是有限数字且 ≥ 0（0 = 不参与轮询；负数/NaN 会让分流比例失去意义）
  if (def.weight !== undefined && def.weight !== null && def.weight !== '') {
    const w = Number(def.weight);
    if (!Number.isFinite(w) || w < 0) return 'weight must be a finite number >= 0 (0 = 不参与加权轮询)';
  }
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
      // v1.18.4：这里原来同时给出 ADMIN_KEY 与 GATEWAY_KEY 原文——一次 GET 就等于全盘失守。
      // 现在只给掩码与"设没设"，原文改走 /admin/api/gateway-key（管理面鉴权 + 按需单取）。
      gatewayKey: maskSecret(GATEWAY_KEY),
      gatewayKeyRequired: !!GATEWAY_KEY,
      adminKeyRequired: !!ADMIN_KEY,
      // 控制台原来自己拿两个密钥去 /change-me/i 判断"还是不是默认串"，现在密钥不下发了，
      // 由服务端算好这一个布尔给它（同样是"看出风险"，但不泄漏值）。
      keysInsecure: keysInsecureNow(),
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
    // 「全部重探测」是**手动**动作 → 连停用渠道一起探（自动探测才会跳过停用的）。
    const before = new Map();
    for (const ch of channels.values()) before.set(ch.def.id, ch.status);
    await probeAll({ includeDisabled: true });
    const results = Array.from(channels.values()).map((ch) => ({
      id: ch.def.id,
      status: ch.status,
      before: before.get(ch.def.id) || 'unknown',
      latencyMs: ch.latencyMs,
      modelCount: ch.models.length,
      enabled: ch.def.enabled !== false,
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
    // 加权轮询权重也走这条轻量路径：改完立即生效（无需重启），并持久化
    if (body.weight !== undefined) {
      const w = Number(body.weight);
      if (!Number.isFinite(w) || w < 0) return sendJson(res, 400, { error: 'weight must be a finite number >= 0' });
      ch.def.weight = w > 0 ? w : undefined;
    }
    if (body.enabled !== undefined) ch.def.enabled = !!body.enabled;
    // 启停/优先级立即持久化：否则容器重启后状态丢失，"停用的渠道复活"
    persistConfig();
    return sendJson(res, 200, { ok: true, id: body.id, priority: ch.def.priority, weight: ch.def.weight ?? 0, enabled: ch.def.enabled });
  }

  // ── 运行期设置读写（v1.18：给控制台用的开关面板）─────────────
  // 为什么需要它：渠道级 upsert 改不了这三组开关，`/admin/api/config` 又是只读的，
  // 于是控制台在 v1.17 里只能"看得见、改不了"（状态由 /admin/api/status 暴露）。
  // 这里给一个**窄口**：只认 sessionAffinity / rateLimit / metrics / thinkingReplay 四组，
  // 每组走与启动路径同一个 norm* 函数（钳制规则完全一致），写 config → 持久化 → 立即生效。
  // 刻意不做成"通用 config 写入"：那等于给控制台一个能改坏任何配置的口子，
  // 而它的每个调用点都得自己保证字段合法——窄口 + 白名单字段是这里唯一可靠的做法。
  if (req.method === 'GET' && url.pathname === '/admin/api/settings') {
    return sendJson(res, 200, { ok: true, ...runtimeSettingsView() });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/settings') {
    const body = await safeReadJson(req);
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'invalid json body' });
    const groups = ['sessionAffinity', 'rateLimit', 'metrics', 'thinkingReplay'];
    const touched = groups.filter((g) => body[g] !== undefined);
    if (!touched.length) return sendJson(res, 400, { error: 'nothing to update: expected one of sessionAffinity / rateLimit / metrics / thinkingReplay' });
    for (const g of touched) {
      const v = body[g];
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return sendJson(res, 400, { error: g + ' must be an object' });
      // 只接受白名单字段，且类型必须对——写错一个字段名不会被静默忽略（否则"我明明关了"会变成悬案）
      const allowed = g === 'sessionAffinity' ? ['enabled', 'ttlSec', 'maxEntries', 'deriveFromBody']
        : g === 'rateLimit' ? ['enabled', 'rpm', 'burst', 'maxConcurrent']
          : g === 'thinkingReplay' ? ['enabled', 'ttlSec', 'maxEntries']
            : ['enabled', 'public'];
      for (const k of Object.keys(v)) {
        if (!allowed.includes(k)) return sendJson(res, 400, { error: `unknown field ${g}.${k}` });
        if (k === 'enabled' || k === 'deriveFromBody' || k === 'public') {
          if (typeof v[k] !== 'boolean') return sendJson(res, 400, { error: `${g}.${k} must be a boolean` });
        } else if (!Number.isFinite(Number(v[k])) || Number(v[k]) < 0) {
          return sendJson(res, 400, { error: `${g}.${k} must be a finite number >= 0` });
        }
      }
      // 合并进已有配置（PATCH 语义：没带的字段保持不变，不会"漏字段 = 归零"）
      config[g] = { ...((config && config[g]) || {}), ...v };
      for (const k of Object.keys(config[g])) if (config[g][k] === undefined) delete config[g][k];
    }
    applyRuntimeSettings();          // 立即生效（不重启）
    persistConfig();                 // 立即落库（重启后仍是这个值）
    console.log(`[settings] 控制台更新了 ${touched.join(' / ')}: ` + JSON.stringify(runtimeSettingsView()));
    return sendJson(res, 200, { ok: true, updated: touched, ...runtimeSettingsView() });
  }

  // ─── 密钥管理（v1.18.5）：控制台轮换网关密钥 / 管理密钥 ───────────────────────
  // 一律只给掩码 + 来源；原文只在「刚轮换完」那一次响应里回给调用方（管理面鉴权 + no-store）。
  if (req.method === 'GET' && url.pathname === '/admin/api/keys') {
    return sendJson(res, 200, { ok: true, ...keysView() });
  }
  // 按需揭示管理密钥：与 /admin/api/gateway-key 对称，供控制台「显示 / 复制」用
  if (req.method === 'GET' && url.pathname === '/admin/api/admin-key') {
    return sendJson(res, 200, { ok: true, adminKey: ADMIN_KEY || '' });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/keys') {
    const body = await safeReadJson(req);
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body must be a JSON object' });
    const patch = {};
    for (const field of ['gatewayKey', 'adminKey']) {
      if (body[field] === undefined) continue;
      const label = field === 'adminKey' ? '管理密钥' : '网关密钥';
      // 与"另一把"比较时优先用同一次请求里已经改好的值（允许一次请求同时换两把）
      const other = field === 'adminKey'
        ? (patch.gatewayKey !== undefined ? patch.gatewayKey : GATEWAY_KEY)
        : (patch.adminKey !== undefined ? patch.adminKey : ADMIN_KEY);
      const r = normNewKey(body[field], label, other, field === 'adminKey' ? 'admin' : 'gateway');
      if (r.error) return sendJson(res, 400, { error: r.error });
      patch[field] = r.key;
    }
    if (!Object.keys(patch).length) return sendJson(res, 400, { error: '没有要改的密钥：body 里给 gatewayKey 或 adminKey' });
    rotateKeys(patch);
    console.log('[keys] 控制台轮换了 ' + Object.keys(patch).map((f) => (f === 'adminKey' ? '管理密钥' : '网关密钥')).join(' / ')
      + '（旧密钥已立即失效）');
    // 换了管理密钥：rotateKeys 已清空全部会话——给发起轮换的这个浏览器补发新会话，免得它下一步就被踢回登录门
    if (patch.adminKey !== undefined) res.setHeader('Set-Cookie', sessionCookieValue(newSessionToken()));
    // 新值放在 newKeys 里，**必须在 keysView() 之后**——keysView().gatewayKey 是个对象，
    // 写在前面会被它整个覆盖掉，控制台就拿不到刚轮换出来的值去更新自己了。
    return sendJson(res, 200, { ok: true, ...keysView(), newKeys: patch });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/keys/generate') {
    const body = (await safeReadJson(req)) || {};
    const target = (body.target === 'gateway' || body.target === 'admin') ? body.target : 'both';
    const patch = {};
    if (target !== 'admin') patch.gatewayKey = genKey();
    if (target !== 'gateway') patch.adminKey = genKey();
    // 极低概率撞成同一把（48 位 hex）也兜一下：撞了就再抽一次
    if (patch.gatewayKey && patch.gatewayKey === patch.adminKey) patch.adminKey = genKey();
    rotateKeys(patch);
    console.log('[keys] 控制台随机生成了 ' + (target === 'both' ? '网关密钥 + 管理密钥' : (target === 'gateway' ? '网关密钥' : '管理密钥'))
      + '（旧密钥已立即失效）');
    return sendJson(res, 200, { ok: true, ...keysView(), newKeys: patch });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/keys/reset') {
    resetManagedKeys();
    console.log('[keys] 控制台放弃了轮换值，回到「环境变量 → 首启生成」');
    return sendJson(res, 200, { ok: true, ...keysView() });
  }

  // 按需揭示单个渠道的上游密钥（v1.18.4）：管理面默认只下发掩码，原文要点名索取。
  // 单条 + 单次 + 仍走 admin 鉴权，把"一次泄漏 = 全部渠道密钥"降成"一次泄漏 = 一把"。
  if (req.method === 'GET' && /^\/admin\/api\/channels\/[^/]+\/key$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.slice('/admin/api/channels/'.length, -'/key'.length));
    const ch = channels.get(id);
    if (!ch) return sendJson(res, 404, upstreamErrorPayload(404, `channel not found: ${id}`));
    return sendJson(res, 200, { ok: true, id, apiKey: ch.def.apiKey || '' });
  }
  // 按需揭示网关密钥：控制台「接入信息」卡与 Playground 直连 /v1 时需要它
  if (req.method === 'GET' && url.pathname === '/admin/api/gateway-key') {
    return sendJson(res, 200, { ok: true, gatewayKey: GATEWAY_KEY || '' });
  }

  // 完整 CRUD：channels 集合
  if (req.method === 'GET' && url.pathname === '/admin/api/channels') {
    return sendJson(res, 200, { channels: Array.from(channels.values()).map((ch) => ({
      id: ch.def.id,
      name: ch.def.name,
      baseUrl: ch.def.baseUrl,
      apiKey: maskSecret(ch.def.apiKey), apiKeySet: !!ch.def.apiKey,
      protocol: ch.def.protocol || 'openai',
      priority: ch.def.priority ?? 0,
      weight: ch.def.weight ?? undefined,
      enabled: ch.def.enabled !== false,
      autoAlias: ch.def.autoAlias !== false,
      proxy: ch.def.proxy || undefined,
      headers: (ch.def.headers && Object.keys(parseCustomHeaders(ch.def)).length) ? parseCustomHeaders(ch.def) : undefined,
      models: ch.def.models || {},
      accessToken: ch.def.accessToken || undefined,
      accountId: ch.def.accountId || undefined,
      email: ch.def.email || undefined,
      expiresAt: ch.def.expiresAt || undefined,
    })) });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/channels') {
    const body = await safeReadJson(req);
    const err = validateChannelDef(body, { allowMissingApiKey: channels.has(body.id) });
    if (err) return sendJson(res, 400, { error: err });
    // 已有的 weight 不能被"本次没传这个字段"抹掉（v1.5 起控制台表单会**显式**提交 weight：
    // 留空 = 真的清成 0；只有那些老客户端/导入流程不传 weight 时才沿用旧值）
    const prevDef = channels.get(body.id)?.def;
    const def = {
      id: body.id,
      name: body.name || body.id,
      baseUrl: body.baseUrl.replace(/\/+$/, ''),
      // 留空 = 保持原密钥（v1.18.4 起管理面只下发掩码、控制台表单不再回填原文；
        // 若把空串写回去，等于把用户配好的渠道密钥抹掉）
        ...(body.apiKey ? { apiKey: body.apiKey } : (prevDef ? { apiKey: prevDef.apiKey } : { apiKey: '' })),
      protocol: body.protocol || 'openai',
      priority: body.priority !== undefined ? Number(body.priority) : 0,
      weight: body.weight !== undefined ? (Number(body.weight) > 0 ? Number(body.weight) : undefined) : (prevDef ? prevDef.weight : undefined),
      enabled: body.enabled !== false,
      autoAlias: body.autoAlias === true,
      models: body.models || {},
      proxy: body.proxy ? String(body.proxy) : undefined,
      // 渠道级自定义请求头（对象或 "Name: value" 多行文本）
      headers: body.headers ? body.headers : undefined,
    };
    const existed = channels.has(def.id);
    const ch = upsertChannel(def);
    persistConfig();
    // 立即探测一次，便于前端立刻显示健康状态
    probeChannel(ch).catch(() => {});
    return sendJson(res, 200, { ok: true, id: def.id, existed, channel: { id: def.id, name: def.name, baseUrl: def.baseUrl, protocol: def.protocol, priority: def.priority, enabled: def.enabled, autoAlias: def.autoAlias, models: def.models } });
  }
  // codex 一键导入：支持两种输入（自动识别）——
  //   A) sub2api 导出的完整 JSON（含 access_token/refresh_token/account_id，AT 10 天有效直接可用，不消耗 RT）
  //   B) 裸 refresh_token（rt.1. 开头，立即换一次令牌）
  // id 已存在时等价于换凭据
  if (req.method === 'POST' && url.pathname === '/admin/api/codex-import') {
    const body = await safeReadJson(req);
    const raw = String((body && body.rt) || '').trim();
    if (!raw) return sendJson(res, 400, { error: 'rt required' });
    const proxy = body.proxy ? String(body.proxy) : CODEX_DEFAULT_PROXY;

    // A) 完整 JSON 导入：直接用 AT，避免碰 RT（拼车场景下 RT 多半已被别人消费）
    //    支持三种形状：
    //      a1) 扁平：{access_token, refresh_token, account_id, email}
    //      a2) sub2api 导出：{type:"sub2api-data", accounts:[{credentials:{access_token,…}}]}
    //      a3) 单账号对象：{credentials:{access_token,…}}
    const maybeJsonRaw = raw.startsWith('{') ? safeJson(raw) : null;
    const maybeJson = maybeJsonRaw ? pickCodexCreds(maybeJsonRaw) : null;
    if (maybeJson && (maybeJson.access_token || maybeJson.refresh_token)) {
      const at = String(maybeJson.access_token || '');
      const rtTok = String(maybeJson.refresh_token || '');
      const atPayload = at ? (codexJwtPayload(at) || {}) : {};
      const atExpMs = atPayload.exp ? atPayload.exp * 1000 : 0;
      if (!rtTok) return sendJson(res, 200, { ok: false, error: 'JSON 里缺少 refresh_token' });
      const id = (body.id && /^[a-zA-Z0-9_\-]+$/.test(body.id)) ? body.id : nextCodexChannelId();
      const email = String(maybeJson.email || atPayload.email || (atPayload['https://api.openai.com/profile'] || {}).email || '');
      const accountId = String(maybeJson.account_id || maybeJson.chatgpt_account_id || (atPayload['https://api.openai.com/auth'] || {}).chatgpt_account_id || '');
      const tmpDef = { id: 'codex-import-tmp', baseUrl: CODEX_DEFAULT_BASE, proxy };
      const tmpAcct = { accessToken: at, accountId, expiresAt: atExpMs };
      // AT 活就直接拉模型验证；AT 死了再尝试 RT 刷新
      let acct = null, models = [], rotatedRt = null, usedAt = false;
      if (at && atExpMs > Date.now() + 60_000) {
        try {
          models = await codexFetchModels(tmpDef, tmpAcct, 15000);
          // models 空列表也可能是版本/风控问题，但 HTTP 层通就算 AT 活
          acct = tmpAcct; usedAt = true;
        } catch {}
      }
      if (!acct) {
        const tmpCh = { def: { id: 'codex-import-tmp', apiKey: rtTok, proxy, baseUrl: CODEX_DEFAULT_BASE }, codex: null };
        try {
          acct = await codexEnsureToken(tmpCh);
          rotatedRt = tmpCh.def.apiKey !== rtTok ? tmpCh.def.apiKey : null;
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: String(err.message || err) });
        }
        try { models = await codexFetchModels(tmpCh.def, acct, 15000); } catch {}
      }
      if (!models.length) models = ['gpt-5.5']; // 拉取失败兜底
      const def = {
        id,
        name: body.name || ('ChatGPT订阅' + (email ? '·' + email : '')),
        baseUrl: CODEX_DEFAULT_BASE,
        apiKey: rotatedRt || rtTok,
        protocol: 'codex',
        priority: body.priority !== undefined ? Number(body.priority) : 0,
        enabled: true, autoAlias: false,
        models: Object.fromEntries(models.map((m) => [m, m])),
        proxy,
        accessToken: acct.accessToken, accountId: acct.accountId || accountId,
        email, expiresAt: acct.expiresAt,
      };
      const existed = channels.has(id);
      const ch = upsertChannel(def);
      persistConfig();
      probeChannel(ch).catch(() => {});
      return sendJson(res, 200, { ok: true, id, existed, name: def.name, models, accountId: def.accountId || undefined, rotated: !!rotatedRt, via: usedAt ? 'access_token' : 'refresh' });
    }

    // B) 裸 RT 导入
    const rt = raw;
    // 先用临时渠道验证 RT（codexEnsureToken 内部处理轮转；tmpCh 未注册，persistConfig 不会落它）
    const tmpDef = { id: 'codex-import-tmp', apiKey: rt, proxy, baseUrl: CODEX_DEFAULT_BASE };
    const tmpCh = { def: tmpDef, codex: null };
    let acct;
    try {
      acct = await codexEnsureToken(tmpCh);
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: String(err.message || err) });
    }
    const id = (body.id && /^[a-zA-Z0-9_\-]+$/.test(body.id)) ? body.id : nextCodexChannelId();
    let models = [];
    try { models = await codexFetchModels(tmpDef, acct, 15000); } catch {}
    if (!models.length) models = ['gpt-5.5']; // 拉取失败兜底
    const def = {
      id,
      name: body.name || ('ChatGPT订阅' + (acct.email ? '·' + acct.email : '')),
      baseUrl: CODEX_DEFAULT_BASE,
      apiKey: tmpDef.apiKey, // 注意：可能已是轮转后的新 RT
      protocol: 'codex',
      priority: body.priority !== undefined ? Number(body.priority) : 0,
      enabled: true, autoAlias: false,
      models: Object.fromEntries(models.map((m) => [m, m])),
      proxy: tmpDef.proxy,
      accessToken: acct.accessToken, accountId: acct.accountId,
      email: acct.email || '', expiresAt: acct.expiresAt,
    };
    const existed = channels.has(id);
    const ch = upsertChannel(def);
    persistConfig();
    probeChannel(ch).catch(() => {});
    return sendJson(res, 200, { ok: true, id, existed, name: def.name, models, accountId: acct.accountId || undefined, rotated: tmpDef.apiKey !== rt });
  }
  // genspark 一键导入：粘贴 session.enc JSON（{"sessionId":…,"apiKey":"gsk-…"}）/ 整段 cookie /
  // 裸 session_id（uuid:hex）→ 提取 sessionId 当渠道 key（gsk- key 免费号走 llm_proxy 会被
  // free_plan_block 拦，不用）。两种模式：
  //   mode 'replace'（默认，粘贴框）——更新现有 genspark 渠道的 key（session 过期换新用）
  //   mode 'add'（文件批量）——同 key 视为刷新，新 key 自动建新渠道 genspark/genspark2/…
  //     （每个号 100 积分/天，多号多份）；代理/模型/优先级抄现有 genspark 渠道，没有则用默认
  if (req.method === 'POST' && url.pathname === '/admin/api/genspark-import') {
    const body = await safeReadJson(req) || {};
    const raw = String(body.raw || body.json || '').trim();
    let key = '';
    const cookieM = raw.match(/session_id=([^;\s"']+)/);            // 整段 cookie 串
    if (cookieM) key = cookieM[1];
    else if (raw.startsWith('{')) {                               // session.enc JSON
      const j = safeJson(raw);
      const sid = j && (j.sessionId || j.session_id || (j.data && (j.data.sessionId || j.data.session_id)));
      if (sid) key = String(sid);
    } else if (/^[0-9a-f-]{36}:[0-9a-f]{40,}$/i.test(raw)) {      // 裸 session_id
      key = raw;
    }
    if (!key) return sendJson(res, 200, { ok: false, error: '无法识别输入——支持三种格式：session.enc 的 JSON（{"sessionId":…}）、含 session_id=… 的整段 cookie、或裸 session_id（uuid:hex）' });
    const gensparkChs = Array.from(channels.values()).filter((c) => (c.def.protocol || 'openai') === 'genspark');
    const mode = body.mode === 'add' ? 'add' : 'replace';
    let target = null, created = false;
    if (mode === 'add') {
      target = gensparkChs.find((c) => String(c.def.apiKey).trim() === key) || null;
      if (!target) {
        // 建新渠道：id 取 genspark / gensparkN 空位；代理/模型/优先级抄现有 genspark 渠道
        let n = 1, id = 'genspark';
        while (channels.has(id)) { n++; id = 'genspark' + n; }
        const proto = gensparkChs[0] ? gensparkChs[0].def : null;
        const def = {
          id,
          name: 'Genspark 网页会话' + (gensparkChs.length ? ' ' + (gensparkChs.length + 1) : ''),
          baseUrl: proto ? proto.baseUrl : 'https://www.genspark.ai',
          apiKey: key,
          protocol: 'genspark',
          priority: proto ? proto.priority : -5,
          enabled: true, autoAlias: false,
          models: proto && proto.models && Object.keys(proto.models).length
            ? { ...proto.models }
            : { 'gpt-6-luna': 'gpt-6-luna', 'gpt-6-sol': 'gpt-6-sol', 'gpt-5.6-sol': 'gpt-5.6-sol', 'claude-opus-5-5': 'claude-opus-5-5', 'claude-sonnet-5': 'claude-sonnet-5', 'glm-5.3': 'glm-5p3', 'deepseek-v4.1-flash': 'deep-seek-v4.1-flash', 'kimi-k3': 'kimi-k3', 'grok-4.7': 'grok-4.7', 'minimax-m3': 'minimax-m3', 'gemini-3.8-flash': 'gemini-3.8-flash' },
          proxy: (proto && proto.proxy) || (body.defaultProxy ? String(body.defaultProxy) : undefined),
        };
        target = upsertChannel(def);
        created = true;
      }
    } else {
      target = gensparkChs[0] || null;
      if (target) { target.def.apiKey = key; }
    }
    if (target) {
      persistConfig();
      const r = await gensparkIsLogin(target.def, 15000).catch(() => null);
      if (r && r.ok) {
        target.consecutiveFail = 0; target.probation = false; target.cooldownUntil = 0; target.lastError = null;
        target.status = 'ok'; target.lastCheck = Date.now();
        return sendJson(res, 200, { ok: true, existed: true, created, id: target.def.id, key, email: r.email, login: true });
      }
      // 验证失败也保留新 key（可能只是代理/出口抖动），仅标记渠道状态
      target.status = 'down';
      target.lastError = 'genspark: ' + (r ? r.error : 'is_login 网络失败');
      if (created) target.consecutiveFail = 1;
      return sendJson(res, 200, { ok: true, existed: true, created, id: target.def.id, key, login: false, error: r ? r.error : 'is_login 网络失败（检查渠道 proxy）' });
    }
    return sendJson(res, 200, { ok: true, existed: false, created: false, key, hint: '尚无 genspark 渠道——key 已提取，请在前端表单补全代理后保存' });
  }
  // codex 配额查询（5h/7d 窗口、计划类型、重置时间）；结果缓存到渠道随 status 下发
  if (req.method === 'GET' && url.pathname === '/admin/api/codex-quota') {
    const id = url.searchParams.get('id') || '';
    const ch = channels.get(id);
    if (!ch || ch.def.protocol !== 'codex') return sendJson(res, 404, { error: 'codex channel not found' });
    try {
      const quota = await codexFetchQuota(ch);
      ch.codexQuota = quota;
      return sendJson(res, 200, { ok: true, id, quota });
    } catch (err) {
      return sendJson(res, 200, { ok: false, id, error: String(err.message || err) });
    }
  }
  // 临时探测（不落库），用于「获取模型」按钮
  if (req.method === 'POST' && url.pathname === '/admin/api/probe') {
    const body = await safeReadJson(req);
    if (!body || !body.baseUrl || !body.apiKey) return sendJson(res, 400, { error: 'baseUrl & apiKey required' });
    const def = {
      baseUrl: String(body.baseUrl).replace(/\/+$/, ''),
      apiKey: String(body.apiKey),
      protocol: ['openai', 'anthropic', 'gemini', 'notion', 'notion-agent', 'workbuddy', 'codex', 'genspark'].includes(body.protocol) ? body.protocol : 'openai',
      proxy: body.proxy ? String(body.proxy) : undefined,
      // 渠道级自定义请求头（对象或 "Name: value" 多行文本）——AgentRouter 这类查客户端
      // 指纹的上游，探测必须带同款 UA，否则 401 unauthorized client detected
      headers: body.headers ? body.headers : undefined,
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
          // 指定渠道测试时：模型名按该渠道的 aliasMap 翻译成上游名（notion-agent 的 alias≠上游智能体名）
          upstream: onlyChannel.aliasMap.get(model.toLowerCase()) || model,
          priority: 0,
          status: onlyChannel.status,
          latencyMs: onlyChannel.latencyMs,
          cooldownUntil: 0,
          consecutiveFail: onlyChannel.consecutiveFail,
          protocol: onlyChannel.def.protocol || 'openai',
        }]
      : (channelsServing(model, 'openai').length ? channelsServing(model, 'openai') : (channelsServing(model, 'notion').length ? channelsServing(model, 'notion') : (channelsServing(model, 'notion-agent').length ? channelsServing(model, 'notion-agent') : (channelsServing(model, 'workbuddy').length ? channelsServing(model, 'workbuddy') : (channelsServing(model, 'genspark').length ? channelsServing(model, 'genspark') : channelsServing(model, 'codex')))))); // openai 优先，notion→notion-agent→workbuddy→genspark→codex 逐级兜底
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
        if (ch.def.protocol === 'notion-agent') {
          // Notion 官方 Agent API 渠道：跑一次最小会话（quickChat 内含名字→ID 解析）
          const tmo = Math.min(90000, Number(body.timeoutMs) || 60000);
          const r = await notionAgent.quickChat(ch.def.baseUrl, ch.def.apiKey, c.upstream, prompt, zzFetch, tmo);
          if (r.ok) {
            ch.consecutiveFail = 0; ch.probation = false; ch.cooldownUntil = 0; ch.lastError = null;
            if (ch.status !== 'ok') ch.status = 'ok';
            ch.latencyMs = r.ms; ch.lastCheck = Date.now();
            recordUsage({ model, channelId: c.channelId, kind: 'test', inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(r.text), ok: true, latencyMs: r.ms });
          } else {
            recordFailure(ch, 'notion-agent: ' + String(r.error).slice(0, 150));
          }
          results.push({
            channelId: c.channelId, ok: !!r.ok, status: r.status || 200, latencyMs: r.ms,
            reply: r.ok ? String(r.text).slice(0, 200) : undefined,
            error: r.ok ? undefined : String(r.error).slice(0, 200),
          });
          continue;
        }
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
              resp = await zzFetch(target, { method: 'POST', headers, body: bodyStr, signal: ctrl.signal });
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
            ch.consecutiveFail = 0; ch.probation = false; ch.cooldownUntil = 0; ch.lastError = null;
            if (ch.status !== 'ok') ch.status = 'ok';
            ch.latencyMs = ttfb; ch.lastCheck = Date.now();
            recordUsage({
              model, channelId: c.channelId, kind: 'test',
              inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(reply),
              ok: true, latencyMs: ttfb,
            });
            // 测试消耗了额度 → 异步刷新
            try {
              notion.notionUsageEligibility(ch.def.baseUrl, ch.def.apiKey, acct, zzFetch, 8000)
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
        // WorkBuddy 渠道：只支持流式 + 首条必须 system；走 curl 子进程（TLS 指纹绕过）并聚合全文
        if (ch.def.protocol === 'workbuddy') {
          const tmo = Math.min(60000, Number(body.timeoutMs) || 30000);
          const wbBody = JSON.stringify({
            model: c.upstream,
            messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: prompt }],
            stream: true,
          });
          const out = await wbCurlRequest('POST', joinUrl(ch.def.baseUrl, 'chat/completions'), { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.def.apiKey}` }, wbBody, tmo, ch.def.proxy);
          ttfb = Date.now() - t0;
          let reply = '', wbErr = '';
          const wbStatus = out.status || 0;
          if (out.error || !out.body) {
            wbErr = out.error || 'empty body';
          } else if (out.body.trim().startsWith('{')) {
            const j = safeJson(out.body);
            wbErr = (j && (j.msg || (j.error && j.error.message))) || out.body.slice(0, 150) || 'json error';
          } else {
            for (const ln of out.body.split('\n')) {
              const s = ln.trim(); if (!s.startsWith('data:')) continue;
              const d = s.slice(5).trim(); if (d === '[DONE]') continue;
              try { const j = JSON.parse(d); const dl = j.choices?.[0]?.delta?.content || ''; if (dl) reply += dl; } catch {}
            }
          }
          const wbOk = !wbErr && !!reply.trim();
          if (wbOk) {
            ch.consecutiveFail = 0; ch.probation = false; ch.cooldownUntil = 0; ch.lastError = null;
            if (ch.status !== 'ok') ch.status = 'ok';
            ch.latencyMs = ttfb; ch.lastCheck = Date.now();
            recordUsage({ model, channelId: c.channelId, kind: 'test', inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(reply), ok: true, latencyMs: ttfb });
          } else {
            recordFailure(ch, 'workbuddy: ' + String(wbErr || 'empty reply').slice(0, 150));
          }
          results.push({ channelId: c.channelId, ok: wbOk, status: wbStatus || 200, latencyMs: ttfb, reply: reply.slice(0, 200) || undefined, error: wbOk ? undefined : (wbErr || 'empty reply') });
          continue;
        }
        // Genspark 渠道：网页会话 ask_proxy 最小聊天（消耗 1 credit），curl+proxy 聚合全文
        if (ch.def.protocol === 'genspark') {
          const tmo = Math.min(90000, Number(body.timeoutMs) || 45000);
          const gsBody = JSON.stringify(gensparkBuildPayload(c.upstream, [{ role: 'user', content: prompt }]));
          const out = await gensparkAsk(ch.def, gsBody, tmo);
          ttfb = Date.now() - t0;
          const parsed = gensparkParseSSE(out.body || '');
          let reply = '', gsErr = '';
          const gsStatus = out.status || 0;
          if (out.error || !out.body) gsErr = out.error || 'empty body';
          else if (parsed.notLogin) gsErr = 'session 失效（not login / is_login:false）';
          else if (parsed.rateLimited) gsErr = '触发限流（rate limit / too quickly / 积分已用完，已冷却）';
          else if (parsed.error) gsErr = parsed.error;
          else reply = (parsed.finalContent || parsed.fullText || '').trim();
          const gsOk = !gsErr && !!reply && !parsed.placeholder;
          if (gsOk) {
            ch.consecutiveFail = 0; ch.probation = false; ch.cooldownUntil = 0; ch.lastError = null;
            if (ch.status !== 'ok') ch.status = 'ok';
            ch.latencyMs = ttfb; ch.lastCheck = Date.now();
            recordUsage({ model, channelId: c.channelId, kind: 'test', inputTokens: parsed.usage ? parsed.usage.prompt_tokens : estimateTokens(prompt), outputTokens: parsed.usage ? parsed.usage.completion_tokens : estimateTokens(reply), ok: true, latencyMs: ttfb, realUsage: parsed.usage || null });
          } else {
            // 会话失效(notLogin)=凭证类 → 起步 5 分钟；限流(rateLimited) 上游明确说"别急" → 沿用一小时
            recordFailure(
              ch,
              'genspark: ' + String(gsErr || (parsed.placeholder ? '上游占位符回复' : 'empty reply')).slice(0, 150),
              parsed.notLogin ? 'credential' : parsed.rateLimited ? 'rate_limit' : undefined,
              parsed.rateLimited ? { retryAfterMs: 3600_000 } : undefined,
            );
          }
          results.push({ channelId: c.channelId, ok: gsOk, status: gsStatus || 200, latencyMs: ttfb, reply: reply.slice(0, 200) || undefined, error: gsOk ? undefined : (gsErr || 'empty reply') });
          continue;
        }
        // Codex 渠道：RT→AT → /responses（Responses API），curl+代理，聚合 output_text
        if (ch.def.protocol === 'codex') {
          const tmo = Math.min(120000, Number(body.timeoutMs) || 60000);
          let cxErr = '', reply = '', cxStatus = 200;
          try {
            const call = await codexCallResponses(ch, c.upstream, [{ role: 'user', content: prompt }], tmo);
            cxStatus = call.status || 200;
            if (!call.ok) cxErr = call.error || 'unknown';
            else {
              const parsed = codexParseSSE(call.text);
              reply = parsed.fullText;
              if (parsed.errMsg && !reply) cxErr = parsed.errMsg;
            }
          } catch (e) { cxErr = String(e.message || e); }
          ttfb = Date.now() - t0;
          const cxOk = !cxErr && !!reply.trim();
          if (cxOk) {
            ch.consecutiveFail = 0; ch.probation = false; ch.cooldownUntil = 0; ch.lastError = null;
            if (ch.status !== 'ok') ch.status = 'ok';
            ch.latencyMs = ttfb; ch.lastCheck = Date.now();
            recordUsage({ model, channelId: c.channelId, kind: 'test', inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(reply), ok: true, latencyMs: ttfb });
          } else {
            recordFailure(ch, 'codex: ' + String(cxErr || 'empty reply').slice(0, 150));
          }
          results.push({ channelId: c.channelId, ok: cxOk, status: cxStatus, latencyMs: ttfb, reply: reply.slice(0, 200) || undefined, error: cxOk ? undefined : (cxErr || 'empty reply') });
          continue;
        }
        // 走 dispatchRequest 复用出站请求构造
        // 简化：自己拼一个最小 chat 请求
        const target = ch.def.protocol === 'anthropic'
          ? joinUrl(ch.def.baseUrl, 'v1/messages')
          : ch.def.protocol === 'gemini'
            ? joinUrl(ch.def.baseUrl, 'v1beta/models/' + encodeURIComponent(c.upstream) + ':generateContent')
            : joinUrl(ch.def.baseUrl, 'chat/completions');
        const baseHeaders = ch.def.protocol === 'anthropic'
          ? { 'Content-Type': 'application/json', 'x-api-key': ch.def.apiKey, 'anthropic-version': '2023-06-01' }
          : ch.def.protocol === 'gemini'
            ? { 'Content-Type': 'application/json', 'x-goog-api-key': ch.def.apiKey }
            : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.def.apiKey}` };
        const headers = applyCustomHeaders(baseHeaders, ch.def);
        let bodyOut;
        if (ch.def.protocol === 'anthropic') {
          bodyOut = { model: c.upstream, max_tokens: 16, messages: [{ role: 'user', content: prompt }] };
        } else if (ch.def.protocol === 'gemini') {
          bodyOut = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 16 } };
        } else {
          bodyOut = { model: c.upstream, max_tokens: 16, messages: [{ role: 'user', content: prompt }] };
        }
        let text;
        if (ch.def.proxy) {
          // PT02：配了代理的渠道，测试请求同样走 curl -x
          const out = await wbCurlRequest('POST', target, headers, JSON.stringify(bodyOut), Math.min(60000, Number(body.timeoutMs) || 30000), ch.def.proxy);
          text = out.body || '';
          resp = { ok: out.status >= 200 && out.status < 300, status: out.status };
        } else {
        resp = await zzFetch(target, { method: 'POST', headers, body: JSON.stringify(bodyOut), signal: ctrl.signal });
        text = await resp.text();
        // Cloudflare 拦截 → PS Schannel 回退
        if (!resp.ok && isCloudflareBlock(resp.status, text)) {
          const ps = await psHttpRequest('POST', target, headers, JSON.stringify(bodyOut), Math.min(60000, Number(body.timeoutMs) || 30000));
          if (ps.status > 0) {
            text = ps.body;
            resp = { ok: ps.status >= 200 && ps.status < 300, status: ps.status };
          }
        }
        }
        ttfb = Date.now() - t0;
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        const errText = (parsed && (parsed.error?.message || parsed.message)) || (resp.ok ? '' : text.slice(0, 200));
        // 测试成功时清零 channel 失败计数并标 ok（与主调度一致）
        if (resp.ok) {
          ch.consecutiveFail = 0;
          ch.probation = false;
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
    // 顺手清掉轮询状态：渠道删除后残留会让"同 id 重新加回来"继承旧的当前权值
    SWRR_CUR.delete(body.id); SWRR_HITS.delete(body.id);
    AUTO_STATE.delete(body.id); // 自动权重观测状态同理：不留旧健康分（否则重加回来显示的是上一个渠道的成绩）
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

// ─────────────────── 图片（多模态）能力门 ───────────────────
// 内部统一格式是 OpenAI：图片表示为 messages[].content 数组里的 image_url block。
// 目前只有 openai / anthropic / gemini 三种协议能带图出站：
//   · openai    —— 请求体原样转发（image_url 原样过去）；
//   · anthropic —— 出站转成 image 块（base64 或 url 两种 source）；
//   · gemini    —— 出站转成 inlineData / fileData。
// notion / notion-agent / workbuddy / genspark / codex 这些逆向与文本链只把 content 当字符串用 ——
// 把带图请求丢给它们＝**静默丢图后照样回答**，那比直接失败更糟（用户以为模型看过图）。
// 所以含图请求只保留能转发图片的渠道，一个都没有就明确报错。
const IMAGE_CAPABLE_PROTOCOLS = ['openai', 'anthropic', 'gemini'];

function bodyHasImages(body) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (Array.isArray(m && m.content) && m.content.some((b) => b && (b.type === 'image_url' || b.type === 'image' || b.image_url))) return true;
  }
  return false;
}

// 含图请求裁剪候选链；未命中图片时原样返回（零开销、零行为变化）
function filterCandidatesForImages(candidates, body) {
  if (!bodyHasImages(body)) return candidates;
  return candidates.filter((c) => IMAGE_CAPABLE_PROTOCOLS.includes(c.protocol || 'openai'));
}

// 含图但裁剪后没有候选 → 统一的 400 文案（避免"无渠道"的 404 误导成模型名写错）
const NO_IMAGE_CHANNEL_MSG = 'this request contains images, but no channel can forward them: only openai / anthropic / gemini protocol channels can carry images (openai 原样转发 image_url；anthropic 转 image 块；gemini 转 inlineData/fileData)';

async function handleOpenAIRequest(req, res, url) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return sendJson(res, 400, upstreamErrorPayload(400, 'invalid JSON body')); }
  sanitizeOpenAIToolIds(body); // 清洗工具 id（空/非法字符 → 合法，保持配对）
  const requested = body.model;
  if (!requested) return sendJson(res, 400, upstreamErrorPayload(400, 'missing model'));
  let candidates = channelsServing(requested, 'openai');
  // 原生 anthropic / gemini 协议渠道兜底：出站会被自动转成原生报文（见 nativeChannelOpts），
  // 所以它们同样能服务 OpenAI 客户端 —— 作为候选链尾部一层，不改动原有 openai 渠道的先后顺序。
  for (const nc of channelsServing(requested, ['anthropic', 'gemini'])) if (!candidates.some((c) => c.channelId === nc.channelId)) candidates.push(nc);
  // notion 渠道兜底：openai 渠道全挂/限频时接住（作为候选链尾部，不抢优先级）
  const notionCands = channelsServing(requested, 'notion');
  for (const nc of notionCands) if (!candidates.some((c) => c.channelId === nc.channelId)) candidates.push(nc);
  // notion-agent（官方 Agent API）兜底：消耗 credits，放链尾仅当逆向全挂时接住
  const agentCands = channelsServing(requested, 'notion-agent');
  for (const gc of agentCands) if (!candidates.some((c) => c.channelId === gc.channelId)) candidates.push(gc);
  // workbuddy（国际版反代）兜底：OpenAI 兼容流式，免费 deepseek-v4.1-flash
  const wbCands = channelsServing(requested, 'workbuddy');
  for (const wc of wbCands) if (!candidates.some((c) => c.channelId === wc.channelId)) candidates.push(wc);
  // genspark（网页会话反代）兜底：免费号 1 credit/次、100/天 → 链尾接住（放在 codex 前）
  const gsCands = channelsServing(requested, 'genspark');
  for (const gc of gsCands) if (!candidates.some((c) => c.channelId === gc.channelId)) candidates.push(gc);
  // codex（ChatGPT 官方订阅反代）兜底
  const cxCands = channelsServing(requested, 'codex');
  for (const xc of cxCands) if (!candidates.some((c) => c.channelId === xc.channelId)) candidates.push(xc);
  // 含图请求：只留能转发 image_url 的渠道（见 IMAGE_CAPABLE_PROTOCOLS）
  const beforeImgFilter = candidates.length;
  candidates = filterCandidatesForImages(candidates, body);
  if (candidates.length === 0 && beforeImgFilter > 0) {
    return sendJson(res, 400, upstreamErrorPayload(400, NO_IMAGE_CHANNEL_MSG));
  }
  if (candidates.length === 0) {
    const sug = suggestAliases(requested);
    const hint = sug.length ? `；你是不是想调：${sug.join(' / ')}` : '；调 GET /v1/models 可查看当前所有可用模型名';
    return sendJson(res, 404, upstreamErrorPayload(404, `no openai channel for model "${requested}"${hint}`));
  }
  return dispatchRequest({
    kind: 'openai',
    res,
    url,
    body,
    candidates,
    affinityKey: affinityKeyFor(req, body),
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

// ─────────────────────────── 图片生成调度 ───────────────────────────
// OpenAI 兼容 POST /v1/images/generations：只走 openai 协议渠道（中转站若支持 images 上游会透传成功），
// 请求体原样转发（仅替换 model 为渠道 upstream），响应原样透传。
// 图像候选独立查找：命中显式 alias，或命中该渠道探测到的上游模型名（不受 autoAlias 影响）。
// 这样不影响 /v1/models 与聊天路由的别名语义，但让用户已上架的 gpt-image/dall-e 直接可用。
function imageCandidates(model) {
  const want = String(model || '').toLowerCase().trim();
  if (!want) return [];
  const out = [];
  for (const ch of channels.values()) {
    if (!ch.def.enabled) continue;
    if ((ch.def.protocol || 'openai') !== 'openai') continue;
    let upstream = null;
    if (ch.aliasMap.has(want)) upstream = ch.aliasMap.get(want);
    else {
      const hit = (ch.models || []).find((m) => String(m).toLowerCase() === want);
      if (hit) upstream = hit;
    }
    if (!upstream) continue;
    out.push({
      channelId: ch.def.id,
      upstream,
      priority: ch.def.priority ?? 0,
      status: ch.status,
      latencyMs: ch.latencyMs,
      cooldownUntil: ch.cooldownUntil,
      consecutiveFail: ch.consecutiveFail,
      probation: !!ch.probation,
      protocol: 'openai',
      kind: 'explicit',
      weight: Number(ch.def.weight) > 0 ? Number(ch.def.weight) : 0,
    });
  }
  out.sort((a, b) => {
    // 分层：冷却中(3) → down(2) → probation(1：探测"半愈合"过、欠账还记着) → 健康(0)
    // probation 自成一档，就是为了让"探测救回来但对话仍然可疑"的渠道排在健康渠道之后，不去抢链首。
    // 注意别拿 status==='degraded' 当这个信号：那个状态另有含义（探测拉回了空模型列表），
    // 混用会把"列表为空但别名可用"的渠道也误降级（weighted-rr/console-weight 的回归就是这么发现的）。
    const healthy = (c) => (c.cooldownUntil > Date.now() ? 3 : c.status === 'down' ? 2 : c.probation ? 1 : 0);
    const ha = healthy(a), hb = healthy(b);
    if (ha !== hb) return ha - hb;
    return b.priority - a.priority;
  });
  // 图片生成候选与聊天候选共用同一套加权轮询（同一渠道的权重语义一致）
  return applyWeightedPick(out);
}

async function handleImageRequest(req, res, url) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return sendJson(res, 400, upstreamErrorPayload(400, 'invalid JSON body')); }
  const requested = body.model;
  if (!requested) return sendJson(res, 400, upstreamErrorPayload(400, 'missing model'));
  const candidates = imageCandidates(requested);
  if (candidates.length === 0) {
    return sendJson(res, 404, upstreamErrorPayload(404, `no openai channel for image model "${requested}"（该渠道未上架此图像模型，或未探测到——到渠道管理里点探测刷新模型列表）`));
  }
  return dispatchRequest({
    kind: 'images',
    res,
    url,
    body,
    candidates,
    requestedModel: requested,
    isStream: false,
    encodeOutgoing: (b, c) => ({ ...b, model: c.upstream }),
    buildOutgoingUrl: (ch) => joinUrl(ch.def.baseUrl, 'images/generations'),
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
    // 优先 anthropic 协议渠道；没有则回落 openai / gemini 协议（网关做双向转换）；notion 始终作为兜底候选
    let candidates = channelsServing(requested, 'anthropic');
    if (candidates.length === 0) candidates = channelsServing(requested, ['openai', 'gemini']);
    for (const gc of channelsServing(requested, ['openai', 'gemini'])) if (!candidates.some((c) => c.channelId === gc.channelId)) candidates.push(gc);
    for (const nc of channelsServing(requested, 'notion')) if (!candidates.some((c) => c.channelId === nc.channelId)) candidates.push(nc);
    for (const gc of channelsServing(requested, 'notion-agent')) if (!candidates.some((c) => c.channelId === gc.channelId)) candidates.push(gc);
    for (const xc of channelsServing(requested, 'codex')) if (!candidates.some((c) => c.channelId === xc.channelId)) candidates.push(xc);
    if (candidates.length === 0) {
      return sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `no channel for model "${requested}"` } });
    }
    const isStream = !!body.stream;
    const oaiBody = sanitizeOpenAIToolIds(anthropicToOpenAI(body)); // 转换 + 清洗工具 id
    // 流式转换器必须**每个请求一个实例**（要跨 chunk 记住 block 索引与工具参数分片）
    const antStream = isStream ? createAnthropicStreamConverter(requested) : null;
    const beforeImgFilter = candidates.length;
    candidates = filterCandidatesForImages(candidates, oaiBody);
    if (candidates.length === 0 && beforeImgFilter > 0) {
      return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: NO_IMAGE_CHANNEL_MSG } });
    }
    return dispatchRequest({
      kind: 'anthropic',
      res,
      url: { ...url, pathname: '/v1/chat/completions' }, // 复用 OpenAI 上游路径
      body: oaiBody,
      candidates,
      // 粘性键用**客户端原始报文**推导（这里 body 是转换后的 OpenAI 体，会话标识在原始体里）
      affinityKey: affinityKeyFor(req, body),
      // thinking 回放会话键（v1.18.8）：同一套推导，但不受粘性开关牵连（回放开、粘性关是合法组合）
      replayKey: replaySessionKeyFor(req, body),
      requestedModel: requested,
      isStream,
      // 同协议直通（v1.15）：选中 anthropic 协议渠道时，出站直接用客户端原始报文、响应原样回传
      clientProto: 'anthropic',
      rawClientBody: body,
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
        // oaiChunk 是 OpenAI SSE 的一行（data: {...}）；逐行喂给**有状态**的转换器
        const line = oaiChunk.trim();
        if (!line.startsWith('data:')) return null;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return anthropicEventsToSSE(antStream.end());
        let j;
        try { j = JSON.parse(data); } catch { return null; }
        return anthropicEventsToSSE(antStream.push(j));
      },
      // message_start 在响应头之后立刻发；收尾（关块 + message_delta + message_stop）在流结束时兜底，
      // 这样上游不发 [DONE] 也能给出完整事件序列（end() 幂等，不会与 [DONE] 重复）。
      streamPrelude: () => anthropicEventsToSSE(antStream.start()),
      streamEpilogue: () => anthropicEventsToSSE(antStream.end()),
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

  // 优先 gemini 协议渠道；没有则回落 openai / anthropic 协议（网关做双向转换）
  let candidates = channelsServing(model, 'gemini');
  if (candidates.length === 0) candidates = channelsServing(model, ['openai', 'anthropic']);
  for (const gc of channelsServing(model, ['openai', 'anthropic'])) if (!candidates.some((c) => c.channelId === gc.channelId)) candidates.push(gc);
  for (const nc of channelsServing(model, 'notion')) if (!candidates.some((c) => c.channelId === nc.channelId)) candidates.push(nc);
  for (const gc of channelsServing(model, 'notion-agent')) if (!candidates.some((c) => c.channelId === gc.channelId)) candidates.push(gc);
  if (candidates.length === 0) {
    return sendJson(res, 404, { error: { code: 404, message: `no channel for model "${model}"`, status: 'NOT_FOUND' } });
  }

  // 注意：Gemini 的"流式"体现在 URL 动作（:streamGenerateContent）而不是 body 字段，
  // 所以出站必须显式带上 stream —— 否则上游返回的是**非流式整包 JSON**，而网关按 SSE 往外写，
  // 客户端拿到的是空/垃圾（Gemini 流式一直不可用的根因之一）。
  const oaiBody = geminiToOpenAI(body, model);
  oaiBody.stream = isStream;
  const beforeImgFilter = candidates.length;
  candidates = filterCandidatesForImages(candidates, oaiBody);
  if (candidates.length === 0 && beforeImgFilter > 0) {
    return sendJson(res, 400, { error: { code: 400, message: NO_IMAGE_CHANNEL_MSG, status: 'INVALID_ARGUMENT' } });
  }
  // 流式工具调用的累积状态（见 openAIStreamToGeminiSSE）：整个请求共用一份，跨 chunk 攒参数分片
  const geminiStreamState = {};
  return dispatchRequest({
    kind: 'gemini',
    res,
    url: { ...url, pathname: '/v1/chat/completions' },
    body: oaiBody,
    candidates,
    affinityKey: affinityKeyFor(req, body),
    requestedModel: model,
    isStream,
    // 同协议直通（v1.15）：选中 gemini 协议渠道时，出站用客户端原始报文（模型名在 URL 里）、响应原样回传
    clientProto: 'gemini',
    rawClientBody: body,
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
        const gems = openAIStreamToGeminiSSE([j], geminiStreamState);
        return gems.map((g) => `data: ${JSON.stringify(g)}\n\n`).join('');
      } catch { return null; }
    },
  });
}

// 4xx 兜底判定：只要后面还有候选，"上游 4xx"就不许短路兜底。
// 为什么：渠道声明了上游早已下架的模型（别名表过期 → 上游 404）、各家参数方言不同（有的中转不认
// stream_options / 特定 temperature）——这类 4xx 换一家很可能就能成。而网关在此之前**已经**给这家
// 记了失败（recordFailure / 置冷却），却把上游 4xx 甩给客户端并就此停手：等于自己认定是渠道的错、
// 却对客户端说是客户端的错，还不兜底，逻辑自相矛盾（现象：该模型明明有能用的候选，客户端却拿到 404）。
// 只有**最后一个候选**才原样透传 —— 保住"客户端的错就该原样回给调用方"这条语义：没人可切了，
// 400 参数错照原样回传，客户端看到的错误类不变（只是"还有别的家可试"时不再提前放弃）。
// 兜底名单仍保留渠道侧状态码：鉴权/余额/该渠道没有此模型/超时/限频，跨渠道各不相同，必须切。
// 代价（如实记）：真·客户端错误（参数写错）现在会把候选链走完才回 4xx，请求变慢、上游多挨几下；
// 与之相比"明明有能用的渠道却给客户端报错"更糟。链长本身受 RETRIES.maxModelFallbacks 约束；
// 同一家的**额外重试**次数由 RETRIES.perChannel 控制（v1.9.3 起接线，且只对 5xx/超时/网络错误重试）。
function shouldPassThrough4xx(status, hasMoreCandidates) {
  if (!(status >= 400 && status < 500)) return false;
  if ([401, 402, 403, 404, 408, 429].includes(status)) return false;
  return !hasMoreCandidates;
}

// 同渠道重试的判据：这次失败"值不值得在原地再试一次"。
// 值得：5xx / 网络错误 / 超时 / 上游异常响应——多为瞬时故障，立刻重试常常就过了。
// 不值得：4xx（tryChannel 以 'channel_error' 明确标注）——重发同一个请求只会再收一次同样的拒绝，
//   而且其中不少是**客户端的参数错**，重试纯粹是在给上游添负载、让客户端多等一轮。
function isRetryableFailure(result) {
  if (result === 'channel_error') return false;
  if (result === 'success' || result === 'fatal_client') return false;
  return true;
}

// ─────────────────────────── 调度核心（统一） ───────────────────────────
async function dispatchRequest(opts) {
  const { res, url, body, candidates, isStream, encodeOutgoing, buildOutgoingUrl, buildOutgoingHeaders, onSuccessNonStream, onStreamChunk, requestedModel, kind } = opts;
  const errors = [];
  let attemptedAny = false;
  const stream = !!isStream;
  const maxCand = Math.min(candidates.length, RETRIES.maxModelFallbacks || 99);
  // v1.17 会话粘性（默认关闭）：命中且"那家确实还在候选里、还能上场"时把它提到链首。
  // 只动顺序、不硬塞渠道——冷却/down/不在候选表里时一切照旧，也不会去清冷却。
  applyAffinity(candidates, opts.affinityKey);

  for (let i = 0; i < maxCand; i++) {
    const c = candidates[i];
    if (c.cooldownUntil > Date.now()) {
      // 冷却跳过也要说明"为什么 + 还有多久"：只说一句 'in cooldown'，用户拿到的 502 里
      // 就看不出是额度用尽（还要等几小时）还是刚抖了一下（几秒后就恢复）。v1.14.1
      const st = channels.get(c.channelId);
      const leftMs = c.cooldownUntil - Date.now();
      const leftS = leftMs >= 3600e3 ? `${Math.floor(leftMs / 3600e3)}h${Math.round((leftMs % 3600e3) / 60e3)}m`
        : leftMs >= 60e3 ? `${Math.round(leftMs / 60e3)}m` : `${Math.ceil(leftMs / 1000)}s`;
      errors.push({
        ch: c.channelId,
        err: `in cooldown（约 ${leftS} 后恢复${st && st.lastError ? '：' + String(st.lastError).replace(/\s+/g, ' ').slice(0, 160) : ''}）`,
        recoverInMs: leftMs,
      });
      continue;
    }
    attemptedAny = true;
    // 还有后续候选 → 守门可以掐得早（快速切兜底）；已是最后候选 → 守门放宽到 300s（对齐
    // 客户端 idle 超时：上游"慢但能成"的请求留给客户端自身的重试机制，而不是被网关提前掐死）
    // ★ 必须只看**还能上场的**候选：冷却中的那家这一轮根本不会被 attempt，若把它算成"还有后手"，
    //   4xx 兜底会切进一个空池——最后兜出个 502，把客户端本来该看到的 400 弄丢了。
    const hasMoreCandidates = candidates.slice(i + 1, maxCand).some((x) => !(x.cooldownUntil > Date.now()));
    // ★ 原生出站单点注入：候选渠道声明 anthropic / gemini 协议时，覆盖出站编码/URL/请求头，
    //   并挂上"原生响应 → 内部 OpenAI"的翻译钩子。路由侧回调一行都不用改。
    const chDef = channels.get(c.channelId) && channels.get(c.channelId).def;
    const chProto = (chDef && chDef.protocol) || 'openai';
    const native = (chProto === 'anthropic' || chProto === 'gemini')
      ? ((opts.clientProto && opts.clientProto === chProto)
        // 同协议直通：不翻译（v1.15）；v1.18.8 thinking 回放——客户端丢了签名的 thinking 块先按缓存补签，
        // 没有缺签名的块（或一条都没命中）时传原始报文，直通保真一个字段都不动
        ? passthroughChannelOpts(chProto, (chProto === 'anthropic'
          ? repairThinkingBody(opts.replayKey, c.channelId, requestedModel, opts.rawClientBody)
          : null) || opts.rawClientBody)
        : nativeChannelOpts(chProto, requestedModel))
      : null;
    // ★ 同渠道重试（perChannel）：一次请求内对**同一家**最多再试 PER_CHANNEL_RETRIES 次，
    //   只重试可重试的失败（5xx/网络/超时）；4xx 与 fatal_client 立刻跳出换下家。
    //   注意：冷却只挡"下一次请求"选不选它，不挡这里的原地重试——正是要靠这次重试把瞬时抖动吃掉。
    let result;
    for (let attempt = 0; ; attempt++) {
      result = await tryChannel({
        res, url, body, candidate: c, isStream: stream,
        encodeOutgoing, buildOutgoingUrl, buildOutgoingHeaders, onSuccessNonStream, onStreamChunk, requestedModel, kind,
        replayKey: opts.replayKey,   // v1.18.8 thinking 回放：学习/作废要用（修复已在选路处做过）
        ...(native || {}),
        // 流式的"开场/收尾"钩子也必须转发：漏掉它们时 message_start 与收尾事件就不会发出
        // （历史上这里漏了 streamPrelude，导致 Anthropic 流式一直没有 message_start）
        streamPrelude: opts.streamPrelude, streamEpilogue: opts.streamEpilogue,
        hasMoreCandidates,
        attempt,
      });
      if (result === 'success') { affinityLearn(opts.affinityKey, c.channelId); return; }
      if (result === 'fatal_client') return;
      // 响应头已发出（某候选已开始写响应）→ 无法再切换渠道，直接结束
      if (res.headersSent || res.writableEnded) {
        if (!res.writableEnded) { try { res.end(); } catch {} }
        return;
      }
      errors.push({ ch: c.channelId, err: result, ...(attempt ? { attempt } : {}) });
      if (!isRetryableFailure(result) || attempt >= PER_CHANNEL_RETRIES) break;
    }
  }
  if (!attemptedAny) {
    // 全部候选都在冷却：不能只回一句 "all channels in cooldown"——用户没法判断是额度用完、
    // 凭证失效还是上游抖动。带上每家的最后失败原因与各自还有多久恢复（v1.14.1）。
    const nowMs = Date.now();
    const cd = candidates.slice(0, maxCand)
      .filter((x) => x.cooldownUntil > nowMs)
      .map((x) => {
        const secs = Math.ceil((x.cooldownUntil - nowMs) / 1000);
        const eta = secs >= 3600 ? `${Math.floor(secs / 3600)} 小时 ${Math.round((secs % 3600) / 60)} 分`
          : secs >= 60 ? `${Math.round(secs / 60)} 分` : `${secs} 秒`;
        const state = channels.get(x.channelId);
        const why = state && state.lastError ? String(state.lastError).replace(/\s+/g, ' ').slice(0, 160) : '（无失败详情）';
        return { channelId: x.channelId, recoverInMs: x.cooldownUntil - nowMs, recoverIn: eta, reason: why };
      });
    const soonest = cd.reduce((a, b) => (!a || b.recoverInMs < a.recoverInMs ? b : a), null);
    const payload = upstreamErrorPayload(503, 'all channels in cooldown' +
      (soonest ? `（全部候选都在冷却，最近一家 ${soonest.channelId} 约 ${soonest.recoverIn} 后恢复）` : ''));
    payload.error.cooldown = cd;
    return sendJson(res, 503, payload);
  }
  return sendJson(res, 502, { error: { message: `all channels failed`, type: 'gateway_error', attempts: errors } });
}

async function tryChannel(opts) {
  const { res, url, body, candidate, isStream, encodeOutgoing, buildOutgoingUrl, buildOutgoingHeaders, onSuccessNonStream, onStreamChunk } = opts;
  const ch = channels.get(candidate.channelId);
  try {
    // Notion 协议渠道：完全独立的请求/响应路径
    if ((ch.def.protocol || 'openai') === 'notion') {
      return await tryNotionChannel({ res, body, candidate, ch, isStream, kind: opts.kind, requestedModel: opts.requestedModel, hasMoreCandidates: opts.hasMoreCandidates });
    }
    // Notion 官方 Agent API 渠道：会话式调用工作区 Custom Agent
    if ((ch.def.protocol || 'openai') === 'notion-agent') {
      return await tryNotionAgentChannel({ res, body, candidate, ch, isStream, kind: opts.kind, requestedModel: opts.requestedModel, hasMoreCandidates: opts.hasMoreCandidates });
    }
    // WorkBuddy 国际版反代：只支持流式 + 首条必须 system，OpenAI 兼容 SSE
    if ((ch.def.protocol || 'openai') === 'workbuddy') {
      return await tryWorkbuddyChannel({ res, body, candidate, ch, isStream, kind: opts.kind, requestedModel: opts.requestedModel, hasMoreCandidates: opts.hasMoreCandidates });
    }
    // Genspark 网页会话反代：curl+proxy 绕 cn_code 门/CF，SSE 聚合后分发
    if ((ch.def.protocol || 'openai') === 'genspark') {
      return await tryGensparkChannel({ res, body, candidate, ch, isStream, kind: opts.kind, requestedModel: opts.requestedModel, hasMoreCandidates: opts.hasMoreCandidates });
    }
    // Codex（ChatGPT 官方订阅）：RT→AT 令牌管理 + Responses API，curl+代理传输
    if ((ch.def.protocol || 'openai') === 'codex') {
      return await tryCodexChannel({ res, body, candidate, ch, isStream, kind: opts.kind, requestedModel: opts.requestedModel, hasMoreCandidates: opts.hasMoreCandidates });
    }
  const outgoing = encodeOutgoing(body, candidate);
  const passthrough = opts.passthrough || null;   // 同协议直通时由扩展注入（'anthropic' / 'gemini'）
  const target = buildOutgoingUrl(ch, candidate, isStream);
  const headers = applyCustomHeaders(buildOutgoingHeaders(ch), ch.def);
  const bodyStr = JSON.stringify(outgoing);
  const timeoutMs = ch.def.timeoutMs || 120_000;

  const t0 = Date.now();
  let resp;
  let usedFallback = false;
  let respBody = null;

  if (ch.def.proxy) {
    // PT02：渠道配了代理 → 全程 curl -x（undici fetch 不支持代理）。响应全量缓冲，
    // 流式请求走下方 usedFallback 分支整体重放（与 CF 回退同款语义，首字节延迟=上游总耗时）
    const out = await wbCurlRequest('POST', target, headers, bodyStr, timeoutMs, ch.def.proxy);
    if (out.error || !out.body) {
      recordFailure(ch, 'proxy: ' + (out.error || 'empty body'));
      return `proxy: ${out.error || 'empty body'}`;
    }
    usedFallback = true;
    respBody = out.body;
    resp = {
      status: out.status,
      ok: out.status >= 200 && out.status < 300,
      headers: { get: () => 'application/json' },
      text: async () => out.body,
      json: async () => safeJson(out.body) || {},
      body: null,
    };
  } else try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      resp = await zzFetch(target, { method: 'POST', headers, body: bodyStr, signal: ctrl.signal });
    } finally { clearTimeout(to); }
  } catch (err) {
    recordFailure(ch, String(err && err.message || err));
    return `network: ${err.message || err}`;
  }

  // 如果 fetch 被 Cloudflare 拦了（403 + HTML），且是非流请求，回退到 PowerShell (.NET Schannel)
  // （代理路径不走这条：它本身已是 curl 指纹，403 就是真 403，无代理重试没有意义）
  if (resp.status === 403 && !isStream && !ch.def.proxy) {
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
    // 429 时若上游给了 Retry-After，就照它说的等（比我们自己拍的曲线更准）；否则按状态码分级退避
    recordFailure(ch, `HTTP ${resp.status}: ${String(text).slice(0, 200)}`, failureKindFromStatus(resp.status), {
      retryAfterMs: retryAfterMsFromHeaders(resp.headers),
    });
    // 401/402/403/404/408/429 是渠道侧问题（鉴权/余额/该渠道没有此模型/超时/限频，跨渠道各不相同）→ 切下一候选兜底；
    // 其余 4xx（400 参数错等）**只在没有后续候选时**才原样透传 ——
    // 详见 shouldPassThrough4xx 的注释（渠道声明过期的模型 / 参数方言不同，换一家往往就能成）。
    if (shouldPassThrough4xx(resp.status, opts.hasMoreCandidates)) {
      // 客户端错误：直接把上游响应转发
      // v1.18.8 thinking 回放：直通 anthropic 且报错文案指向签名/thinking 时，这组记录作废（stale）——
      // 同一条坏记录（比如客户端把自己的 thinking 文本改了）不许反复引发 4xx
      if (passthrough === 'anthropic' && opts.replayKey && /signature|thinking/i.test(text)) {
        replayStale(opts.replayKey, candidate.channelId, opts.requestedModel);
      }
      const ct = (resp.headers && resp.headers.get('content-type')) || '';
      res.writeHead(resp.status, { 'Content-Type': ct || 'application/json' });
      res.end(text);
      return 'fatal_client';
    }
    // 走到这里仍是 4xx（渠道侧状态码，或"后面还有候选"的请求类 4xx）：切下家，但**同渠道不重试**
    if (resp.status < 500) return 'channel_error';
    return `upstream ${resp.status}${usedFallback ? (ch.def.proxy ? ' (via proxy)' : ' (via ps-fallback)') : ''}`;
  }

  // 成功
  ch.consecutiveFail = 0;
  ch.probation = false;
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
    if (typeof opts.streamPrelude === 'function' && !passthrough) {
      const pre = opts.streamPrelude();
      if (pre) res.write(pre);
    }
    const decoder = new TextDecoder();
    let buf = '';
    let streamOutText = ''; // 累计输出（用于 token 估算）
    // ★ 原生渠道：把上游的原生 SSE 逐行翻译成 OpenAI SSE，再喂给路由既有的 onStreamChunk。
    //   路由没有 onStreamChunk 时（OpenAI 路由是原样透传）就直接写翻译结果 —— 否则客户端会把
    //   Anthropic/Gemini 的事件当 OpenAI 分片解析，一个字段都读不出来。
    let nativeStream = null;
    if (typeof opts.makeStreamTranslator === 'function' && !passthrough) nativeStream = opts.makeStreamTranslator(candidate);
    let passthroughUsage = null;   // 直通流式：从上游原始事件里读真实 usage
    let replayScan = null;         // v1.18.8 直通流式旁路：攒 thinking 块（只攒上游签过的，不影响转发字节）
    // 非直通：一次 drain 里的所有输出合并成一次 write（v1.16）。
    // 旧写法每行一次 write，"数据行 + 分隔空行"被拆成两次 —— 实测上游 11 个 TCP 事件
    // 会变成客户端 24 次写。合并后字节完全相同，写次数与上游分帧对齐。
    let outChunks = [];
    const emitNative = (lines) => {
      let outText = '';
      for (const l of lines) {
        if (!l) continue;
        outText += onStreamChunk ? (onStreamChunk(l, candidate) || '') : l;
      }
      return outText;
    };
    // 按行分发：有 onStreamChunk 就逐行转换，否则原样透传（补回被切掉的分隔空行）
    const handleLine = (line) => {
      if (nativeStream) {
        // 原生：raw 行没有 OpenAI 的 delta 字段，逐个统计没有意义 → 按翻译后的输出估算
        const out = emitNative(nativeStream.push(line + '\n'));
        streamOutText += sseDeltaText(out);
        if (out) outChunks.push(out);
        return;
      }
      streamOutText += sseDeltaText(line);
      if (onStreamChunk) {
        const out = onStreamChunk(line + '\n', candidate);
        if (out) outChunks.push(out);
      } else {
        outChunks.push(line + '\n');
      }
    };
    const flushOut = () => {
      if (!outChunks.length) return;
      res.write(outChunks.join(''));
      outChunks = [];
    };
    const drain = (final) => {
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
      if (final && buf.length) { handleLine(buf); buf = ''; }
      flushOut();
    };
    // ★ 直通（v1.16）：原始字节直接转给客户端，不再逐行重组 ——
    //   因此 CRLF/分帧边界/空行与上游**逐字节一致**（旧写法把 CRLF 归一成 LF，还把每帧拆成两次写）。
    //   同时旁路一份文本，只用于真实 usage 扫描与 token 估算，不影响转发内容。
    let scanBuf = '';
    const passthroughWrite = (u8) => {
      res.write(u8);
      scanBuf += decoder.decode(u8, { stream: true });
      let i;
      while ((i = scanBuf.indexOf('\n')) >= 0) {
        const line = scanBuf.slice(0, i);
        scanBuf = scanBuf.slice(i + 1);
        passthroughUsage = nativeStreamUsageScan(passthrough, line, passthroughUsage);
        if (passthrough === 'anthropic') replayScan = thinkingStreamScan(line, replayScan);
        streamOutText += sseDeltaText(line) || line;
      }
    };

    try {
      // ★ 首块字节必须和后续字节走同一条按行分发路径。早期实现只把它塞进 buf 就进 read 循环，
      //   于是"上游把整个流一次送到（快线路 / 小回答）"时下一次 read 直接 done，
      //   透传分支（OpenAI 路由没有 onStreamChunk）一个字节都没写出去 ——
      //   表现是 HTTP 200 + text/event-stream 却是**空响应体**，三种客户端协议全中招。
      if (firstVal && firstVal.length) {
        if (passthrough) passthroughWrite(firstVal);
        else { buf += decoder.decode(firstVal, { stream: true }); drain(false); }
      }
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (passthrough) passthroughWrite(value);
        else { buf += decoder.decode(value, { stream: true }); drain(false); }
      }
      if (passthrough) {
        scanBuf += decoder.decode();   // 冲掉解码器里残留的多字节字符
        if (scanBuf.length) {
          passthroughUsage = nativeStreamUsageScan(passthrough, scanBuf, passthroughUsage);
          if (passthrough === 'anthropic') replayScan = thinkingStreamScan(scanBuf, replayScan);
          streamOutText += sseDeltaText(scanBuf) || scanBuf;
        }
      } else {
        buf += decoder.decode(); // 冲掉解码器里残留的多字节字符
        drain(true);
      }
    } catch (err) { /* 上游已断 */ }
    // 原生流式收尾：上游没发结束标记（异常断流）时也要把 finish_reason + [DONE] 补上，
    // 否则客户端的流式解析器会一直等（与 Anthropic 路由的 streamEpilogue 是同一类兜底）
    if (nativeStream) {
      const tail = emitNative(nativeStream.end());
      if (tail) res.write(tail);
    }
    if (typeof opts.streamEpilogue === 'function' && !passthrough) {
      const post = opts.streamEpilogue();
      if (post) res.write(post);
    }
    // v1.18.8 thinking 回放学习点（直通流式）：攒完的带签名 thinking 块顺手记下——
    // 只在直通 anthropic + 有会话键时记；没走到 content_block_stop 的半截块不记
    if (passthrough === 'anthropic' && opts.replayKey && replayScan && replayScan.done.length) {
      replayLearn(opts.replayKey, candidate.channelId, opts.requestedModel, replayScan.done);
    }
    res.end();
    recordUsage({
      model: body && body.model, channelId: candidate.channelId, kind: opts.kind,
      inputTokens: estimateTokens(messagesText(body && body.messages)),
      outputTokens: estimateTokens(streamOutText), ok: true, latencyMs: Date.now() - t0,
      realUsage: passthroughUsage,
    });
    return 'success';
  } else {
    // 非流式：先读全文（统计 + 转发），shim 给 handler 避免 double-read
    const rawText = await resp.text();
    // ★ 同协议直通：上游报文就是客户端想要的格式 → 一个字段都不动，原样写回（连 Content-Type 都照抄）。
    //   这条分支**必须**跳过下面的 translateResponse/onSuccessNonStream，否则等于刚省掉的翻译又加回来。
    if (passthrough) {
      let realUsage = null;
      let parsed = null;
      try { parsed = JSON.parse(rawText); } catch { /* 非 JSON 上游 */ }
      if (parsed) {
        realUsage = nativeUsageToOpenAI(passthrough, parsed);
        // v1.18.8 thinking 回放学习点（直通非流式）：上游自己签过的 thinking 块顺手记下——
        // 只记带签名的、只记直通 anthropic、只记拿得到会话键的（三缺一就不学）
        if (passthrough === 'anthropic' && opts.replayKey) {
          replayLearn(opts.replayKey, candidate.channelId, opts.requestedModel, thinkingPairsFromAnthropic(parsed));
        }
      }
      recordUsage({
        model: body && body.model, channelId: candidate.channelId, kind: opts.kind,
        inputTokens: estimateTokens(messagesText(body && body.messages)),
        outputTokens: estimateTokens(rawText), ok: true, latencyMs: Date.now() - t0, realUsage,
      });
      const ct = (resp.headers && typeof resp.headers.get === 'function' && resp.headers.get('content-type')) || 'application/json';
      res.writeHead(200, { 'Content-Type': ct, 'X-ZZCSAPI-Channel': candidate.channelId });
      res.end(rawText);
      return 'success';
    }
    // ★ 原生渠道：响应体是 Anthropic / Gemini 格式 → 先翻译成内部 OpenAI 再交给路由回调。
    //   只有 resp.ok 才翻译：错误体原样透传（4xx 判定与客户端看到的错误必须是真的）。
    const text = (resp.ok && typeof opts.translateResponse === 'function') ? opts.translateResponse(rawText) : rawText;
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
    // shim 必须像 fetch Response 一样同时提供 text() 与 json()：Anthropic / Gemini 两条路由的
    // 响应转换都调 oai.json()，缺了它非流式请求会一律 502（internal: oai.json is not a function）
    const shim = {
      ok: resp.ok,
      status: resp.status,
      headers: resp.headers,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
    await onSuccessNonStream(shim, candidate);
    return 'success';
  }
  } catch (err) {
    // 渠道处理器内部异常兜底：不再让单个渠道的 bug 打崩整个网关进程
    console.error('[tryChannel] internal error:', err);
    try { recordFailure(ch, 'internal: ' + String(err && err.message || err).slice(0, 200)); } catch {}
    if (res.headersSent || res.writableEnded) { try { res.end(); } catch {} return 'fatal_client'; }
    return 'internal: ' + (err && err.message || err);
  }
}

// ─────────────────────────── Notion 渠道执行 ───────────────────────────
// 凭据缓存：ch.notion = {userId, spaceId, spaceViewId, userName, userEmail, at}
async function ensureNotionAccount(ch, timeoutMs) {
  if (ch.notion && Date.now() - ch.notion.at < 3600_000) return ch.notion;
  const acct = await notion.notionDiscoverAccount(ch.def.baseUrl, ch.def.apiKey, zzFetch, timeoutMs || 15000);
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

// Notion 渠道输入压缩：超长上下文会导致上游破坏性截断（实测 10 万 token 级
// 输入下模型的 system 工具协议丢失、回归 notion 内置工具行为）。
// 策略：保全部 system + 最近对话轮，从最老的对话对开始丢弃中间历史。
function compactMessagesForNotion(messages, charLimit) {
  const LIMIT = charLimit || 160_000;
  let total = 0;
  for (const m of messages) total += String(m && m.content || '').length;
  if (total <= LIMIT) return messages;
  const systems = [];
  const dialog = [];
  for (const m of messages) {
    if (m && m.role === 'system') systems.push(m); else dialog.push(m);
  }
  // 保最近 6 条完整（工具场景最近轮次最重要）
  const keepTail = Math.min(6, dialog.length);
  const tail = dialog.slice(-keepTail);
  const head = dialog.slice(0, dialog.length - keepTail);
  let budget = LIMIT;
  for (const m of systems) budget -= String(m.content || '').length + 50;
  // 第一条 user 消息通常携带任务目标：被裁掉会导致模型丢失任务方向、
  // 重复执行已完成的写入 → 与 tail 同级优先保留（预算紧时从旧消息里省出）
  const firstUser = dialog.find((m) => m && m.role === 'user');
  const firstUserDropped = firstUser && !tail.includes(firstUser);
  if (firstUserDropped) budget -= String(firstUser.content || '').length + 50;
  for (const m of tail) budget -= String(m.content || '').length + 50;
  const keptHead = [];
  if (firstUserDropped) keptHead.push(firstUser);
  const restHead = head.filter((m) => m !== firstUser);
  for (let i = restHead.length - 1; i >= 0; i--) {
    const len = String(restHead[i].content || '').length + 50;
    if (budget - len < 0) break;
    budget -= len;
    keptHead.unshift(restHead[i]);
  }
  const dropped = head.length - (firstUserDropped ? 1 : 0) - (keptHead.length - (firstUserDropped ? 1 : 0));
  if (dropped > 0) {
    keptHead.unshift({ role: 'user', content: `[较早的 ${dropped} 条对话历史已省略以适应上游长度限制]` });
    console.log(`[notion] 输入压缩: ${total} → ~${LIMIT - budget} 字符（丢弃 ${dropped} 条旧消息）`);
  }
  return [...systems, ...keptHead, ...tail];
}

// ─────────────────────────── WorkBuddy 国际版反代 ───────────────────────────
// workbuddy.ai 的 /v2/chat/completions 与 OpenAI SSE 完全兼容，但有三条硬性规则：
//   1) 仅支持 stream:true（非流请求返回 11101）
//   2) messages[0] 必须是 system（否则 11128）
//   3) 无 /models 端点（探测走真实轻量调用）
// 处理策略：上游永远流式；客户端要非流则网关在内存里聚合后再一次性回包。
async function tryWorkbuddyChannel(opts) {
  const { res, body, candidate, ch, isStream, requestedModel, hasMoreCandidates } = opts;
  const t0 = Date.now();
  const timeoutMs = ch.def.timeoutMs || 120_000;
  const displayModel = requestedModel || candidate.upstream;

  // 密文 token 直接判失败：发出去也只会被拒，不如把原因说清楚（省一次往返 + 一次失败计数）
  const wbKeyHint = wbEncryptedKeyHint(ch.def.apiKey);
  if (wbKeyHint) {
    recordFailure(ch, 'workbuddy: ' + wbKeyHint, 'credential');
    return 'workbuddy: ' + wbKeyHint;
  }

  // 规则 2：首条必须 system（不存在则在头部注入）
  const inMsgs = Array.isArray(body.messages) ? body.messages : [];
  const outMsgs = (inMsgs.length && inMsgs[0].role === 'system')
    ? inMsgs
    : [{ role: 'system', content: 'You are a helpful assistant.' }, ...inMsgs];
  // 规则 1：上游强制流式
  const upstreamBody = { ...body, model: candidate.upstream, messages: outMsgs, stream: true };
  const bodyStr = JSON.stringify(upstreamBody);
  const target = joinUrl(ch.def.baseUrl, 'chat/completions');
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.def.apiKey}` };

  // 请求必须走 curl 子进程：该上游对 Node/undici 的 TLS 指纹直接 ECONNRESET（实测），
  // curl（Win Schannel / Linux OpenSSL）可过。代价是 SSE 全量缓冲后再分发——
  // workbuddy 的 deepseek-v4.1-flash 回复快（秒级），可接受。
  const out = await wbCurlRequest('POST', target, headers, bodyStr, timeoutMs, ch.def.proxy);
  if (out.error || !out.body) {
    recordFailure(ch, 'workbuddy curl: ' + (out.error || 'empty body'));
    return 'workbuddy curl: ' + (out.error || 'empty body');
  }
  const sseText = out.body;

  // JSON 错误体（{code,msg}）或 4xx：按原样回传 + 记录
  if (sseText.trim().startsWith('{') || (out.status && out.status >= 400)) {
    const j = safeJson(sseText);
    const msg = (j && (j.msg || (j.error && j.error.message))) || sseText.slice(0, 160);
    // 额度/频率用尽（429 code 6004）：按 rate_limit 记，并把冷却精确对齐上游给的重置时刻
    // （文案里就有 "reset at … UTC+8"；照曲线猜会在额度回血后继续空等）
    const limited = wbQuotaLimited(msg) || out.status === 429;
    const resetMs = wbQuotaResetMs(msg) || wbQuotaResetMs(sseText);
    recordFailure(ch, `workbuddy ${out.status}${limited ? '（额度/频率已用尽）' : ''}: ` + msg,
      limited ? 'rate_limit' : failureKindFromStatus(out.status), resetMs ? { retryAfterMs: resetMs } : {});
    if (shouldPassThrough4xx(out.status, opts.hasMoreCandidates)) {
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(sseText);
      return 'fatal_client';
    }
    if (out.status >= 400 && out.status < 500) return 'channel_error';   // 4xx：切下家，同渠道不重试
    return `workbuddy ${out.status}: ${msg}`;
  }
  if (!/^data:/m.test(sseText)) {
    const opaque = wbOpaqueBodyMsg(out.status, sseText);
    recordFailure(ch, 'workbuddy: ' + opaque);
    return 'workbuddy: ' + opaque;
  }

  // 成功
  ch.consecutiveFail = 0;
  ch.probation = false;
  ch.cooldownUntil = 0;
  ch.lastError = null;
  if (ch.status === 'down' || ch.status === 'unknown') ch.status = 'ok';
  ch.latencyMs = Date.now() - t0;

  const respId = 'chatcmpl-wb-' + Date.now().toString(36);
  let fullText = '';
  let usageOut = null;
  let lastFinish = 'stop';
  // SSE 全量文本逐行解析（data 块可能同帧粘连，按 \n 切即可）
  const sseLines = [];
  for (const ln of sseText.split('\n')) {
    const s = ln.trim();
    if (!s.startsWith('data:')) continue;
    sseLines.push(s);
    const d = s.slice(5).trim();
    if (d === '[DONE]') continue;
    try {
      const j = JSON.parse(d);
      const delta = j.choices?.[0]?.delta?.content || '';
      if (delta) fullText += delta;
      if (j.usage) usageOut = j.usage;
      const fr = j.choices?.[0]?.finish_reason;
      if (fr) lastFinish = fr;
    } catch {}
  }
  if (!sseLines.length) {
    recordFailure(ch, 'workbuddy stream: empty');
    return 'stream empty';
  }

  if (isStream) {
    // workbuddy 就是 OpenAI SSE 格式：通用路径直接转发；anthropic 入口经 onStreamChunk 转换
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-ZZCSAPI-Channel': candidate.channelId,
    });
    for (const s of sseLines) {
      if (opts.onStreamChunk) { const o = opts.onStreamChunk(s + '\n', candidate); if (o) res.write(o); }
      else res.write(s + '\n\n');
    }
    res.end();
    recordUsage({
      model: displayModel, channelId: candidate.channelId, kind: opts.kind,
      inputTokens: estimateTokens(messagesText(body && body.messages)),
      outputTokens: estimateTokens(fullText), ok: true, latencyMs: Date.now() - t0, realUsage: usageOut,
    });
    return 'success';
  }

  // 非流式：拼成 OpenAI chat.completion 一次性回包
  if (!fullText.trim()) {
    recordFailure(ch, 'workbuddy stream: empty content');
    return 'stream empty content';
  }
  const assembled = {
    id: respId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: displayModel,
    choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: lastFinish || 'stop' }],
    usage: usageOut || { prompt_tokens: estimateTokens(messagesText(body && body.messages)), completion_tokens: estimateTokens(fullText), total_tokens: 0 },
  };
  if (!usageOut) assembled.usage.total_tokens = assembled.usage.prompt_tokens + assembled.usage.completion_tokens;
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-ZZCSAPI-Channel': candidate.channelId });
  res.end(JSON.stringify(assembled));
  recordUsage({
    model: displayModel, channelId: candidate.channelId, kind: opts.kind,
    inputTokens: assembled.usage.prompt_tokens,
    outputTokens: assembled.usage.completion_tokens, ok: true, latencyMs: Date.now() - t0, realUsage: usageOut,
  });
  return 'success';
}

// ─────────────────────────── Genspark 网页会话渠道 ───────────────────────────
// 参考社区项目 genspark2api（github.com/xinxinshuhao-create/genspark2api）的网页端实测协议。
// 链路：curl 子进程 + def.proxy（必须走 VPN/Clash——直连中国 IP 被 Genspark cn_code
//       验证码门拦、.NET/undici TLS 被 CF 挑战；容器内代理填 http://host.docker.internal:7897）
// 鉴权：Cookie: session_id=<apiKey>（实测单 session_id 即可；也兼容整段 cookie 串）
// 端点：POST {baseUrl}/api/agent/ask_proxy（SSE：message_field_delta 增量 /
//       message_field 全量快照 / message_result 终态，内含 _llm_usage 真实 token）
// 额度：免费号 1 credit/请求、100/天、6 req/min、60/小时 → 建议低 priority 链尾兜底
// 局限（v1.14 已整改「工具调用不可用」）：上游**忽略**原生 tools 参数（genspark2api 实测静默忽略），
//       所以工具走**文本仿真**（与 notion / notion-agent 同套路）：
//         ① 请求侧：toolEmu.emulateRequest 把 tools 协议注入消息、把历史 tool_calls / tool 结果渲染成文本；
//            ⚠ 网页会话只认 user/assistant 两种角色 → gensparkMessagesFor 把 system 折进第一条 user
//            （否则客户端与仿真注入的 system 都会被上游丢掉，工具协议根本到不了模型）；
//         ② 响应侧：回复文本里的 [TOOL_CALL]{…}[/TOOL_CALL] 解析回真 tool_calls（流式与非流式都发）。
//       仅挂 OpenAI 入口（/v1/chat/completions），anthropic/gemini 入口不挂（流转换不支持）
// （GENSPARK_UA / GENSPARK_REFERER / crypto 声明在文件顶部，防 TDZ）

function gensparkCookie(def) {
  const k = String(def.apiKey || '').trim();
  if (!k) return '';
  if (k.includes(';')) return k; // 整段 cookie 串
  if (k.startsWith('session_id=')) return k + '; agree_terms=1; gslogin=1';
  return `session_id=${k}; agree_terms=1; gslogin=1`;
}

function gensparkHeaders(def) {
  const n1 = crypto.randomUUID().replace(/-/g, '');
  const n2 = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return {
    'User-Agent': GENSPARK_UA,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Origin': 'https://www.genspark.ai',
    'Referer': GENSPARK_REFERER,
    'request-id': `|${n1}.${n2}`,
    'traceparent': `00-${n1}-${n2}-01`,
    'Cookie': gensparkCookie(def),
  };
}

// 网页会话只认 user/assistant：把 system 折进第一条 user（Web 端没有 system 概念，
// 原样传 system 会被忽略 → 工具协议、角色设定都到不了模型）。找不到 user 就补一条。
function gensparkMessagesFor(messages) {
  const src = Array.isArray(messages) ? messages : [];
  const out = [];
  const sysTexts = [];
  const textOf = (c) => (typeof c === 'string' ? c
    : Array.isArray(c) ? c.map((p) => (p && (typeof p === 'string' ? p : p.text)) || '').filter(Boolean).join('\n') : '');
  for (const m of src) {
    if (!m) continue;
    if (m.role === 'system') { const t = textOf(m.content).trim(); if (t) sysTexts.push(t); continue; }
    out.push(m);
  }
  if (!sysTexts.length) return out;
  const merged = sysTexts.join('\n\n');
  const i = out.findIndex((m) => m.role === 'user');
  if (i >= 0) out[i] = { ...out[i], content: merged + '\n\n' + textOf(out[i].content) };
  else out.unshift({ role: 'user', content: merged });
  return out;
}

function gensparkBuildPayload(upstreamModel, messages) {
  return {
    ai_chat_model: upstreamModel,
    ai_chat_enable_search: false,
    ai_chat_disable_personalization: false,
    use_moa_proxy: false,
    moa_models: [],
    writingContent: null,
    sas_ask_origin: 'typed',
    type: 'ai_chat',
    is_private: true,
    messages: (messages || []).map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
    })),
  };
}

// SSE 聚合解析 → {fullText, finalContent, usage, error, notLogin, rateLimited, placeholder, sawData}
function gensparkParseSSE(sseText) {
  const st = { fullText: '', finalContent: '', usage: null, error: '', notLogin: false, rateLimited: false, placeholder: false, sawData: false };
  for (const ln of String(sseText || '').split('\n')) {
    const s = ln.trim();
    if (!s.startsWith('data:')) continue;
    const d = s.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    const j = safeJson(d);
    if (!j) continue;
    st.sawData = true;
    if (j.type === 'message_field_delta' && j.field_name === 'content' && typeof j.delta === 'string') st.fullText += j.delta;
    else if (j.type === 'message_field' && j.field_name === 'content' && typeof j.field_value === 'string') st.finalContent = j.field_value;
    else if (j.type === 'message_result' && j.message) {
      if (typeof j.message.content === 'string' && j.message.content) st.finalContent = j.message.content;
      const su = j.message.session_state && j.message.session_state._llm_usage;
      if (su && Number.isFinite(su.prompt_tokens)) st.usage = { prompt_tokens: su.prompt_tokens || 0, completion_tokens: su.completion_tokens || 0, total_tokens: su.total_tokens || 0 };
    } else if (j.type === 'error') {
      st.error = String(j.message || j.error || 'upstream error');
    }
  }
  const finalText = st.finalContent || st.fullText;
  if (/not login/i.test(finalText)) st.notLogin = true;
  if (/rate limit|too quickly|积分已用完/i.test(finalText)) st.rateLimited = true;
  if (/sorry,? i (couldn'?t|could not) produce a response|i (couldn'?t|could not) generate a response|something went wrong/i.test(finalText)) st.placeholder = true;
  return st;
}

// ask_proxy 请求（curl + proxy，body 走临时文件避开转义问题）
async function gensparkAsk(def, bodyStr, timeoutMs) {
  if (!def.proxy) return { status: 0, body: '', error: 'genspark: 渠道未配置代理（proxy 必填，容器内如 http://host.docker.internal:7897；直连会被 cn_code 门/CF 拦截）' };
  return await wbCurlRequest('POST', joinUrl(def.baseUrl, '/api/agent/ask_proxy'), gensparkHeaders(def), bodyStr, timeoutMs, def.proxy);
}

// is_login 探测（免费）：{ok, email} | {ok:false, error, status}
async function gensparkIsLogin(def, timeoutMs) {
  if (!def.proxy) return { ok: false, error: 'proxy 必填（容器内如 http://host.docker.internal:7897；宿主机直跑填 http://127.0.0.1:7897）', status: 0 };
  const out = await wbCurlRequest('GET', joinUrl(def.baseUrl, '/api/is_login'), {
    'User-Agent': GENSPARK_UA, 'Accept': 'application/json', 'Referer': 'https://www.genspark.ai/',
    'Cookie': gensparkCookie(def),
  }, null, timeoutMs || 12000, def.proxy);
  if (out.error || !out.body) return { ok: false, error: out.error || `HTTP ${out.status || 0}`, status: out.status || 0 };
  const j = safeJson(out.body);
  if (!j) return { ok: false, error: '非 JSON 响应（疑似 cn_code 验证码门或 CF 拦截，检查代理出口）: ' + out.body.slice(0, 80), status: out.status || 0 };
  if (j.status === 0 && j.data && j.data.is_login) {
    const email = String(j.data.cogen_email || '');
    return { ok: true, email: email ? email.replace(/^(.{3}).*?(@.*)$/, '$1***$2') : undefined };
  }
  if (j.data && j.data.is_login === false) return { ok: false, error: 'session_id 失效（is_login:false）——重新导出网页会话 cookie 后更新渠道 apiKey', status: 401 };
  return { ok: false, error: (j.message || out.body.slice(0, 100)), status: out.status || 0 };
}

async function tryGensparkChannel(opts) {
  const { res, body, candidate, ch, isStream, requestedModel, kind } = opts;
  const t0 = Date.now();
  const timeoutMs = ch.def.timeoutMs || 180_000;
  const displayModel = requestedModel || candidate.upstream;

  // 工具仿真（请求侧）：上游忽略原生 tools → 协议注入消息 + 历史工具消息渲染成文本，
  // 并统一折掉 system 角色（网页会话只认 user/assistant，见 gensparkMessagesFor）
  const toolEmuReq = toolEmu.emulateRequest(body);
  const outMessages = gensparkMessagesFor(toolEmuReq ? toolEmuReq.messages : (body.messages || []));
  const payload = gensparkBuildPayload(candidate.upstream, outMessages);
  const out = await gensparkAsk(ch.def, JSON.stringify(payload), timeoutMs);
  if (out.error || !out.body) {
    recordFailure(ch, 'genspark curl: ' + (out.error || 'empty body'));
    return 'genspark curl: ' + (out.error || 'empty body');
  }
  const raw = out.body;
  if (out.status >= 400) {
    const j = safeJson(raw);
    const msg = (j && (j.message || (j.error && j.error.message))) || raw.slice(0, 160);
    recordFailure(ch, `genspark HTTP ${out.status}: ${String(msg).slice(0, 160)}`, failureKindFromStatus(out.status), {
      retryAfterMs: retryAfterMsFromHeaders(out.headers),
    });
    // 400/422 等请求错误：只在没有后续候选时才透传（见 shouldPassThrough4xx）；
    // 401/403 会话或出口问题、404 该渠道没有此内容 → 切下一候选
    if (shouldPassThrough4xx(out.status, opts.hasMoreCandidates)) {
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(raw);
      return 'fatal_client';
    }
    // 401/403 会话或出口问题由 failureKindFromStatus 归为凭证类（起步 5 分钟），不再手工加 300 秒
    if (out.status >= 400 && out.status < 500) return 'channel_error';   // 4xx：切下家，同渠道不重试
    return `genspark ${out.status}: ${String(msg).slice(0, 120)}`;
  }
  if (!/^data:/m.test(raw)) {
    recordFailure(ch, 'genspark: non-SSE response（疑似 cn_code 门/CF 挑战页，检查代理出口 IP）: ' + raw.slice(0, 120));
    return 'genspark: non-SSE response';
  }
  const st = gensparkParseSSE(raw);
  if (st.error && !st.finalContent && !st.fullText) {
    recordFailure(ch, 'genspark stream: ' + st.error);
    return 'genspark stream: ' + st.error;
  }
  if (st.notLogin) {
    recordFailure(ch, 'genspark: session 失效（not login）', 'credential');   // 凭证类：起步 5 分钟
    return 'genspark: not login (session expired)';
  }
  if (st.rateLimited) {
    // 上游明确限流 → 沿用一小时（retryAfterMs 优先于曲线，但受 hardMaxMs 硬上限约束）
    recordFailure(ch, 'genspark: 限流（rate limit / too quickly / 积分已用完）', 'rate_limit', { retryAfterMs: 3600_000 });
    return 'genspark: rate limited (cooldown 1h)';
  }
  const replyText = (st.finalContent || st.fullText || '').trim();
  if (!replyText || st.placeholder) {
    recordFailure(ch, st.placeholder ? 'genspark: 上游占位符回复（' + replyText.slice(0, 60) + '）' : 'genspark: 空回复');
    return st.placeholder ? 'genspark: upstream placeholder reply' : 'genspark: empty reply';
  }

  // 工具仿真（响应侧）：模型按注入的协议回了 [TOOL_CALL] 标记 → 解析回真 tool_calls。
  // 解析不出就照旧当纯文本（绝不因为"有 tools"就把普通回复吃掉）。
  let replyTools = null, replyOut = replyText;
  if (toolEmuReq) {
    const parsed = toolEmu.parseEmulatedToolCalls(replyText);
    if (parsed && parsed.calls.length) { replyTools = parsed.calls; replyOut = parsed.text || ''; }
  }

  // 成功
  ch.consecutiveFail = 0;
  ch.probation = false;
  ch.cooldownUntil = 0;
  ch.lastError = null;
  if (ch.status === 'down' || ch.status === 'unknown') ch.status = 'ok';
  ch.latencyMs = Date.now() - t0;

  const respId = 'chatcmpl-gs-' + Date.now().toString(36);
  const inTok = st.usage ? st.usage.prompt_tokens : estimateTokens(messagesText(body && body.messages));
  const outTok = st.usage ? st.usage.completion_tokens : estimateTokens(replyOut || replyText);

  if (isStream) {
    // curl 已全量缓冲 → 把聚合文本按 OpenAI SSE 重新吐出（与 workbuddy 同思路）
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-ZZCSAPI-Channel': candidate.channelId,
    });
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: displayModel, choices: [{ index: 0, delta, finish_reason: finish || null }] })}\n\n`;
    if (replyTools) {
      // 工具调用：delta.tool_calls + finish_reason=tool_calls（客户端据此进入工具回合）
      res.write(chunk({
        role: 'assistant', content: replyOut ? replyOut : null,
        tool_calls: replyTools.map((c, i) => ({
          index: i, id: toolEmu.toolCallId() + '_' + i, type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
        })),
      }));
      if (st.usage) res.write(`data: ${JSON.stringify({ id: respId, object: 'chat.completion.chunk', model: displayModel, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: st.usage })}\n\n`);
      else res.write(chunk({}, 'tool_calls'));
    } else {
      res.write(chunk({ role: 'assistant', content: '' }));
      res.write(chunk({ content: replyText }));
      if (st.usage) res.write(`data: ${JSON.stringify({ id: respId, object: 'chat.completion.chunk', model: displayModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: st.usage })}\n\n`);
      else res.write(chunk({}, 'stop'));
    }
    res.write('data: [DONE]\n\n');
    res.end();
    recordUsage({ model: displayModel, channelId: candidate.channelId, kind, inputTokens: inTok, outputTokens: outTok, ok: true, latencyMs: Date.now() - t0, realUsage: st.usage });
    return 'success';
  }

  // 非流式：有工具调用就回 tool_calls 报文（usage 一并带上，积分/用量照实记）
  if (replyTools) {
    const usage = st.usage || { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok };
    const payloadOut = toolEmu.openaiToolCallsPayload(respId, displayModel, replyTools, replyOut || null);
    payloadOut.usage = usage;
    recordUsage({ model: displayModel, channelId: candidate.channelId, kind, inputTokens: inTok, outputTokens: outTok, ok: true, latencyMs: Date.now() - t0, realUsage: st.usage });
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-ZZCSAPI-Channel': candidate.channelId });
    res.end(JSON.stringify(payloadOut));
    return 'success';
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'X-ZZCSAPI-Channel': candidate.channelId });
  res.end(JSON.stringify({
    id: respId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: displayModel,
    choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
    usage: st.usage || { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  }));
  recordUsage({ model: displayModel, channelId: candidate.channelId, kind, inputTokens: inTok, outputTokens: outTok, ok: true, latencyMs: Date.now() - t0, realUsage: st.usage });
  return 'success';
}

// ─────────────────── Codex（ChatGPT 官方订阅反代，sub2api 同款）───────────────────
// 链路：refresh_token →(auth.openai.com/oauth/token)→ access_token(约1h) + 新 RT
//       → chatgpt.com/backend-api/codex/responses（Responses API，SSE）
// 特性：
//   1) RT 一次性轮转——每次刷新若返回新 RT 必须写回 config 持久化，否则渠道报废
//   2) 区域限制 + TLS 指纹 → 全程 curl 子进程 + def.proxy（如 http://host.docker.internal:7897）
//   3) 无 /models 探测——模型走 def.models 别名映射，探测 = 一次令牌刷新
// 注意：以下常量必须在使用它们的函数（probeChannel 等）被执行前完成初始化，
// 但 const 存在 TDZ——若本常量块位于启动探测路径之后，启动即报
// "Cannot access before initialization"。故保持此块在文件中的位置不得后移。

function codexJwtPayload(t) {
  try {
    const p = String(t).split('.');
    if (p.length < 2) return null;
    const b = p[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
  } catch { return null; }
}

// 从各种导入 JSON 里取出带 access_token/refresh_token 的那层对象。
// 兼容：扁平对象、{credentials:{…}}、sub2api {accounts:[{credentials:{…}}]}（取第一个可用账号）
function pickCodexCreds(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const hasTok = (o) => o && (o.access_token || o.refresh_token);
  if (hasTok(obj)) return obj;
  if (hasTok(obj.credentials)) return obj.credentials;
  // 账号数组：优先挑没被禁用的、AT 还没过期的
  const list = Array.isArray(obj.accounts) ? obj.accounts : (Array.isArray(obj.data) ? obj.data : null);
  if (list) {
    const cands = list.map((a) => (a && a.credentials) || a).filter(hasTok);
    if (cands.length) {
      const live = cands.find((c) => {
        const p = codexJwtPayload(c.access_token || '');
        return !c.disabled && (!p || !p.exp || p.exp * 1000 > Date.now());
      });
      return live || cands[0];
    }
  }
  return null;
}

// 找下一个没被占用的 codex 渠道 id（批量导入多账号时不能撞名）
function nextCodexChannelId() {
  for (let i = 1; i < 1000; i++) {
    const id = 'codex' + i;
    if (!channels.has(id)) return id;
  }
  return 'codex' + Date.now().toString(36);
}

// 确保有可用 access_token：内存缓存 → def 里持久化的 AT（sub2api JSON 导入，10天有效）→ RT 刷新
async function codexEnsureToken(ch) {
  const now = Date.now();
  if (ch.codex && ch.codex.accessToken && ch.codex.expiresAt > now + 60_000) return ch.codex;
  // 持久化的 AT（JSON 导入路径）：sub2api 模式——AT 优先，RT 只在 AT 快过期时才动
  if (ch.def.accessToken && Number(ch.def.expiresAt) > now + 60_000) {
    ch.codex = { accessToken: ch.def.accessToken, accountId: ch.def.accountId || '', email: ch.def.email || '', expiresAt: Number(ch.def.expiresAt) };
    return ch.codex;
  }
  const form = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(ch.def.apiKey) + '&client_id=' + CODEX_CLIENT_ID
    + '&scope=' + encodeURIComponent('openid profile email');
  const out = await wbCurlRequest('POST', CODEX_TOKEN_URL, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'originator': 'codex_cli_rs',
    'User-Agent': CODEX_UA,
  }, form, 30_000, ch.def.proxy);
  if (!out.body) { const e = new Error('codex token: ' + (out.error || 'empty')); throw e; }
  const j = safeJson(out.body);
  if (!j || !j.access_token) {
    const code = j && j.error && (j.error.code || j.error.message) || out.body.slice(0, 120);
    const err = new Error('codex token: ' + code);
    err.status = out.status;
    // RT 失效（被轮转/撤销/已被别处消费）→ 致命，等用户换 RT；不要反复重试
    if (/invalid_refresh_token|token_expired|invalid_grant|refresh_token_reused/i.test(String(code))) err.fatal = true;
    throw err;
  }
  const payload = codexJwtPayload(j.id_token) || codexJwtPayload(j.access_token) || {};
  const authClaim = payload['https://api.openai.com/auth'] || {};
  const accountId = authClaim.chatgpt_account_id || payload.chatgpt_account_id || '';
  // RT 轮转：OpenAI 刷新时会返回新 RT，旧 RT 立即作废——必须写回持久化
  if (j.refresh_token && j.refresh_token !== ch.def.apiKey) {
    ch.def.apiKey = j.refresh_token;
    console.log(`[codex] ${ch.def.id} RT 已轮转，新值已写回 config`);
  }
  const atPayload = codexJwtPayload(j.access_token) || {};
  const atExpMs = atPayload.exp ? atPayload.exp * 1000 : now + (Number(j.expires_in) || 3600) * 1000;
  ch.codex = {
    accessToken: j.access_token,
    accountId,
    email: payload.email || '',
    expiresAt: atExpMs,
  };
  // 持久化新 AT（10 天有效期，重启容器不用重新刷 RT，减少和别人打架的窗口）
  ch.def.accessToken = j.access_token;
  ch.def.accountId = accountId;
  ch.def.email = payload.email || ch.def.email || '';
  ch.def.expiresAt = atExpMs;
  persistConfig();
  return ch.codex;
}

// 拉取订阅可用模型列表（codex CLI 同款端点；client_version 必须 ≥0.146.0 否则返回空列表）
async function codexFetchModels(def, acct, timeoutMs) {
  const headers = {
    'Authorization': `Bearer ${acct.accessToken}`,
    'OpenAI-Beta': 'responses=experimental',
    'originator': 'codex_cli_rs',
    'version': CODEX_VERSION,
    'User-Agent': CODEX_UA,
  };
  if (acct.accountId) headers['chatgpt-account-id'] = acct.accountId;
  const url = (def.baseUrl || CODEX_DEFAULT_BASE) + '/models?client_version=' + CODEX_VERSION;
  const out = await wbCurlRequest('GET', url, headers, null, timeoutMs || 15000, def.proxy);
  if (!out.body) return [];
  const j = safeJson(out.body);
  if (!j) return [];
  const arr = Array.isArray(j) ? j : (j.models || j.data || []);
  return arr.map((m) => m && (m.slug || m.id || m.name)).filter(Boolean);
}

// 查配额（sub2api 同款 /wham/usage；注意这个端点的身份头与推理面不同：originator=Codex Desktop, beta=codex-1）
// 返回归一化形状：{ email, planType, primary5h: {usedPercent, resetAfterSec, resetAt}|null, secondary7d: {...}|null, limitReached, reason, rawWindows }
async function codexFetchQuota(ch, timeoutMs) {
  const acct = await codexEnsureToken(ch);
  const headers = {
    'Authorization': `Bearer ${acct.accessToken}`,
    'openai-beta': 'codex-1',
    'oai-language': 'zh-CN',
    'originator': 'Codex Desktop',
    'accept': 'application/json',
  };
  if (acct.accountId) headers['chatgpt-account-id'] = acct.accountId;
  const out = await wbCurlRequest('GET', 'https://chatgpt.com/backend-api/wham/usage', headers, null, timeoutMs || 20000, ch.def.proxy);
  if (!out.body) throw new Error('codex quota: ' + (out.error || 'empty'));
  const j = safeJson(out.body);
  if (!j) throw new Error('codex quota: bad json (HTTP ' + out.status + ')');
  if (j.error) throw new Error('codex quota: ' + (j.error.message || j.error.code || 'unknown'));
  const rl = j.rate_limit || {};
  const win = (w) => w ? {
    usedPercent: Number(w.used_percent) || 0,
    windowSec: Number(w.limit_window_seconds) || 0,
    resetAfterSec: Number(w.reset_after_seconds) || 0,
    resetAt: Number(w.reset_at) || 0,
  } : null;
  const primary = win(rl.primary_window);
  const secondary = win(rl.secondary_window);
  // 按窗口大小归类 5h/7d（sub2api Normalize 同款逻辑：小窗口=5h，大窗口=7d）
  let primary5h = null, secondary7d = null;
  if (primary && secondary) {
    if (primary.windowSec <= secondary.windowSec) { primary5h = primary; secondary7d = secondary; }
    else { primary5h = secondary; secondary7d = primary; }
  } else if (primary) {
    if (primary.windowSec <= 21600) primary5h = primary; else secondary7d = primary;
  } else if (secondary) {
    if (secondary.windowSec <= 21600) primary5h = secondary; else secondary7d = secondary;
  }
  return {
    email: j.email || ch.def.email || '',
    planType: j.plan_type || '',
    limitReached: !!rl.limit_reached,
    reason: (j.rate_limit_reached_type && j.rate_limit_reached_type.type) || '',
    primary5h, secondary7d,
    credits: j.credits ? { hasCredits: !!j.credits.has_credits, unlimited: !!j.credits.unlimited } : null,
    fetchedAt: Date.now(),
  };
}

// chat.completions messages → Responses API { instructions, input }
function codexBuildInput(messages) {
  const instructions = [];
  const input = [];
  for (const m of messages || []) {
    const text = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((p) => (p && p.text) || '').join('')
      : String(m.content || '');
    if (m.role === 'system' || m.role === 'developer') { if (text.trim()) instructions.push(text); continue; }
    if (m.role === 'user') input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
    else if (m.role === 'assistant') input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  }
  return { instructions: instructions.join('\n') || 'You are a helpful assistant.', input };
}

// 调 codex /responses，返回 { ok, status, text(SSE全量), error }
async function codexCallResponses(ch, model, messages, timeoutMs) {
  const acct = await codexEnsureToken(ch);
  const { instructions, input } = codexBuildInput(messages);
  const upstreamBody = { model, instructions, input, store: false, stream: true };
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Authorization': `Bearer ${acct.accessToken}`,
    'OpenAI-Beta': 'responses=experimental',
    'originator': 'codex_cli_rs',
    'version': CODEX_VERSION,
    'session_id': require('crypto').randomUUID(),
    'User-Agent': CODEX_UA,
  };
  if (acct.accountId) headers['chatgpt-account-id'] = acct.accountId;
  const target = joinUrl(ch.def.baseUrl || CODEX_DEFAULT_BASE, 'responses');
  const out = await wbCurlRequest('POST', target, headers, JSON.stringify(upstreamBody), timeoutMs, ch.def.proxy);
  if (out.error || !out.body) return { ok: false, status: out.status || 0, error: 'codex curl: ' + (out.error || 'empty') };
  const text = out.body;
  if (text.trim().startsWith('{') || (out.status && out.status >= 400)) {
    const j = safeJson(text);
    const msg = (j && j.error && (j.error.message || j.error.code)) || (j && j.msg) || text.slice(0, 160);
    return { ok: false, status: out.status || 200, error: String(msg), raw: text };
  }
  if (!/^data:/m.test(text)) return { ok: false, status: out.status || 200, error: 'codex: non-SSE response' };
  return { ok: true, status: 200, text };
}

// 解析 Responses API SSE 全量文本 → { fullText, usage, errMsg }
function codexParseSSE(text) {
  let fullText = ''; let usage = null; let errMsg = '';
  for (const ln of String(text).split('\n')) {
    const s = ln.trim();
    if (!s.startsWith('data:')) continue;
    const d = s.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    let j; try { j = JSON.parse(d); } catch { continue; }
    const t = j.type || '';
    if (t === 'response.output_text.delta') { if (j.delta) fullText += j.delta; }
    else if (t === 'response.completed' || t === 'response.incomplete') {
      const u = j.response && j.response.usage;
      if (u) usage = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0) };
    } else if (t === 'response.failed' || t === 'error') {
      errMsg = (j.response && j.response.error && j.response.error.message) || j.message || t;
    }
  }
  return { fullText, usage, errMsg };
}

async function tryCodexChannel(opts) {
  const { res, body, candidate, ch, isStream, requestedModel } = opts;
  const t0 = Date.now();
  const timeoutMs = ch.def.timeoutMs || 180_000;
  const displayModel = requestedModel || candidate.upstream;

  let call;
  try {
    call = await codexCallResponses(ch, candidate.upstream, body.messages, timeoutMs);
  } catch (err) {
    recordFailure(ch, String(err.message || err), err.fatal ? 'credential' : undefined);
    if (err.fatal) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } }));
      return 'fatal_client';
    }
    return err.message || 'codex token error';
  }
  if (!call.ok) {
    recordFailure(ch, 'codex ' + call.status + ': ' + call.error, failureKindFromStatus(call.status));
    if (call.raw && shouldPassThrough4xx(call.status, opts.hasMoreCandidates)) {
      res.writeHead(call.status, { 'Content-Type': 'application/json' });
      res.end(call.raw);
      return 'fatal_client';
    }
    if (call.status >= 400 && call.status < 500) return 'channel_error';   // 4xx：切下家，同渠道不重试
    return 'codex ' + call.status + ': ' + call.error;
  }

  const { fullText, usage: usageOut, errMsg } = codexParseSSE(call.text);
  if (errMsg && !fullText) {
    recordFailure(ch, 'codex stream: ' + errMsg);
    return 'codex stream: ' + errMsg;
  }
  if (!fullText.trim()) {
    recordFailure(ch, 'codex stream: empty content');
    return 'codex stream: empty content';
  }

  ch.consecutiveFail = 0;
  ch.probation = false;
  ch.cooldownUntil = 0;
  ch.lastError = null;
  if (ch.status === 'down' || ch.status === 'unknown') ch.status = 'ok';
  ch.latencyMs = Date.now() - t0;

  const respId = 'chatcmpl-codex-' + Date.now().toString(36);
  const created = Math.floor(Date.now() / 1000);

  if (isStream) {
    // 重放为 OpenAI chunk（role → content → finish → [DONE]）；anthropic 入口经 onStreamChunk 转换
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-ZZCSAPI-Channel': candidate.channelId,
    });
    const mk = (delta, fr) => 'data: ' + JSON.stringify({ id: respId, object: 'chat.completion.chunk', created, model: displayModel, choices: [{ index: 0, delta, finish_reason: fr || null }] }) + '\n';
    const emit = (line) => {
      if (opts.onStreamChunk) { const o = opts.onStreamChunk(line, candidate); if (o) res.write(o); }
      else res.write(line + '\n');
    };
    emit(mk({ role: 'assistant', content: '' }));
    emit(mk({ content: fullText }));
    emit(mk({}, 'stop'));
    emit('data: [DONE]');
    res.end();
  } else {
    const assembled = {
      id: respId,
      object: 'chat.completion',
      created,
      model: displayModel,
      choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
      usage: usageOut || { prompt_tokens: estimateTokens(messagesText(body && body.messages)), completion_tokens: estimateTokens(fullText), total_tokens: 0 },
    };
    if (!usageOut) assembled.usage.total_tokens = assembled.usage.prompt_tokens + assembled.usage.completion_tokens;
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-ZZCSAPI-Channel': candidate.channelId });
    res.end(JSON.stringify(assembled));
  }
  recordUsage({
    model: displayModel, channelId: candidate.channelId, kind: opts.kind,
    inputTokens: usageOut ? usageOut.prompt_tokens : estimateTokens(messagesText(body && body.messages)),
    outputTokens: usageOut ? usageOut.completion_tokens : estimateTokens(fullText),
    ok: true, latencyMs: Date.now() - t0, realUsage: usageOut,
  });
  return 'success';
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
  // 工具仿真：notion 无原生 function calling → tools 注入 system，响应解析围栏
  const toolEmuReq = toolEmu.emulateRequest(body);
  const effMessages = toolEmuReq ? compactMessagesForNotion(toolEmuReq.messages) : compactMessagesForNotion(body.messages);
  const built = notion.buildNotionTranscript(effMessages, candidate.upstream, acct, { useWebSearch: !toolEmuReq });
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
        resp = await zzFetch(target, { method: 'POST', headers, body: bodyStr, signal: ctrl.signal });
      } finally { clearTimeout(to); }
      httpStatus = resp.status;
      if (resp.ok) ndjsonText = await resp.text();
      else {
        const errText = await resp.text().catch(() => '');
        recordFailure(ch, `notion HTTP ${resp.status}: ${errText.slice(0, 200)}`, failureKindFromStatus(resp.status));
        if (shouldPassThrough4xx(resp.status, opts.hasMoreCandidates)) {
          res.writeHead(resp.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Notion upstream HTTP ${resp.status}`, type: 'upstream_error' } }));
          return 'fatal_client';
        }
        if (resp.status >= 400 && resp.status < 500) return 'channel_error';   // 4xx：切下家，同渠道不重试
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
  ch.probation = false;
  ch.cooldownUntil = 0;
  ch.lastError = null;
  if (ch.status === 'down' || ch.status === 'unknown') ch.status = 'ok';
  ch.latencyMs = Date.now() - t0;

  // 真实对话消耗了额度 → 异步刷新用量（免费接口，不阻塞响应，失败静默）
  try {
    notion.notionUsageEligibility(ch.def.baseUrl, ch.def.apiKey, acct, zzFetch, 8000)
      .then((u) => {
        if (ch.notion) ch.notion.usage = { type: u.type, eligible: u.isEligible, userUsage: u.userUsage, userLimit: u.userLimit, at: Date.now() };
      })
      .catch(() => {});
  } catch { /* 不影响主流程 */ }

  // 4) 解析 NDJSON → OpenAI chunk
  const respId = 'chatcmpl-notion-' + Date.now().toString(36);

  if (isStream) {
    // 先解析完（NDJSON 已整体缓冲，不影响首块延迟），判空失败可以让调度器
    // 切其他渠道兜底——而不是给客户端一个 200+空轮次污染会话
    const pendingDeltas = [];
    let pendingToolCalls = null;
    let firstReasoningSent = false;
    const collectDelta = (text) => { if (text) pendingDeltas.push(text); };
    const collectToolCalls = (calls) => { pendingToolCalls = (pendingToolCalls || []).concat(calls); };
    const scanner = toolEmu.createToolStreamScanner(collectDelta, collectToolCalls);
    let fullText = '';
    let reasoningOut = [];
    let finalText = '';
    const parser = notion.createNotionStreamParser((evt) => {
      if (evt.type === 'content') {
        // 工具模式内容同样累计进 fullText：否则"权威全文兜底"会误判流里
        // 没采到内容，把 record-map 全文再发一遍（客户端收到双份文本）
        if (toolEmuReq) { fullText += evt.text; scanner.push(evt.text); }
        else { fullText += evt.text; collectDelta(evt.text); }
      } else if (evt.type === 'thinking') {
        // 工具场景：思考段也可能带工具围栏（模型爱先思考再给调用）→ 也进扫描器
        if (toolEmuReq) scanner.push(evt.text);
        else reasoningOut.push(evt.text);
      } else if (evt.type === 'final') { finalText = evt.text; }
    });
    for (const ln of ndjsonText.split('\n')) parser.line(ln);
    if (toolEmuReq) { scanner.end(); }

    // 权威全文兜底：流里没采到 content → 用 record-map 的 final 补齐
    if (!fullText.trim() && finalText && !pendingToolCalls) {
      if (toolEmuReq) {
        const parsed = toolEmu.parseEmulatedToolCalls(finalText);
        if (parsed && parsed.calls.length) { collectToolCalls(parsed.calls); }
        else { collectDelta(finalText); fullText = finalText; }
      } else { collectDelta(finalText); fullText = finalText; }
    }

    // 空输出判定：上游 200 但无任何内容（额度窗口耗尽的典型表现）→ 渠道失败
    const toolsEmitted = !!pendingToolCalls;
    if (!fullText.trim() && !finalText.trim() && !reasoningOut.length && !toolsEmitted) {
      recordFailure(ch, 'notion stream: 200 但无内容（可能是 AI 额度窗口耗尽或上游降级）');
      return 'notion empty output (quota/degraded)';
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-ZZCSAPI-Channel': candidate.channelId,
    });
    // thinking 直通（无工具场景）
    if (!toolEmuReq && reasoningOut.length) {
      res.write(notionSSEChunk(respId, displayModel, { role: 'assistant', content: '' }));
      for (const t of reasoningOut) res.write(notionSSEChunk(respId, displayModel, { reasoning_content: t }));
      firstReasoningSent = true;
    }
    // 重放缓冲的增量
    let firstChunkSent = firstReasoningSent;
    for (const d of pendingDeltas) {
      if (!firstChunkSent) { firstChunkSent = true; res.write(notionSSEChunk(respId, displayModel, { role: 'assistant', content: '' })); }
      res.write(notionSSEChunk(respId, displayModel, { content: d }));
    }
    if (toolsEmitted) {
      firstChunkSent = true;
      res.write(notionSSEChunk(respId, displayModel, {
        role: 'assistant', content: null,
        tool_calls: pendingToolCalls.map((c, i) => ({
          index: i, id: toolEmu.toolCallId() + '_' + i, type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
        })),
      }));
    }
    // 收尾 chunk
    res.write(notionSSEChunk(respId, displayModel, {}));
    res.write(`data: ${JSON.stringify({ id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: displayModel, choices: [{ index: 0, delta: {}, finish_reason: toolsEmitted ? 'tool_calls' : 'stop' }] })}\n\n`);
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
  // 空输出判定：上游 200 但无任何内容（额度窗口耗尽/降级）→ 渠道失败切兜底
  if (!contentText.trim() && !reasoningText.trim() && !finalText.trim()) {
    recordFailure(ch, 'notion: 200 但无内容（可能是 AI 额度窗口耗尽或上游降级）');
    return 'notion empty output (quota/degraded)';
  }
  let reply = contentText.trim() ? contentText : (finalText || '');

  // 内容分裂兜底：模型把答案主体吐进 thinking 段（gpt-6-astra 工具场景常见）→
  // content 空/过短而 thinking 充实时，把 thinking 并入回复
  let mergedReasoning = false;
  if (reasoningText.trim() && (!reply.trim() || reply.replace(/\s/g, '').length * 5 < reasoningText.replace(/\s/g, '').length)) {
    reply = (reply ? reply + '\n\n' : '') + reasoningText;
    mergedReasoning = true;
  }

  // 工具仿真：非流式先试解析围栏
  if (toolEmuReq) {
    const parsed = toolEmu.parseEmulatedToolCalls(reply);
    if (parsed && parsed.calls.length) {
      const inTok = estimateTokens(messagesText(body.messages));
      recordUsage({ model: displayModel, channelId: candidate.channelId, kind: opts.kind, inputTokens: inTok, outputTokens: estimateTokens(reply), ok: true, latencyMs: Date.now() - t0 });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-ZZCSAPI-Channel': candidate.channelId });
      res.end(JSON.stringify(toolEmu.openaiToolCallsPayload(respId, displayModel, parsed.calls, parsed.text || null)));
      return 'success';
    }
  }
  reply = reply.trim();
  const inTok = estimateTokens(messagesText(body.messages));
  const outTok = estimateTokens(reply + (mergedReasoning ? '' : (reasoningText ? ' ' + reasoningText : '')));
  recordUsage({ model: displayModel, channelId: candidate.channelId, kind: opts.kind, inputTokens: inTok, outputTokens: outTok, ok: true, latencyMs: Date.now() - t0 });
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-ZZCSAPI-Channel': candidate.channelId });
  res.end(JSON.stringify({
    id: respId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: displayModel,
    choices: [{ index: 0, message: { role: 'assistant', content: reply, ...(!mergedReasoning && reasoningText ? { reasoning_content: reasoningText } : {}) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  }));
  return 'success';
}

// ─────────────────────────── Notion 官方 Agent API 渠道执行 ───────────────────────────
// 会话式：POST /v1/sessions 创建（message + prompt_context）→ 轮询 → 事件读回复。
// 工具仿真：tools 协议注入 system（emulateRequest）→ 回复文本解析 [TOOL_CALL] 标记。
// 智能体的"确认门"（requires_action）自动 approve（最多 5 次），让工作区操作不断流。
async function tryNotionAgentChannel(opts) {
  const { res, body, candidate, ch, isStream, requestedModel } = opts;
  const t0 = Date.now();
  const timeoutMs = ch.def.timeoutMs || 180_000;
  const displayModel = requestedModel || candidate.upstream;
  const base = (ch.def.baseUrl || 'https://api.notion.com').replace(/\/+$/, '');
  const token = ch.def.apiKey;

  // 1) 智能体名 → ID（渠道运行态缓存；404 会触发调度器切别的渠道）
  ch.agentMap = ch.agentMap || new Map();
  const cacheKey = String(candidate.upstream).trim().toLowerCase();
  let agentId;
  if (ch.agentMap.has(cacheKey)) agentId = ch.agentMap.get(cacheKey);
  else {
    try {
      agentId = await notionAgent.resolveAgentId(base, token, candidate.upstream, zzFetch, 20000);
      ch.agentMap.set(cacheKey, agentId);
    } catch (err) {
      recordFailure(ch, 'notion-agent: ' + (err.message || err));
      return 'notion-agent: ' + (err.message || err);
    }
  }

  // 2) prompt 组装（工具协议注入 system；历史渲染单条消息文本，超长折叠中间）
  //    官方 API prompt_context 上限 10k 字符：全量工具 JSON schema 装不下 →
  //    composeAgentPrompt 内部改用紧凑协议（名称+描述+参数清单），绝不砍半截定义
  const toolEmuReq = toolEmu.emulateRequest(body);
  const srcMessages = toolEmuReq ? toolEmuReq.messages : (body.messages || []);
  const { promptContext, messageText } = notionAgent.composeAgentPrompt(srcMessages, {
    tools: toolEmuReq ? toolEmuReq.tools : undefined,
    toolChoice: body.tool_choice,
  });
  if (!messageText.trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'empty message for agent session', type: 'invalid_request_error' } }));
    return 'fatal_client';
  }

  // 3) 一轮会话（创建→轮询→自动批准→事件读回复）
  let turn;
  try {
    turn = await notionAgent.runAgentTurn({
      baseUrl: base, token, agentId, message: messageText, promptContext,
      fetchFn: zzFetch, timeoutMs: timeoutMs - 20000,
    });
  } catch (err) {
    // CF 间歇性拦截 / 网络异常等 → 渠道失败切兜底（渠道进入指数冷却）
    recordFailure(ch, 'notion-agent: ' + (err.message || err));
    return 'notion-agent: ' + (err.message || err);
  }
  if (!turn.ok) {
    // credits 耗尽（403 workspace_credits_exhausted）：工作区本周期额度用完，不可重试，
    // 明确提示（区别于令牌/权限/CF 拦截，避免误诊为"本地连接断开"）
    if (turn.code === 'workspace_credits_exhausted') {
      recordFailure(ch, 'notion-agent credits 耗尽: ' + String(turn.error || '').slice(0, 100));
      return 'notion-agent credits exhausted (workspace_credits_exhausted)';
    }
    // 401 令牌失效 / 403 其他 / 404 智能体不存在 / 429 限频 → 渠道失败切兜底
    recordFailure(ch, `notion-agent${turn.status ? ' HTTP ' + turn.status : ''}: ${String(turn.error || '').slice(0, 150)}`, failureKindFromStatus(turn.status));
    return `notion-agent ${turn.status || ''}: ${String(turn.error || '').slice(0, 100)}`;
  }

  // 4) 成功：清失败状态
  ch.consecutiveFail = 0;
  ch.probation = false;
  ch.cooldownUntil = 0;
  ch.lastError = null;
  if (ch.status === 'down' || ch.status === 'unknown') ch.status = 'ok';
  ch.latencyMs = Date.now() - t0;

  // 5) 工具仿真解析（有 tools 时协议已注入，模型可能输出 [TOOL_CALL] 标记）
  let reply = turn.text;
  const respId = 'chatcmpl-agent-' + Date.now().toString(36);
  const inTok = estimateTokens(messagesText(body.messages));
  let replyTools = null;
  let replyText = reply;
  if (toolEmuReq) {
    const parsed = toolEmu.parseEmulatedToolCalls(reply);
    if (parsed && parsed.calls.length) { replyTools = parsed.calls; replyText = parsed.text || ''; }
  }

  // 6) 输出（流式一次性重放整段——上游本来就是整轮完成后才有全文）
  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-ZZCSAPI-Channel': candidate.channelId,
    });
    if (replyTools) {
      res.write(notionSSEChunk(respId, displayModel, {
        role: 'assistant', content: null,
        tool_calls: replyTools.map((c, i) => ({
          index: i, id: toolEmu.toolCallId() + '_' + i, type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
        })),
      }));
      res.write(notionSSEChunk(respId, displayModel, {}));
      res.write(`data: ${JSON.stringify({ id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: displayModel, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
      res.write(notionSSEChunk(respId, displayModel, { role: 'assistant', content: '' }));
      res.write(notionSSEChunk(respId, displayModel, { content: replyText }));
      res.write(notionSSEChunk(respId, displayModel, {}));
      res.write(`data: ${JSON.stringify({ id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: displayModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
    recordUsage({ model: displayModel, channelId: candidate.channelId, kind: opts.kind, inputTokens: inTok, outputTokens: estimateTokens(reply), ok: true, latencyMs: Date.now() - t0 });
    return 'success';
  }

  // 非流式
  if (replyTools) {
    recordUsage({ model: displayModel, channelId: candidate.channelId, kind: opts.kind, inputTokens: inTok, outputTokens: estimateTokens(reply), ok: true, latencyMs: Date.now() - t0 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-ZZCSAPI-Channel': candidate.channelId });
    res.end(JSON.stringify(toolEmu.openaiToolCallsPayload(respId, displayModel, replyTools, replyText || null)));
    return 'success';
  }
  const outTok = estimateTokens(replyText);
  recordUsage({ model: displayModel, channelId: candidate.channelId, kind: opts.kind, inputTokens: inTok, outputTokens: outTok, ok: true, latencyMs: Date.now() - t0 });
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-ZZCSAPI-Channel': candidate.channelId });
  res.end(JSON.stringify({
    id: respId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: displayModel,
    choices: [{ index: 0, message: { role: 'assistant', content: replyText.trim() }, finish_reason: 'stop' }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  }));
  return 'success';
}

// 失败记账的唯一入口：连败计数 + 分级退避 + 状态降级 + 用量留痕。
// kind 省略时从 status / 文案推断（见 failureKindFromStatus），拿不准一律当瞬时故障（宁可多给机会）。
function recordFailure(ch, msg, kind, opts) {
  const o = opts || {};
  const k = kind || failureKindFromStatus(o.status, msg);
  ch.consecutiveFail++;
  ch.lastError = msg;
  ch.cooldownUntil = Date.now() + cooldownMsFor(ch, k, o.retryAfterMs);
  if (ch.consecutiveFail >= 3) ch.status = 'down';
  // 失败也进用量统计（ok:false），便于排查"哪个渠道在挂"
  try {
    recordUsage({ model: '—', channelId: ch.def.id, kind: 'error', inputTokens: 0, outputTokens: 0, ok: false, latencyMs: 0, note: String(msg).slice(0, 200) });
  } catch { /* ignore */ }
}

// ★ 探测成功 ≠ "这家的对话能用"：探测打的是 /models（或登录态、agents 列表），一个渠道完全可能
//   列表拉得回来、真发对话却必失败（key 余额耗尽、上游下架了那个模型、参数方言不兼容）。
//   所以探测只做**半愈合**，这是 v1.10 修掉的真正"恢复太快"的来源：
//     · 失败计数**减半**而不是清零（欠账还记着，下次失败会更快退避回去）；
//     · 冷却放开（让它有资格被再试，否则凭证类 6 小时冷却会把"用户已经换了 key"的渠道也钉住）；
//     · 状态降成 degraded —— 排序上排在健康渠道**之后**（见 channelsServing 的 healthy() 分层），
//       于是它不再抢链首，只作兜底；要一次**真实对话**成功才会彻底清零、恢复 ok。
//   唯一的例外（第三个参数 realCompletion）：探测**本身就是一次真实对话**的渠道（workbuddy 的
//   chat 探针），它成功就是真凭实据，可以满血——"探测"和"对话"在这条路径上是同一件事。
function healAfterProbe(ch, ok, realCompletion) {
  ch.lastCheck = Date.now();
  ch.cooldownUntil = 0;
  if (ok && realCompletion) {          // 真凭实据：彻底清零，恢复 ok
    ch.consecutiveFail = 0;
    ch.probation = false;
    ch.lastError = null;
    ch.status = 'ok';
    return;
  }
  if (!ch.consecutiveFail) {           // 本来就没欠账：探测说了算（列表空则 degraded）
    ch.status = ok ? 'ok' : 'degraded';
    ch.probation = false;
    if (ok) ch.lastError = null;
    return;
  }
  ch.consecutiveFail = Math.max(1, Math.floor(ch.consecutiveFail / 2));
  ch.status = ok ? 'degraded' : 'down';
  ch.probation = !!ok;                 // 探测说"活着"但它还欠着账 → 进观察期（排健康渠道之后、不进权重池）
  // lastError 保留：控制台上仍能看到上次为什么被罚，别让"半愈合"顺手把证据擦掉
}

// ─────────────────────────── 启动 ───────────────────────────
server.listen(PORT, process.env.ZZCSAPI_BIND || '127.0.0.1', () => {
  console.log(`[zzcsapi] listening on http://127.0.0.1:${PORT}`);
  console.log(`[zzcsapi] auth: gateway=${GATEWAY_KEY ? 'on' : 'off'}(${keySourceOf('gateway')}) admin=${ADMIN_KEY ? 'on' : 'off'}(${keySourceOf('admin')})`);
  console.log(`[zzcsapi] channels: ${Array.from(channels.values()).map((c) => `${c.def.id}/${c.def.protocol}(${c.aliasMap.size})`).join(', ')}`);
  console.log(`[zzcsapi] aggregated: openai=[${aggregateModels('openai').join(', ')}] anthropic=[${aggregateModels('anthropic').join(', ')}] gemini=[${aggregateModels('gemini').join(', ')}]`);
});

process.on('SIGINT', () => { console.log('\n[zzcsapi] bye'); try { flushUsage(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { flushUsage(); } catch {} process.exit(0); });
