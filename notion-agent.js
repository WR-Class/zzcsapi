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

async function apiPost(baseUrl, token, path, payload, fetchFn, timeoutMs) {
  const url = baseUrl.replace(/\/+$/, '') + path;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  let resp;
  try {
    resp = await fetchFn(url, { method: 'POST', headers: agentHeaders(token), body: JSON.stringify(payload || {}), signal: ctrl.signal });
  } finally { clearTimeout(to); }
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: resp.status, ok: resp.ok, json, text, error: (json && json.object === 'error' && json.message) || null, code: (json && json.code) || null };
}

async function apiGet(baseUrl, token, path, fetchFn, timeoutMs) {
  const url = baseUrl.replace(/\/+$/, '') + path;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  let resp;
  try {
    resp = await fetchFn(url, { method: 'GET', headers: agentHeaders(token), signal: ctrl.signal });
  } finally { clearTimeout(to); }
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: resp.status, ok: resp.ok, json, text, error: (json && json.object === 'error' && json.message) || null, code: (json && json.code) || null };
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

// messages → { promptContext, messageText }（system 合并进 prompt_context，
// 对话历史渲染成单条带标签文本；超长时保首条任务目标 + 尾部近史，中间折叠）
function composeAgentPrompt(messages) {
  const sysParts = [];
  const convo = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    const role = m.role;
    let content = '';
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '') || '').filter(Boolean).join('\n');
    if (role === 'system') sysParts.push(String(content));
    else if (role === 'user' || role === 'assistant') convo.push({ role, content: String(content) });
    // tool 角色已由 tool-emu 的 emulateRequest 渲染成 user 文本，这里不会遇到
  }
  const promptContext = sysParts.join('\n\n').slice(0, 9900);
  return { promptContext, messageText: renderConvo(convo) };
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

module.exports = {
  resolveAgentId,
  listAgents,
  runAgentTurn,
  quickChat,
  composeAgentPrompt,
};
