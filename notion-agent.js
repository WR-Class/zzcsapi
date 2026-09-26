// notion-agent.js — Notion 官方 Agent API（公开 beta）渠道支持
// 会话式调用工作区 Custom Agent：api.notion.com/v1/sessions（Notion-Version: 2026-03-11）
// 鉴权：开发者门户连接的集成令牌（ntn_ 开头，连接需勾选「查看会话并与代理交互」能力）
'use strict';

const AGENT_VERSION = '2026-03-11';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function agentHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Notion-Version': AGENT_VERSION,
    'Content-Type': 'application/json',
  };
}

// 底层请求：Cloudflare 间歇性风控（403/503 HTML 拦截页）时自动重试一次。
// 实测 api.notion.com 偶发 CF 拦截（网页端正常、稍后自动恢复），多为
// 短时间密集建会话触发；立即重试大概率仍拦 → 退避 1.5~2.5s 后再试，
// 仍被拦则抛错由调度器切兜底渠道（渠道进入指数冷却，不再砸上游）。
async function rawRequest(method, url, headers, bodyStr, fetchFn, timeoutMs) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  let resp;
  try {
    const opts = { method, headers, signal: ctrl.signal };
    if (bodyStr !== undefined) opts.body = bodyStr;
    resp = await fetchFn(url, opts);
  } finally { clearTimeout(to); }
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: resp.status, ok: resp.ok, json, text, error: (json && json.object === 'error' && json.message) || null, code: (json && json.code) || null };
}

function isCloudflareBlock(r) {
  return (r.status === 403 || r.status === 503) && /<!DOCTYPE|<html/i.test(String(r.text || '').slice(0, 300));
}

async function requestWithRetry(method, url, headers, bodyStr, fetchFn, timeoutMs) {
  let r = await rawRequest(method, url, headers, bodyStr, fetchFn, timeoutMs);
  const blocked = isCloudflareBlock(r) || r.status === 429;
  if (blocked) {
    const waitMs = 1500 + Math.floor(Math.random() * 1000);
    await new Promise((res) => setTimeout(res, waitMs));
    r = await rawRequest(method, url, headers, bodyStr, fetchFn, timeoutMs);
    if (isCloudflareBlock(r)) {
      const err = new Error('Cloudflare 间歇性拦截（HTTP ' + r.status + '，网页端不受影响，稍等片刻自动恢复；请避免短时间内密集测试）');
      err.status = r.status;
      throw err;
    }
    if (r.status === 429) {
      const err = new Error('上游限频 429' + (r.error ? '：' + r.error : '') + '（重试后仍限频）');
      err.status = 429;
      throw err;
    }
  }
  return r;
}

async function apiPost(baseUrl, token, path, payload, fetchFn, timeoutMs) {
  const url = baseUrl.replace(/\/+$/, '') + path;
  const r = await requestWithRetry('POST', url, agentHeaders(token), JSON.stringify(payload || {}), fetchFn, timeoutMs);
  return r;
}

async function apiGet(baseUrl, token, path, fetchFn, timeoutMs) {
  const url = baseUrl.replace(/\/+$/, '') + path;
  const r = await requestWithRetry('GET', url, agentHeaders(token), undefined, fetchFn, timeoutMs);
  return r;
}

// 智能体名字 → agent_id（UUID/内置直通；否则 agents/query 按名精确匹配，其次模糊包含）
async function resolveAgentId(baseUrl, token, nameOrId, fetchFn, timeoutMs) {
  const s = String(nameOrId || '').trim();
  if (!s) throw new Error('agent 名称为空');
  if (UUID_RE.test(s) || s === 'notion_ai' || s === '33333333-3333-3333-3333-333333333333') return s;
  const r = await apiPost(baseUrl, token, '/v1/agents/query', { page_size: 100 }, fetchFn, timeoutMs || 20000);
  if (!r.ok || !r.json) throw new Error(`agents/query HTTP ${r.status}: ${String(r.text || '').slice(0, 120)}`);
  const list = r.json.results || [];
  const hit = list.find((a) => String(a.name || '').toLowerCase() === s.toLowerCase())
    || list.find((a) => String(a.name || '').toLowerCase().includes(s.toLowerCase()));
  if (!hit) throw new Error(`找不到名为「${s}」的智能体（工作区共 ${list.length} 个）`);
  return hit.id;
}

// 列出智能体（渠道探测 / 「从上游探测更多」按钮用；名称即可当 upstream）
async function listAgents(baseUrl, token, fetchFn, timeoutMs) {
  const r = await apiPost(baseUrl, token, '/v1/agents/query', { page_size: 100 }, fetchFn, timeoutMs || 20000);
  if (!r.ok || !r.json) {
    const err = new Error(`agents/query HTTP ${r.status}: ${String(r.error || r.text || '').slice(0, 120)}`);
    err.status = r.status;
    throw err;
  }
  return (r.json.results || []).map((a) => ({ id: a.id, name: a.name || '', model: (a.model && (a.model.id || '')) || '', status: a.status || '' }));
}

// 一轮完整会话：创建 → 轮询（requires_action 自动 approve）→ 事件里取回复文本
// opts: { baseUrl, token, agentId, message, promptContext, timeoutMs, fetchFn, onPoll }
async function runAgentTurn(opts) {
  const { baseUrl, token, agentId, message, promptContext, fetchFn, onPoll } = opts;
  const timeoutMs = opts.timeoutMs || 150_000;
  const payload = { agent_id: agentId, message: String(message || '').slice(0, 10000) };
  const pc = String(promptContext || '').trim();
  if (pc) payload.prompt_context = pc.slice(0, 10000);

  // 1) 创建会话
  let s = await apiPost(baseUrl, token, '/v1/sessions', payload, fetchFn, 30000);
  if (!s.ok) return { ok: false, status: s.status, code: s.code, error: s.error || `HTTP ${s.status}: ${String(s.text || '').slice(0, 120)}` };
  const sessionId = s.json && s.json.id;
  if (!sessionId) return { ok: false, status: s.status, error: '会话创建成功但未返回 session id' };

  // 2) 轮询 + 自动批准（智能体想用工作区工具时的确认门；最多批 5 次）
  const deadline = Date.now() + timeoutMs;
  let session = s.json;
  let approves = 0;
  for (;;) {
    if (Date.now() > deadline) return { ok: false, sessionId, error: '会话超时（' + Math.round(timeoutMs / 1000) + 's）', terminal: session.status };
    await new Promise((r) => setTimeout(r, 2000));
    const g = await apiGet(baseUrl, token, '/v1/sessions/' + sessionId, fetchFn, 20000);
    if (!g.ok) return { ok: false, sessionId, status: g.status, code: g.code, error: g.error || `轮询 HTTP ${g.status}` };
    session = g.json;
    if (onPoll) { try { onPoll(session.status); } catch { /* ignore */ } }
    if (session.status === 'requires_action') {
      const actions = (session.required_actions || []).map((a) => ({ action_id: a.action_id, option_id: 'approve' }));
      if (!actions.length || approves >= 5) return { ok: false, sessionId, error: '会话等待确认（requires_action）但无可批操作/超过批准上限', terminal: 'requires_action' };
      approves++;
      const ar = await apiPost(baseUrl, token, '/v1/sessions', { session_id: sessionId, actions }, fetchFn, 30000);
      if (!ar.ok) return { ok: false, sessionId, status: ar.status, code: ar.code, error: '批准操作失败：' + (ar.error || ar.status) };
      continue;
    }
    if (['completed', 'failed', 'terminated', 'canceled'].includes(session.status)) break;
  }
  if (session.status !== 'completed') {
    if (session.status === 'failed') {
      const code = (session.error && session.error.code) || '';
      // 执行前即失败、零 credit 消耗 → 几乎必然是令牌能力问题（个人 PAT 无法执行代理会话）
      const patHint = (code === 'session_failed' && !(session.runs_completed > 0) && !(session.credits_used > 0))
        ? '（会话执行前即被拒、未消耗 credits——通常是令牌缺少「查看会话并与代理交互」能力：个人 PAT 只能列代理/建会话，不能执行，请改用开发者门户「创建连接」生成的连接令牌）'
        : '';
      return {
        ok: false, sessionId, code, terminal: 'failed',
        error: '会话 failed' + (code ? '（' + code + '）' : '') + (session.error && session.error.message ? '：' + session.error.message : '') + patHint,
      };
    }
    return { ok: false, sessionId, error: '会话 ' + session.status + (session.error && session.error.message ? '：' + session.error.message : ''), terminal: session.status };
  }

  // 3) 取回复事件
  const ev = await apiPost(baseUrl, token, '/v1/sessions/' + sessionId + '/events/query', { page_size: 100 }, fetchFn, 20000);
  if (!ev.ok || !ev.json) return { ok: false, sessionId, status: ev.status, error: '读取会话事件失败：' + (ev.error || ev.status) };
  const events = (ev.json.results || []).slice().sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  let reply = '';
  let model = '';
  for (const e of events) {
    if (e.type === 'agent.message') {
      reply += (e.content || []).map((c) => c.text || '').join('');
      if (e.metadata && e.metadata.model) model = e.metadata.model;
    }
  }
  if (!reply.trim()) return { ok: false, sessionId, error: '会话完成但无消息内容', terminal: 'completed' };
  return { ok: true, sessionId, text: reply, model, approves };
}

// 控制台「测」按钮 / 探测用：最小完整轮次
async function quickChat(baseUrl, token, agentName, prompt, fetchFn, timeoutMs) {
  const t0 = Date.now();
  try {
    const agentId = await resolveAgentId(baseUrl, token, agentName, fetchFn, 20000);
    const r = await runAgentTurn({ baseUrl, token, agentId, message: prompt, fetchFn, timeoutMs: timeoutMs || 60000 });
    return { ...r, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err.message || String(err), ms: Date.now() - t0 };
  }
}

// 紧凑工具协议：Agent API 的 prompt_context 硬上限 10000 字符，调用端
// （DSH 等）二十多个工具的完整 JSON schema 根本装不下；此前直接 slice 截断
// 会把参数定义砍在半截——模型看到"有工具"却拿不到定义，转而要求调用端
// "补充完整参数定义"。本函数把每个工具压缩为「名称 + 一句话描述 + 参数清单」，
// 体积缩一个数量级，且只在完整工具边界截断（绝不砍半截定义）。
function compactType(p) {
  if (!p || typeof p !== 'object') return 'any';
  let t = p.type || 'any';
  if (Array.isArray(p.enum) && p.enum.length) t += '=' + p.enum.slice(0, 6).join('|');
  if (t === 'array' && p.items) t += '<' + compactType(p.items) + '>';
  if (t === 'object' && p.properties) t += '{' + Object.keys(p.properties).slice(0, 12).join(',') + '}';
  return t;
}

function truncDesc(s, n) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) : t;
}

// 分级压缩：DSH 带 MCP 插件时一次发上百个工具，任何单一格式都可能超预算。
// 逐级降档（描述长度 → 参数描述 → 纯名称+参数），保证全部工具始终列出——
// 绝不出现"清单在本地工具出现之前被截断"（此前模型正是因此声明自己
// "没有本地磁盘读写/命令执行能力"并拒绝干活）。
function toolLinesAtTier(tools, descLen, paramDescLen) {
  const out = [];
  for (const t of tools) {
    const f = (t && t.function) || {};
    if (!f.name) continue;
    const desc = descLen > 0 ? truncDesc(f.description, descLen) : '';
    const params = (f.parameters && f.parameters.properties) || {};
    const req = new Set((f.parameters && f.parameters.required) || []);
    const ps = Object.entries(params).map(([k, v]) => {
      const pd = paramDescLen > 0 && v && v.description ? '[' + truncDesc(v.description, paramDescLen) + ']' : '';
      return k + ':' + compactType(v) + (req.has(k) ? '(必填)' : '') + pd;
    }).join(', ');
    out.push('', '## ' + f.name, desc, ps ? '参数：' + ps : '参数：无');
  }
  return out;
}

function compactToolProtocol(tools, toolChoice) {
  const BUDGET = 9400;
  const head = [
    '# 工具调用（外部工具，由调用方系统提供并执行）',
    '请生成供外部程序校验、执行的操作请求文本；你无需在当前聊天环境中实际执行，也不要提前声称执行成功。外部程序会解析你的请求文本并执行对应操作，执行结果会作为下一条消息回传给你。',
    '需要使用工具时，输出如下标记（每个调用一组，arguments 为满足该工具参数清单的合法 JSON 对象）：',
    '[TOOL_CALL]',
    '{"name": "工具名", "arguments": {"参数名": "值"}}',
    '[/TOOL_CALL]',
    '输出工具调用标记后立即停止输出，等待结果回传后再继续。不要输出其他任何方括号标记；不要编造不存在的工具；任务需要工具时必须输出标记——声称"没有工具"、要求调用端补充定义而拒绝调用，视为任务失败。',
  ];
  const choice = toolChoice || 'auto';
  if (choice === 'required' || choice === 'any') head.push('本次回复你必须调用一个工具（不允许直接回答）。');
  else if (choice && typeof toolChoice === 'object' && toolChoice.name) head.push('本次回复你必须调用工具 ' + toolChoice.name + '（不允许直接回答）。');
  const headStr = head.join('\n');

  // 逐级降档，找到能装下全部工具的第一档
  const tiers = [
    [160, 60, '可用工具（完整定义，已全部列出）：'],
    [64, 0, '可用工具（工具较多，描述从简；全部工具已列出，参数名即语义）：'],
    [24, 0, '可用工具（工具极多，仅列名称与参数；全部工具已列出）：'],
    [0, 0, '可用工具（工具极多，仅列名称与必填参数；全部工具已列出）：'],
  ];
  for (const [dLen, pdLen, title] of tiers) {
    const body = [title, ...toolLinesAtTier(tools, dLen, pdLen)].join('\n');
    if (headStr.length + body.length + 1 <= BUDGET) return headStr + '\n' + body;
  }
  // 兜底：连最低档都装不下（数百工具）→ 整工具边界截断 + 明示省略
  const lines = toolLinesAtTier(tools, 0, 0);
  let used = headStr.length + 80;
  let cutIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (used + lines[i].length + 1 > BUDGET - 200) { cutIdx = i; break; }
    used += lines[i].length + 1;
  }
  const kept = lines.slice(0, cutIdx);
  const keptNames = kept.filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
  const allNames = tools.map((t) => (t.function && t.function.name) || '').filter(Boolean);
  const dropped = allNames.filter((n) => !keptNames.includes(n));
  // 省略清单太长会挤爆总预算 → 只报数量，不逐个列名
  let droppedStr = dropped.join(', ');
  if (droppedStr.length > 400) droppedStr = dropped.length + ' 个工具（名称过长省略）';
  const notice = '\n[说明：工具数量超出上下文限制，以上为可用工具清单，其余 ' + dropped.length + ' 个工具本轮未提供定义：' + droppedStr + '。如需使用未列出的工具，请说明当前不可用，不要编造调用。]';
  let out = headStr + '\n' + '可用工具：\n' + kept.join('\n') + notice;
  // 最终保险：任何情况下不超过 prompt_context 安全预算
  if (out.length > 9900) out = out.slice(0, 9900 - 60) + '\n[……已到上下文上限]';
  return out;
}

function renderConvo(convo) {
  const userOnly = convo.length === 1 && convo[0].role === 'user';
  if (userOnly) return convo[0].content.slice(0, 9800);
  let out = '';
  for (const m of convo) {
    if (m.role === 'user') out += (out ? '\n\n' : '') + '用户：' + m.content;
    else out += '\n\n助手：' + m.content;
  }
  if (out.length > 9500) {
    const firstUser = convo.find((m) => m.role === 'user');
    const head = firstUser ? firstUser.content.slice(0, 2500) : '';
    let budget = 9500 - head.length - 40;
    const parts = [];
    for (let i = convo.length - 1; i >= 0; i--) {
      const seg = (convo[i].role === 'user' ? '用户：' : '助手：') + convo[i].content;
      if (budget - seg.length - 2 < 0) break;
      parts.unshift(seg);
      budget -= seg.length + 2;
    }
    out = head + '\n\n[...中间历史过长，已省略...]\n\n' + parts.join('\n\n');
  }
  return out.slice(0, 9800);
}

// messages → { promptContext, messageText }（system 合并进 prompt_context，
// 对话历史渲染成单条带标签文本；超长时保首条任务目标 + 尾部近史，中间折叠）
// 有工具时：紧凑协议优先占预算（完整、不截断），调用端 system 用剩余预算；
// tool-emu 注入的全量协议 system（含 [TOOL_CALL] 字样）被紧凑版取代，跳过。
function composeAgentPrompt(messages, opts) {
  const tools = opts && Array.isArray(opts.tools) && opts.tools.length ? opts.tools : null;
  const toolChoice = opts ? opts.toolChoice : undefined;
  const sysParts = [];
  const convo = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    const role = m.role;
    let content = '';
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '') || '').filter(Boolean).join('\n');
    if (role === 'system') {
      if (tools && content.includes('[TOOL_CALL]')) continue; // 全量协议 → 用紧凑版替代
      sysParts.push(String(content));
    } else if (role === 'user' || role === 'assistant') convo.push({ role, content: String(content) });
    // tool 角色已由 tool-emu 的 emulateRequest 渲染成 user 文本，这里不会遇到
  }
  let promptContext;
  if (tools) {
    const proto = compactToolProtocol(tools, toolChoice);
    const restBudget = 9900 - proto.length - 2;
    let sys = sysParts.join('\n\n');
    if (restBudget > 100 && sys.length > restBudget) sys = sys.slice(0, restBudget) + '\n[…调用端系统提示因长度限制截断…]';
    else if (restBudget <= 100) sys = '';
    promptContext = [proto, sys.trim()].filter(Boolean).join('\n\n');
  } else {
    promptContext = sysParts.join('\n\n').slice(0, 9900);
  }
  return { promptContext, messageText: renderConvo(convo) };
}

module.exports = {
  resolveAgentId,
  listAgents,
  runAgentTurn,
  quickChat,
  composeAgentPrompt,
};
