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
//   ③ 生成：  POST /api/session/{id}/generate {"prompt":"…"}
//              → 200 {"data":{"text":"…"}}          ← 整段一次下发
//   ④ 清理：  DELETE /api/session/{id} → 204（**每请求都删**，见下）
//
// 四条实测事实（决定了本模块的形状，别再重新踩）：
//   · **没有 `stream` 参数**：`generate`/`prompt` 都不支持真流式 → 只能**伪流式**
//     （与 hark/genspark 同套路：整段到达后由客户端面重新吐 SSE）
//   · **不下发 token / 费用**：`Session.Info.tokens` 与 `.cost` 在 generate 之后**恒为 0**，
//     `/message` 也是空数组（本机实测）→ 账本只能按字符估，**不假装有上游真值**
//   · **同一会话不保留多轮记忆**：turn2 拿不回 turn1 的信息（实测模型答"你没有让我回过口令"）
//     ⇒ **每请求把 messages 拍平成一个 prompt**，不依赖会话态
//   · **`/api/experimental/generate` 也是个陷阱**：它是个"无会话"的精简单发端点，看起来更省事，
//     但实测**回的是跟直连一模一样的免费层墙**
//     （`503 OpenCode's free tier can only be used from within OpenCode`）——
//     **只有 `/api/session` + `/api/session/{id}/generate` 这条会话路是被认可的**。
//     换成那个端点 = 把整条链路悄悄打回死路，且症状是一句很难归因的 503。
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

const DEFAULT_BASE = 'http://host.docker.internal:49551';
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
  const gen = await ocRequest(def, fetchFn, 'POST', `/api/session/${encodeURIComponent(ses.id)}/generate`,
    { prompt: String(prompt) }, tmo);
  // 先删会话再返回：文本已经在手里，先清理能保证"客户端中途断开"也不留垃圾会话
  try { await opencodeDeleteSession(def, fetchFn, ses.id, 10000); } catch { /* 删不掉不影响本轮 */ }
  if (!gen.ok) return { ok: false, status: gen.status, error: gen.status ? ocErrorText(gen.status, gen.text) : 'generate 连不上：' + gen.error, ms: Date.now() - t0 };
  const j = safeJson(gen.text);
  const text = j && j.data && typeof j.data.text === 'string' ? j.data.text : null;
  if (text === null) return { ok: false, status: gen.status, error: 'generate 形状不对（没有 data.text）：' + String(gen.text).slice(0, 120), ms: Date.now() - t0 };
  return { ok: true, status: gen.status, text, ms: Date.now() - t0 };
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
  flattenForOpencode,
  basicAuth,
  baseOf,
  PROVIDER_ID,
  DEFAULT_BASE,
  DEFAULT_USER,
  OC_DEFAULT_ALIAS,
};
