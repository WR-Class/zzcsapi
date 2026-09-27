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
const notionAgent = require('./notion-agent.js');
const toolEmu = require('./tool-emu.js');
// Genspark 网页会话渠道常量：必须在启动探测路径（probeAll 在下方模块加载期同步触发）之前初始化，
// 放文件底部会因 const TDZ 使首轮探测静默失败
const crypto = require('crypto');
const GENSPARK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const GENSPARK_REFERER = 'https://www.genspark.ai/agents?type=ai_chat';

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
function checkAuth(req, kind) {
  // kind: 'gateway' | 'admin'
  if (NOAUTH) return true;                            // 本地免鉴权（显式选择的开发模式）
  // NOAUTH 关闭时密钥恒非空（空则首启已生成，见 resolveGeneratedKeys），不再存在"没设置就放行"
  const need = kind === 'admin' ? ADMIN_KEY : GATEWAY_KEY;
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m && m[1] === need) return true;
  // 原生 SDK 兼容（仅 gateway 侧）：Gemini SDK 发 x-goog-api-key（其默认鉴权头，另一模式是 ?key=），
  // Anthropic SDK 发 x-api-key。不认这两个头 → 官方 SDK 直连一律 401（OpenAI SDK 走 Bearer 本来就通）。
  // 管理面不接受它们：admin 只能 Bearer / ?key=，避免把客户端密钥语义混进管理面。
  if (kind !== 'admin') {
    if (req.headers['x-goog-api-key'] === need) return true;
    if (req.headers['x-api-key'] === need) return true;
  }
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
  const pool = candidates.filter((c) => Number(c.weight) > 0 && !(c.cooldownUntil > now) && c.status !== 'down');
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
      const agents = await notionAgent.listAgents(ch.def.baseUrl, ch.def.apiKey, fetch, HEALTH.timeoutMs || 15000);
      ch.models = agents.map((a) => a.name).filter(Boolean);
      ch.agentModels = agents;
      ch.latencyMs = Date.now() - t0;
      ch.lastCheck = Date.now();
      ch.consecutiveFail = 0; ch.cooldownUntil = 0; ch.lastError = null;
      ch.status = agents.length > 0 ? 'ok' : 'degraded';
    } catch (err) {
      ch.status = 'down';
      ch.consecutiveFail++;
      ch.lastError = 'notion-agent: ' + (err.message || err);
      ch.cooldownUntil = Date.now() + Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail));
    }
    return;
  }
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
  // WorkBuddy 国际版反代：无 /models 端点，探测走一次真实轻量聊天（免费 deepseek-v4.1-flash）
  if ((ch.def.protocol || 'openai') === 'workbuddy' || ch.def.protocol === 'genspark') {
    const t0 = Date.now();
    try {
      const probe = ch.def.protocol === 'genspark' ? await gensparkIsLogin(ch.def, HEALTH.timeoutMs || 15000) : await workbuddyChatProbe(ch.def, HEALTH.timeoutMs || 15000);
      if (!probe.ok) throw new Error(probe.error || 'probe failed');
      // 无 /models 端点 → 模型列表直接用 def.models 的 upstream 值（用户配置的别名映射）
      ch.models = Object.values(ch.def.models || {}).filter(Boolean);
      ch.latencyMs = Date.now() - t0;
      ch.lastCheck = Date.now();
      ch.consecutiveFail = 0; ch.cooldownUntil = 0; ch.lastError = null;
      ch.status = 'ok';
    } catch (err) {
      ch.status = 'down';
      ch.consecutiveFail++;
      ch.lastError = 'workbuddy: ' + (err.message || err);
      ch.cooldownUntil = Date.now() + Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail));
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
      ch.lastCheck = Date.now();
      ch.consecutiveFail = 0; ch.cooldownUntil = 0; ch.lastError = null;
      ch.status = 'ok';
    } catch (err) {
      ch.status = 'down';
      ch.consecutiveFail++;
      ch.lastError = String(err.message || err);
      // RT 失效是致命错误，拉长冷却避免反复打上游（每次失败上游日志都有记录）
      ch.cooldownUntil = Date.now() + (err.fatal ? 300_000 : Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail)));
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
    resp = await fetch(probeUrl, {
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
      ch.status = 'down';
      ch.consecutiveFail++;
      ch.lastError = `probe ${resp.status}`;
      ch.cooldownUntil = Date.now() + Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail));
      return;
    }
    const text = await resp.text();
    const j = safeJson(text);
    // ponytail: 探测成功即清零熔断计数（治愈回池）——坏渠道在滚动失败率攒满 5 样本前，每个探测周期最多再被真实流量撞 ~3 次，由有效优先级自动降权兜底
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
      const agents = await notionAgent.listAgents(def.baseUrl, def.apiKey, fetch, timeoutMs || 15000);
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

// WorkBuddy 探测：/v2 下没有 /models 端点（404），只能走一次真实轻量聊天。
// 用 def.models 里第一个 upstream 模型（通常是 deepseek-v4.1-flash），
// system+user、max_tokens=1、stream=true，读到首个 SSE chunk 即判活。
// 注意：必须走 curl 子进程——该上游对 Node/undici 的 TLS 指纹直接 ECONNRESET。
async function workbuddyChatProbe(def, timeoutMs) {
  const t0 = Date.now();
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
  if (text.startsWith('{')) {
    const j = safeJson(text);
    return { ok: false, error: (j && (j.msg || (j.error && j.error.message))) || text.slice(0, 120) || 'json error', latencyMs: Date.now() - t0, status: out.status };
  }
  if (!/^data:/m.test(text)) {
    return { ok: false, error: 'non-SSE response', latencyMs: Date.now() - t0, status: out.status };
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
  for (const c of contents) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    // Gemini 部件 → OpenAI content blocks。**顺序必须保留**：图片与文本的相对位置对视觉模型有语义
    // （先图后问 vs 先问后图，回答会不一样）。text 原样转文本；inlineData（base64）与 fileData（fileUri）
    // 转 image_url；functionCall / functionResponse 仍降级为文本（只有工具仿真链用得上，图片链用不到）。
    const blocks = [];
    for (const p of (c.parts || [])) {
      const inline = p.inlineData || p.inline_data;
      const file = p.fileData || p.file_data;
      if (p.text) blocks.push({ type: 'text', text: p.text });
      else if (inline && inline.data) {
        blocks.push({ type: 'image_url', image_url: { url: `data:${inline.mimeType || inline.mime_type || 'image/png'};base64,${inline.data}` } });
      } else if (file && (file.fileUri || file.file_uri)) {
        blocks.push({ type: 'image_url', image_url: { url: file.fileUri || file.file_uri } });
      } else if (p.functionCall) blocks.push({ type: 'text', text: '```json\n{"tool_calls": [{"name": ' + JSON.stringify(p.functionCall.name || '') + ', "arguments": ' + JSON.stringify(p.functionCall.args || {}) + '}]}\n```' });
      else if (p.functionResponse) blocks.push({ type: 'text', text: '[工具 ' + (p.functionResponse.name || '') + ' 的执行结果如下]\n' + JSON.stringify(p.functionResponse.response || {}) + '\n[请根据以上工具结果继续]' });
    }
    const hasImage = blocks.some((b) => b.type === 'image_url');
    if (hasImage) {
      messages.push({ role, content: blocks });
    } else {
      // 纯文本仍用字符串形态：上游与各回退渠道普遍只认 string（数组形态只有 OpenAI 官方语义能接受）
      const text = blocks.map((b) => b.text).filter(Boolean).join('\n');
      if (text) messages.push({ role, content: text });
    }
  }
  const gen = body.generationConfig || {};
  // Gemini functionDeclarations → OpenAI tools（回退 notion 时启用工具仿真）
  const tools = [];
  const decls = (body.tools && body.tools[0] && body.tools[0].functionDeclarations)
    || (body.tools && body.tools[0] && body.tools[0].function_declarations) || [];
  for (const d of decls) {
    tools.push({
      type: 'function',
      function: {
        name: d.name,
        description: d.description || '',
        parameters: d.parameters || {},
      },
    });
  }
  return {
    model,
    messages,
    max_tokens: gen.maxOutputTokens,
    temperature: gen.temperature,
    top_p: gen.topP,
    stream: !!body.stream,
    ...(tools.length ? { tools, tool_choice: body.tool_choice || 'auto' } : {}),
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
    // 结束分片必须带上 finishReason —— 否则 Gemini 流式客户端永远等不到"回答结束"，
    // 只能靠连接断开猜（此前这里只转发 text，结束帧被整帧丢弃）。
    if (choice?.finish_reason) {
      const fr = choice.finish_reason === 'length' ? 'MAX_TOKENS'
        : choice.finish_reason === 'content_filter' ? 'SAFETY' : 'STOP';
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
    // 图片生成：OpenAI 兼容 /v1/images/generations，走 openai 协议渠道直透（复用调度/兜底/记账）
    if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
      if (!checkAuth(req, 'gateway')) return unauthorized(res, 'gateway');
      return handleImageRequest(req, res, url);
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
  const wstats = weightedStats(); // 轮询命中统计（算一次，避免每个渠道重算）
  const autoObs = autoWeightObserve(); // 自动权重观测（只算不生效，v1.6）
  return {
    channels: Array.from(channels.values()).map((ch) => {
      const ast = AUTO_STATE.get(ch.def.id);
      return {
      id: ch.def.id,
      name: ch.def.name || ch.def.id,
      baseUrl: ch.def.baseUrl,
      apiKey: ch.def.apiKey,
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
      effective: false, // v1.6 恒为 false：观测不生效，见 README「自动权重（观测版）」
      knobs: { ...AUTO_W },
      at: AUTO_LAST_AT || null,
      models: autoObs,
    },
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
    // 自动权重旋钮：必须在白名单里——否则控制台随便保存一次渠道就会把用户调好的参数从 config.json 里抹掉
    // （与渠道 weight 字段同一个坑，见 PT29）
    autoWeight: { ...AUTO_W },
    // 首启生成的密钥随配置一起持久化（env 显式提供的密钥不落盘——config.adminKey 保持未设置）
    adminKey: config.adminKey || undefined,
    gatewayKey: config.gatewayKey || undefined,
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
 * 因此 `enabled` 目前是**预留字段**——就算置 true，本版也不改分流（README 里写明了）。
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

function normAutoWeight(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    enabled: o.enabled === true,                              // 预留：本版置 true 也不改分流
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

  // 完整 CRUD：channels 集合
  if (req.method === 'GET' && url.pathname === '/admin/api/channels') {
    return sendJson(res, 200, { channels: Array.from(channels.values()).map((ch) => ({
      id: ch.def.id,
      name: ch.def.name,
      baseUrl: ch.def.baseUrl,
      apiKey: ch.def.apiKey,
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
    const err = validateChannelDef(body);
    if (err) return sendJson(res, 400, { error: err });
    // 已有的 weight 不能被"本次没传这个字段"抹掉（v1.5 起控制台表单会**显式**提交 weight：
    // 留空 = 真的清成 0；只有那些老客户端/导入流程不传 weight 时才沿用旧值）
    const prevDef = channels.get(body.id)?.def;
    const def = {
      id: body.id,
      name: body.name || body.id,
      baseUrl: body.baseUrl.replace(/\/+$/, ''),
      apiKey: body.apiKey,
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
        target.consecutiveFail = 0; target.cooldownUntil = 0; target.lastError = null;
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
          const r = await notionAgent.quickChat(ch.def.baseUrl, ch.def.apiKey, c.upstream, prompt, fetch, tmo);
          if (r.ok) {
            ch.consecutiveFail = 0; ch.cooldownUntil = 0; ch.lastError = null;
            if (ch.status !== 'ok') ch.status = 'ok';
            ch.latencyMs = r.ms; ch.lastCheck = Date.now();
            recordUsage({ model, channelId: c.channelId, kind: 'test', inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(r.text), ok: true, latencyMs: r.ms });
          } else {
            ch.consecutiveFail++; ch.lastError = 'notion-agent: ' + String(r.error).slice(0, 150);
            ch.cooldownUntil = Date.now() + Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail));
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
            ch.consecutiveFail = 0; ch.cooldownUntil = 0; ch.lastError = null;
            if (ch.status !== 'ok') ch.status = 'ok';
            ch.latencyMs = ttfb; ch.lastCheck = Date.now();
            recordUsage({ model, channelId: c.channelId, kind: 'test', inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(reply), ok: true, latencyMs: ttfb });
          } else {
            ch.consecutiveFail++; ch.lastError = 'workbuddy: ' + String(wbErr || 'empty reply').slice(0, 150);
            ch.cooldownUntil = Date.now() + Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail));
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
            ch.consecutiveFail = 0; ch.cooldownUntil = 0; ch.lastError = null;
            if (ch.status !== 'ok') ch.status = 'ok';
            ch.latencyMs = ttfb; ch.lastCheck = Date.now();
            recordUsage({ model, channelId: c.channelId, kind: 'test', inputTokens: parsed.usage ? parsed.usage.prompt_tokens : estimateTokens(prompt), outputTokens: parsed.usage ? parsed.usage.completion_tokens : estimateTokens(reply), ok: true, latencyMs: ttfb, realUsage: parsed.usage || null });
          } else {
            ch.consecutiveFail++; ch.lastError = 'genspark: ' + String(gsErr || (parsed.placeholder ? '上游占位符回复' : 'empty reply')).slice(0, 150);
            ch.cooldownUntil = Date.now() + (parsed.notLogin ? 300_000 : parsed.rateLimited ? 3600_000 : Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail)));
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
            ch.consecutiveFail = 0; ch.cooldownUntil = 0; ch.lastError = null;
            if (ch.status !== 'ok') ch.status = 'ok';
            ch.latencyMs = ttfb; ch.lastCheck = Date.now();
            recordUsage({ model, channelId: c.channelId, kind: 'test', inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(reply), ok: true, latencyMs: ttfb });
          } else {
            ch.consecutiveFail++; ch.lastError = 'codex: ' + String(cxErr || 'empty reply').slice(0, 150);
            ch.cooldownUntil = Date.now() + Math.min(60_000, 1000 * Math.pow(2, ch.consecutiveFail));
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
        resp = await fetch(target, { method: 'POST', headers, body: JSON.stringify(bodyOut), signal: ctrl.signal });
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
      protocol: 'openai',
      kind: 'explicit',
      weight: Number(ch.def.weight) > 0 ? Number(ch.def.weight) : 0,
    });
  }
  out.sort((a, b) => {
    const healthy = (c) => (c.cooldownUntil > Date.now() ? 2 : c.status === 'down' ? 1 : 0);
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

  for (let i = 0; i < maxCand; i++) {
    const c = candidates[i];
    if (c.cooldownUntil > Date.now()) {
      errors.push({ ch: c.channelId, err: 'in cooldown' });
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
    const native = (chProto === 'anthropic' || chProto === 'gemini') ? nativeChannelOpts(chProto, requestedModel) : null;
    // ★ 同渠道重试（perChannel）：一次请求内对**同一家**最多再试 PER_CHANNEL_RETRIES 次，
    //   只重试可重试的失败（5xx/网络/超时）；4xx 与 fatal_client 立刻跳出换下家。
    //   注意：冷却只挡"下一次请求"选不选它，不挡这里的原地重试——正是要靠这次重试把瞬时抖动吃掉。
    let result;
    for (let attempt = 0; ; attempt++) {
      result = await tryChannel({
        res, url, body, candidate: c, isStream: stream,
        encodeOutgoing, buildOutgoingUrl, buildOutgoingHeaders, onSuccessNonStream, onStreamChunk, requestedModel, kind,
        ...(native || {}),
        // 流式的"开场/收尾"钩子也必须转发：漏掉它们时 message_start 与收尾事件就不会发出
        // （历史上这里漏了 streamPrelude，导致 Anthropic 流式一直没有 message_start）
        streamPrelude: opts.streamPrelude, streamEpilogue: opts.streamEpilogue,
        hasMoreCandidates,
        attempt,
      });
      if (result === 'success') return;
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
  if (!attemptedAny) return sendJson(res, 503, upstreamErrorPayload(503, 'all channels in cooldown'));
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
      resp = await fetch(target, { method: 'POST', headers, body: bodyStr, signal: ctrl.signal });
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
    recordFailure(ch, `HTTP ${resp.status}: ${String(text).slice(0, 200)}`);
    // 401/402/403/404/408/429 是渠道侧问题（鉴权/余额/该渠道没有此模型/超时/限频，跨渠道各不相同）→ 切下一候选兜底；
    // 其余 4xx（400 参数错等）**只在没有后续候选时**才原样透传 ——
    // 详见 shouldPassThrough4xx 的注释（渠道声明过期的模型 / 参数方言不同，换一家往往就能成）。
    if (shouldPassThrough4xx(resp.status, opts.hasMoreCandidates)) {
      // 客户端错误：直接把上游响应转发
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
    if (typeof opts.streamPrelude === 'function') {
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
    if (typeof opts.makeStreamTranslator === 'function') nativeStream = opts.makeStreamTranslator(candidate);
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
        if (out) res.write(out);
        return;
      }
      streamOutText += sseDeltaText(line);
      if (onStreamChunk) {
        const out = onStreamChunk(line + '\n', candidate);
        if (out) res.write(out);
      } else {
        res.write(line + '\n');
      }
    };
    const drain = (final) => {
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
      if (final && buf.length) { handleLine(buf); buf = ''; }
    };
    try {
      // ★ 首块字节必须和后续字节走同一条按行分发路径。早期实现只把它塞进 buf 就进 read 循环，
      //   于是"上游把整个流一次送到（快线路 / 小回答）"时下一次 read 直接 done，
      //   透传分支（OpenAI 路由没有 onStreamChunk）一个字节都没写出去 ——
      //   表现是 HTTP 200 + text/event-stream 却是**空响应体**，三种客户端协议全中招。
      if (firstVal && firstVal.length) {
        buf += decoder.decode(firstVal, { stream: true });
        drain(false);
      }
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        drain(false);
      }
      buf += decoder.decode(); // 冲掉解码器里残留的多字节字符
      drain(true);
    } catch (err) { /* 上游已断 */ }
    // 原生流式收尾：上游没发结束标记（异常断流）时也要把 finish_reason + [DONE] 补上，
    // 否则客户端的流式解析器会一直等（与 Anthropic 路由的 streamEpilogue 是同一类兜底）
    if (nativeStream) {
      const tail = emitNative(nativeStream.end());
      if (tail) res.write(tail);
    }
    if (typeof opts.streamEpilogue === 'function') {
      const post = opts.streamEpilogue();
      if (post) res.write(post);
    }
    res.end();
    recordUsage({
      model: body && body.model, channelId: candidate.channelId, kind: opts.kind,
      inputTokens: estimateTokens(messagesText(body && body.messages)),
      outputTokens: estimateTokens(streamOutText), ok: true, latencyMs: Date.now() - t0,
    });
    return 'success';
  } else {
    // 非流式：先读全文（统计 + 转发），shim 给 handler 避免 double-read
    const rawText = await resp.text();
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
    recordFailure(ch, `workbuddy ${out.status}: ` + msg);
    if (shouldPassThrough4xx(out.status, opts.hasMoreCandidates)) {
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(sseText);
      return 'fatal_client';
    }
    if (out.status >= 400 && out.status < 500) return 'channel_error';   // 4xx：切下家，同渠道不重试
    return `workbuddy ${out.status}: ${msg}`;
  }
  if (!/^data:/m.test(sseText)) {
    recordFailure(ch, 'workbuddy: non-SSE response');
    return 'workbuddy: non-SSE response';
  }

  // 成功
  ch.consecutiveFail = 0;
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
// 局限：上游忽略 OpenAI tools 参数（genspark2api 实测静默忽略），本渠道暂不做工具仿真；
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

  const payload = gensparkBuildPayload(candidate.upstream, body.messages);
  const out = await gensparkAsk(ch.def, JSON.stringify(payload), timeoutMs);
  if (out.error || !out.body) {
    recordFailure(ch, 'genspark curl: ' + (out.error || 'empty body'));
    return 'genspark curl: ' + (out.error || 'empty body');
  }
  const raw = out.body;
  if (out.status >= 400) {
    const j = safeJson(raw);
    const msg = (j && (j.message || (j.error && j.error.message))) || raw.slice(0, 160);
    recordFailure(ch, `genspark HTTP ${out.status}: ${String(msg).slice(0, 160)}`);
    // 400/422 等请求错误：只在没有后续候选时才透传（见 shouldPassThrough4xx）；
    // 401/403 会话或出口问题、404 该渠道没有此内容 → 切下一候选
    if (shouldPassThrough4xx(out.status, opts.hasMoreCandidates)) {
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(raw);
      return 'fatal_client';
    }
    if (out.status === 401 || out.status === 403) ch.cooldownUntil = Date.now() + 300_000; // 会话/出口问题长冷却，避免反复撞墙
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
    recordFailure(ch, 'genspark: session 失效（not login）');
    ch.cooldownUntil = Date.now() + 300_000;
    return 'genspark: not login (session expired)';
  }
  if (st.rateLimited) {
    recordFailure(ch, 'genspark: 限流（rate limit / too quickly / 积分已用完）');
    ch.cooldownUntil = Date.now() + 3600_000;
    return 'genspark: rate limited (cooldown 1h)';
  }
  const replyText = (st.finalContent || st.fullText || '').trim();
  if (!replyText || st.placeholder) {
    recordFailure(ch, st.placeholder ? 'genspark: 上游占位符回复（' + replyText.slice(0, 60) + '）' : 'genspark: 空回复');
    return st.placeholder ? 'genspark: upstream placeholder reply' : 'genspark: empty reply';
  }

  // 成功
  ch.consecutiveFail = 0;
  ch.cooldownUntil = 0;
  ch.lastError = null;
  if (ch.status === 'down' || ch.status === 'unknown') ch.status = 'ok';
  ch.latencyMs = Date.now() - t0;

  const respId = 'chatcmpl-gs-' + Date.now().toString(36);
  const inTok = st.usage ? st.usage.prompt_tokens : estimateTokens(messagesText(body && body.messages));
  const outTok = st.usage ? st.usage.completion_tokens : estimateTokens(replyText);

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
    res.write(chunk({ role: 'assistant', content: '' }));
    res.write(chunk({ content: replyText }));
    if (st.usage) res.write(`data: ${JSON.stringify({ id: respId, object: 'chat.completion.chunk', model: displayModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: st.usage })}\n\n`);
    else res.write(chunk({}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
    recordUsage({ model: displayModel, channelId: candidate.channelId, kind, inputTokens: inTok, outputTokens: outTok, ok: true, latencyMs: Date.now() - t0, realUsage: st.usage });
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
    recordFailure(ch, String(err.message || err));
    if (err.fatal) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } }));
      return 'fatal_client';
    }
    return err.message || 'codex token error';
  }
  if (!call.ok) {
    recordFailure(ch, 'codex ' + call.status + ': ' + call.error);
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
        resp = await fetch(target, { method: 'POST', headers, body: bodyStr, signal: ctrl.signal });
      } finally { clearTimeout(to); }
      httpStatus = resp.status;
      if (resp.ok) ndjsonText = await resp.text();
      else {
        const errText = await resp.text().catch(() => '');
        recordFailure(ch, `notion HTTP ${resp.status}: ${errText.slice(0, 200)}`);
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
      agentId = await notionAgent.resolveAgentId(base, token, candidate.upstream, fetch, 20000);
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
      fetchFn: fetch, timeoutMs: timeoutMs - 20000,
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
    recordFailure(ch, `notion-agent${turn.status ? ' HTTP ' + turn.status : ''}: ${String(turn.error || '').slice(0, 150)}`);
    return `notion-agent ${turn.status || ''}: ${String(turn.error || '').slice(0, 100)}`;
  }

  // 4) 成功：清失败状态
  ch.consecutiveFail = 0;
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
