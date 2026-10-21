// opencode.js — opencode 免费模型反代（本机 `opencode serve` 边车，v1.18.72）
//
// 为什么必须独立成一条协议（而不是给 openai 渠道填个 base_url）：
//   直连 `https://opencode.ai/zen/v1/chat/completions` **默认是 403 FreeTierError**，
//   而且**跟凭据无关**——不带 / `Bearer public` / 乱码 key / **真实账号 OAuth token**、
//   真客户端逐字报文经 fetch(HTTP/1.1) / http2 / curl 三种通路，全是同一个 403。
//   但那道门判的是**报文里三个可自造的属性**（UA 形状 / 自铸 descending 会话 id /
//   官方标题生成器提示词前 ≥965 字符 + stream:true + 不带 tools），**v1.18.72 已实测能通**——
//   **v1.18.71 写的"判据在报文之外、没有收敛点"是错的**。
//   我们**仍然不走那条路**：它要**伪造客户端身份**，而且带 `tools` 一律 403（没有原生工具调用）。
//   证据、边界与六次误判留档见 docs/opencode-reverse-proxy-research.md §3/§9/§13。
//
//   ★ 选的正路不是伪造，而是**让真客户端替我们说话**：本机跑着的 `opencode serve` 本体
//   带着真实身份与真实凭据去访问上游，所以它能过。我们只跟它说话（本地 HTTP）。
//
// 链路（全部走注入的 zzFetch —— 边车是**本机/宿主机**地址，不经 Cloudflare，
//   所以不像 hark/genspark 那样需要 curl 子进程与代理）：
//   ① 鉴权：HTTP Basic，用户名默认 `opencode`（`OPENCODE_SERVER_USERNAME` 可改），密码 = 渠道 apiKey
//      ★ 这个"渠道 apiKey"不是给网关自己起的名，而是**两处必须同值的共享秘密**：起边车时由
//        `OPENCODE_SERVER_PASSWORD` 定下来，网关在这里递回去。**「不设口令」≠「不用口令」**——
//        `opencode serve` 没有 `--password` 参数，环境变量是唯一入口；不设它，边车会**自己随机生成
//        一个口令并打进 stdout 日志**，于是你仍然得抄进钥匙框，只是更难抄、且它躺在日志里（泄露面）。
//        实测四态：不带 Authorization 401 / 口令对 200 / 随便填 401 / 口令对但用户名错 401。
//        ⚠️ 所以 `basicAuth()` 下面那个 `user:pass` 拆分是**给改过用户名的场景留的口子**，
//        副作用是**口令里不能带冒号**（第一个冒号前那段会被当用户名）。
//   ② 建会话：POST /api/session {"model":{"id":<上游模型>,"providerID":"opencode"}}
//              → 200 {"data":{"id":"ses_…"}}
//   ③ 生成：  **两条路由并存，谁在跑边车谁说了算**（v1.18.89 起）
//             新版（边车 ≥1.0，实测 omnirush 自带 1.4.2）：
//               POST /session/{id}/message  {"parts":[{"type":"text","text":"…"}]}
//                 → 200 {"info":{…tokens…},"parts":[step-start, reasoning, text, step-finish]}  ← 同步整段
//             老版（0.x，v1.18.72 当时实测的那批）：
//               POST /api/session/{id}/generate {"prompt":"…"} → 200 {"data":{"text":"…"}}
//             先打新版，404/400/HTML 兜底页再退老版；**两条都不通就如实失败**。
//   ④ 清理：  DELETE /api/session/{id} → 204（**每请求都删**，见下）
//
// ★ 2026-10-21 现场（边车换到 1.4.2 之后）：老路由 `/api/session/{id}/generate` 在这版**不存在**，
//   而**不存在的路由回的是 200 + text/html（SPA 兜底页）**——按老写法会把一张网页当成模型的
//   回答塞给客户端，症状是"网关返回成功、正文是一坨 HTML"。所以：
//   ① 换到 `/session/{id}/message`（无 `/api` 前缀，`/api/...` 那套里没有这条 POST）；
//   ② 任何一处**收到 HTML 一律判失败**（`isHtmlBody`），绝不 `ok:true` 把它当正文；
//   ③ 正文**只拼 `type==='text'` 的 part**：响应里还有 `reasoning` part，它也带 `text` 字段，
//      不过滤就把思维链混进回答里了（很容易被误读成"模型在胡说"）。
//
// 四条实测事实（决定了本模块的形状，别再重新踩）：
//   · **没有 `stream` 参数**：两条生成路由都不支持真流式 → 只能**伪流式**
//     （与 hark/genspark 同套路：整段到达后由客户端面重新吐 SSE）
//   · **token 看版本**：1.4.2 的 `/message` **给真值**（`info.tokens.{input,output,cache.read,reasoning}`、
//     `info.cost`），老版的 `generate` 之后 `Session.Info.tokens`/`.cost` 恒为 0、`/message` 空数组
//     ⇒ 有真值就用真值，没有就按字符估，**绝不假装有**
//   · **同一会话不保留多轮记忆**：turn2 拿不回 turn1 的信息（实测模型答"你没有让我回过口令"）
//     ⇒ **每请求把 messages 拍平成一个 prompt**，不依赖会话态
//   · **`/api/experimental/generate` 也是个陷阱**：它是个"无会话"的精简单发端点，看起来更省事，
//     但实测**回的是跟直连一模一样的免费层墙**
//     （`503 OpenCode's free tier can only be used from within OpenCode`）——
//     **只有会话路是被认可的**。换成那个端点 = 把整条链路悄悄打回死路，且症状是一句很难归因的 503。
//
// ★ 边车**必须由我们自己起**（`deploy/opencode-sidecar.ps1`，固定端口 4666 + 固定口令）：
//   原先指向别的应用（omnirush desktop）拉起的那份，它自己选端口、自己随机造口令，
//   它一重启网关就对着一个死端口按 5 分钟一次敲了 87 次（`AggregateError`＝IPv4/IPv6 双栈都拒连）。
//   那个脚本另外把**工作目录**设成空目录：边车把 cwd 当项目根、会把整个项目的文件塞进每一发请求
//   （实测从仓库目录起：一发俏皮话 `tokens.input=50627`；空目录起：8136 ⇒ 既省额度也不把源码递给免费层）。
//
// 会话清理为什么必须做：边车里的会话是**落在用户自己账号下**的。
//   实测：每次请求"建 → 用 → 删"之后，`GET /api/session` 的条数**不变**；
//   漏掉 DELETE 就会让每一次网关请求都在用户账号里堆一条会话（上不封顶）。
//   所以**成功失败都删**，删除失败不影响本轮结果。
//
// ⚠️ 合规（必须随代码一起读）：免费层条款写的是「can only be used from within OpenCode」。
//   我们跑的是**真客户端、没有伪造任何东西**（没有假会话、没有逆向签名、没有设备证明），
//   但把**任意第三方流量**中继进免费层**不是这条免费层被设计出来的用途**，
//   且官方明说免费是 "for a limited time" ⇒ **有封号风险**。要不要上生产由部署者自己决定。
'use strict';

// 默认端口 4666 = deploy/opencode-sidecar.ps1 里那份**我们自己的**边车（v1.18.89）。
// 旧的 49551 是别的应用随手选的端口，它一重启就漂 ⇒ 那正是 87 次 AggregateError 的来源。
const DEFAULT_BASE = 'http://host.docker.internal:4666';
const DEFAULT_USER = 'opencode';
// 上游所有模型都挂在 providerID `opencode` 下（边车目录 42 条全是这一个值，实测）
const PROVIDER_ID = 'opencode';
// 上游没有免费模型时的兜底建议（正常情况下目录探测会给出真实清单）
const OC_DEFAULT_ALIAS = 'deepseek-v4.1-flash-free';

function baseOf(def) {
  return String((def && def.baseUrl) || DEFAULT_BASE).replace(/\/+$/, '');
}

// Basic 凭据：渠道 apiKey = 边车密码。用户名默认 `opencode`；
// 若 apiKey 写成 `user:password` 则用点号前那段当用户名（边车侧若设了
// OPENCODE_SERVER_USERNAME 才需要这么写——Base64/Base64URL 口令里不含 `:`，这个约定不会误伤）。
function basicAuth(def) {
  const raw = String((def && def.apiKey) || '');
  let user = DEFAULT_USER, pass = raw;
  const i = raw.indexOf(':');
  if (i > 0) { user = raw.slice(0, i); pass = raw.slice(i + 1); }
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
}

function ocHeaders(def, extra) {
  return Object.assign({
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': basicAuth(def),
  }, extra || {});
}

function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

// 边车把"路由不存在"也回成 200 —— 因为它是 SPA，任何未知路径都吐 index.html。
// ⇒ **收到 HTML 一律当失败**：把一张网页当模型正文塞给客户端，是比报错坏得多的结局。
// （2026-10-21 实测：POST /api/session/{id}/generate 在 1.4.2 上回的正是 200 + text/html 2884 字节。）
function isHtmlBody(t) {
  return /^\s*<(?:!doctype|html|head|body|\?xml)/i.test(String(t || ''));
}

// 从新版响应里取正文：**只拼 type==='text' 的 part**。
// 响应形如 {"info":{…},"parts":[{"type":"step-start"},{…},{"type":"reasoning","text":"…"},
//           {"type":"text","text":"…"},{"type":"step-finish"}]}
// ★ `reasoning` part 也带 `text` 字段（思维链）——不过滤就会把思考过程拼进回答里。
function opencodeTextFromParts(j) {
  const parts = j && (Array.isArray(j.parts) ? j.parts : (j.data && Array.isArray(j.data.parts) ? j.data.parts : null));
  if (!Array.isArray(parts)) return null;
  const out = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
  return out;
}

// 上游真 token 值（1.4.2 的 /message 给；老版 generate 恒为 0 ⇒ 返回 null 让调用侧去估）
function opencodeUsageOf(j) {
  const tk = j && j.info && j.info.tokens;
  if (!tk || typeof tk !== 'object') return null;
  const input = Number(tk.input) || 0;
  const output = Number(tk.output) || 0;
  if (!input && !output) return null;
  return {
    input, output,
    reasoning: Number(tk.reasoning) || 0,
    cacheRead: Number(tk.cache && tk.cache.read) || 0,
    cost: Number(j.info.cost) || 0,
  };
}

// 边车把错误放在 `_tag` + `message`（不是 OpenAI 的 error.message）→ 归一成一句人能读的话
function ocErrorText(status, body) {
  const j = safeJson(body);
  const msg = (j && (j.message || (j.error && j.error.message))) || String(body || '').slice(0, 200);
  return `HTTP ${status}: ${String(msg).replace(/\s+/g, ' ').slice(0, 180)}`;
}

// 一次带超时的边车请求。fetchFn 由 server.js 注入（zzFetch：keep-alive + 可中止）。
// 连不上/超时 → {ok:false, status:0, error}（与"上游明确拒绝"分开，调用侧才判得清）。
async function ocRequest(def, fetchFn, method, path, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, Math.max(1000, timeoutMs || 120000));
  let resp;
  try {
    resp = await fetchFn(baseOf(def) + path, {
      method,
      headers: ocHeaders(def),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    return { ok: false, status: 0, error: String((err && err.message) || err) };
  } finally { clearTimeout(timer); }
  const text = await resp.text().catch(() => '');
  return { ok: resp.ok, status: resp.status, text, body: text };
}

// ─────────────────────────── 探测（列目录） ───────────────────────────

// GET /api/model → {"location":…, "data":[{id,providerID,…}]}
// ⚠️ **只取 `id`**：目录里每条模型都带 `headers:{"x-opencode-org-id":…}`——那是账号标识，
//   绝不允许漏进渠道列表、账本、日志或任何文档（AGENTS.md 的血泪条款）。
//   返回体里还有 `location`（本机路径），同样不取。
async function opencodeCatalog(def, fetchFn, timeoutMs) {
  const r = await ocRequest(def, fetchFn, 'GET', '/api/model', undefined, timeoutMs || 15000);
  if (!r.ok) {
    if (r.status === 401) return { ok: false, status: 401, error: '边车密码不对（401 Authentication required）——渠道钥匙请填 OPENCODE_SERVER_PASSWORD 的值' };
    return { ok: false, status: r.status, error: r.status ? ocErrorText(r.status, r.text) : '连不上边车：' + r.error };
  }
  const j = safeJson(r.text);
  const arr = j && (Array.isArray(j) ? j : j.data);
  if (!Array.isArray(arr)) return { ok: false, status: r.status, error: '边车 /api/model 形状不对（不是数组）：' + String(r.text).slice(0, 120) };
  const all = arr.map((m) => String((m && m.id) || '')).filter(Boolean);
  if (!all.length) return { ok: false, status: r.status, error: '边车目录是空的（这台机器上没登录态？）' };
  const free = all.filter((m) => /-free$/.test(m));
  return { ok: true, status: r.status, all, free, models: free.length ? free : all };
}

// ─────────────────────────── 生成（建会话 → generate → 删会话） ───────────────────────────

async function opencodeCreateSession(def, fetchFn, model, timeoutMs) {
  const r = await ocRequest(def, fetchFn, 'POST', '/api/session',
    { model: { id: String(model), providerID: PROVIDER_ID } }, timeoutMs || 20000);
  if (!r.ok) return { ok: false, status: r.status, error: r.status ? ocErrorText(r.status, r.text) : '建会话连不上：' + r.error };
  const j = safeJson(r.text);
  const id = j && j.data && j.data.id;
  // ⚠️ 会话 id 在 `data.id`，**不是顶层 `id`**（顶层 keys 实测是 `data`）。
  //    写成 `j.id` 会静默拿到 undefined，然后每一发都撞在 generate 的 400 上。
  if (!id) return { ok: false, status: r.status, error: '建会话没回 data.id：' + String(r.text).slice(0, 120) };
  return { ok: true, status: r.status, id: String(id) };
}

async function opencodeDeleteSession(def, fetchFn, id, timeoutMs) {
  if (!id) return { ok: false };
  try {
    const r = await ocRequest(def, fetchFn, 'DELETE', '/api/session/' + encodeURIComponent(id), undefined, timeoutMs || 10000);
    return { ok: r.ok || r.status === 204, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 一次完整的"生成"：建会话 → generate → **无论如何都删会话**。
// 返回 {ok, text, status, error, ms}。`ms` 是上游总耗时（会话创建 + 生成）。
async function opencodeGenerate(def, fetchFn, model, prompt, timeoutMs) {
  const t0 = Date.now();
  const tmo = timeoutMs || 120000;
  const ses = await opencodeCreateSession(def, fetchFn, model, Math.min(20000, tmo));
  if (!ses.ok) return { ok: false, status: ses.status, error: ses.error, ms: Date.now() - t0 };
  const sid = encodeURIComponent(ses.id);

  // 先打新版路由（边车 ≥1.0）：同步整段返回，还带真 token。
  let gen = await ocRequest(def, fetchFn, 'POST', `/session/${sid}/message`,
    { parts: [{ type: 'text', text: String(prompt) }] }, tmo);
  let via = 'message';
  // 新版路由不存在时会有三种长相：404 / 400（形状不认）/ 200+HTML（SPA 兜底）⇒ 退回老版再来一次。
  // 老版若也失败，**保留新版的错误**（它更能说明"版本对不上"）。
  if (!gen.ok || isHtmlBody(gen.text)) {
    const legacy = await ocRequest(def, fetchFn, 'POST', `/api/session/${sid}/generate`,
      { prompt: String(prompt) }, tmo);
    if (legacy.ok && !isHtmlBody(legacy.text)) { gen = legacy; via = 'generate'; }
    else if (!gen.ok) { gen = legacy; via = 'generate'; }
  }

  // 先删会话再返回：文本已经在手里，先清理能保证"客户端中途断开"也不留垃圾会话
  try { await opencodeDeleteSession(def, fetchFn, ses.id, 10000); } catch { /* 删不掉不影响本轮 */ }

  if (!gen.ok) return { ok: false, status: gen.status, via, error: gen.status ? ocErrorText(gen.status, gen.text) : '生成连不上：' + gen.error, ms: Date.now() - t0 };
  if (isHtmlBody(gen.text)) {
    return {
      ok: false, status: gen.status, via, ms: Date.now() - t0,
      error: '边车回了 HTML（200 的 SPA 兜底页 ＝ 这个路由在它那版不存在）：新版走 POST /session/{id}/message，'
        + '老版走 POST /api/session/{id}/generate，两条都没通 ⇒ 边车版本与 opencode.js 预期不符，或 baseUrl 指错了服务',
    };
  }
  const j = safeJson(gen.text);
  const text = via === 'generate'
    ? (j && j.data && typeof j.data.text === 'string' ? j.data.text : null)
    : opencodeTextFromParts(j);
  if (text === null) {
    return {
      ok: false, status: gen.status, via, ms: Date.now() - t0,
      error: '生成响应形状不对（' + (via === 'generate' ? '没有 data.text' : '没有 parts 数组') + '）：' + String(gen.text).slice(0, 120),
    };
  }
  return { ok: true, status: gen.status, text, via, usage: opencodeUsageOf(j), ms: Date.now() - t0 };
}

// 探活：一条**极短**的真实生成（建会话 + 发一句话 + 删会话）。
// 比"列个目录"贵一点，但目录只证明凭据活着、证明不了**对话这条路能成**——
// 而这条路才是网关真正要走的路（与 notion-agent 的 quickChat 同一取舍）。
async function opencodeProbe(def, fetchFn, timeoutMs) {
  const r = await opencodeGenerate(def, fetchFn, OC_DEFAULT_ALIAS, 'Reply with exactly: ok', timeoutMs || 60000);
  if (!r.ok) return { ok: false, status: r.status || 0, error: r.error, latencyMs: r.ms };
  return { ok: true, status: 200, reply: r.text, latencyMs: r.ms };
}

// ─────────────────────────── 报文渲染 ───────────────────────────

// 边车的发送接口只收**一条字符串** → 把（已由 tool-emu 仿真过的）messages 拍平成一段文本。
// 每段带【角色】标注，让上游分得清系统设定 / 历史 / 工具结果 / 本次输入（与 flattenForHark 同形，
// 刻意不共用：两条链路的失败形态与调参要能各自演化，共用一份就会互相绊住）。
function flattenForOpencode(messages) {
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

module.exports = {
  opencodeCatalog,
  opencodeCreateSession,
  opencodeDeleteSession,
  opencodeGenerate,
  opencodeProbe,
  opencodeTextFromParts,
  opencodeUsageOf,
  isHtmlBody,
  flattenForOpencode,
  basicAuth,
  baseOf,
  PROVIDER_ID,
  DEFAULT_BASE,
  DEFAULT_USER,
  OC_DEFAULT_ALIAS,
};
