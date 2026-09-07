// tool-emu.js — 无原生 function calling 的渠道（notion / arena）的工具调用仿真
// 原理：把 OpenAI tools 数组注入 system 提示 + 尾部提醒（协议：[TOOL_CALL] 方括号
//       标记，兼容 ```json 围栏与裸 JSON），上游回复文本里解析出工具调用 → 还原成
//       OpenAI tool_calls 格式。
// MCP 客户端（Claude Desktop / DSH 等）发来的就是标准 tools 数组——网关支持 tools
// 字段后它们天然可用，无需任何 MCP 特殊处理。
'use strict';

const TAG_OPEN = '[TOOL_CALL]';
const TAG_CLOSE = '[/TOOL_CALL]';
const FENCE = '```';

// ─────────────────────────── 请求侧 ───────────────────────────

function toolCallId() {
  return 'call_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function stringifyTool(t) {
  const f = (t && t.function) || {};
  const params = f.parameters || {};
  const lines = [
    `### ${f.name || t.type || 'tool'}`,
    String(f.description || '').trim(),
    '参数 JSON Schema（arguments 必须是满足该 schema 的合法 JSON 对象）:',
    JSON.stringify(params),
  ];
  return lines.filter(Boolean).join('\n');
}

// 构建 tools 的注入提示。tool_choice: 'auto'|'none'|'required'|'any'|{type:'tool',name}
function buildToolSystemPrompt(tools, toolChoice) {
  const names = tools.map((t) => (t.function && t.function.name) || t.type).filter(Boolean);
  if (!names.length) return '';
  const mode = !toolChoice || toolChoice === 'auto' ? 'auto'
    : (toolChoice === 'required' || toolChoice === 'any') ? 'required'
      : (toolChoice && typeof toolChoice === 'object' && toolChoice.name) ? ('required:' + toolChoice.name)
        : 'auto';
  const force = mode === 'required' ? '本次回复你必须调用一个工具（不允许直接回答）。'
    : mode.startsWith('required:') ? `本次回复你必须调用工具 ${mode.slice('required:'.length)}（不允许直接回答）。`
      : '由你判断：需要外部信息或动作时必须调用工具（不要凭记忆猜测可查证的事实）；能直接回答时正常回答。';
  const ex = TAG_OPEN + '\n{"name": "工具名", "arguments": {"参数名": "值"}}\n' + TAG_CLOSE;
  return [
    '# 工具调用（外部工具，由调用方系统提供并执行）',
    '',
    '本环境为你接入了以下真实工具。工具由调用方系统实际执行：你输出调用标记，系统立即执行真实操作（真实的文件读写、命令运行、数据查询等），并把执行结果作为下一条用户消息回传给你。这不是模拟、不是文字游戏——你看到的每一条 [工具 X 的执行结果] 都是外部系统真实执行的结果。',
    '',
    '可用工具：',
    '',
    tools.map(stringifyTool).join('\n\n'),
    '',
    '## 调用格式（严格遵守）',
    '需要使用工具时，输出如下标记（每个调用一组，arguments 为参数对象）：',
    '',
    ex,
    '',
    '标记会由调用方系统解析并执行，你不需要（也无法）自己执行任何操作。',
    '',
    '## 判定规则',
    force,
    '输出工具调用标记后立即停止输出，等待工具结果回传后再继续。',
    '不要讨论、质疑或解释自己"是否真的能"使用工具——本环境的既定工作方式就是：需要时直接输出标记。',
    '不要输出其他任何方括号标记；不要编造不存在的工具；不要把工具调用写成 JSON 代码块，必须用上述标记。',
    '任务需要工具而你不输出标记（比如声称"没有工具"、要求用户自己粘贴文件内容），视为任务失败。',
  ].join('\n');
}

// 尾部提醒（对抗超长上下文注意力稀释：最后一条 user 消息末尾追加）
function buildTailReminder() {
  return '\n\n[提醒：若需调用工具，使用 ' + TAG_OPEN + ' {"name":"...","arguments":{...}} ' + TAG_CLOSE + ' 标记输出]';
}

// messages 里的 assistant.tool_calls / tool 角色 → 上游能理解的纯文本
function renderEmulatedMessages(messages, toolsPrompt) {
  const out = [];
  if (toolsPrompt) out.push({ role: 'system', content: toolsPrompt });
  const plain = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    const role = m.role;
    if (role === 'tool') {
      // 工具结果 → user 视角文本
      const name = String(m.name || m.tool_call_id || 'tool');
      let content = '';
      if (typeof m.content === 'string') content = m.content;
      else if (Array.isArray(m.content)) content = m.content.map((p) => (p && (typeof p === 'string' ? p : p.text)) || '').filter(Boolean).join('\n');
      plain.push({ role: 'user', content: `[工具 ${name} 的执行结果如下]\n${content}\n[请根据以上工具结果继续]` });
      continue;
    }
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const parts = [];
      const txt = typeof m.content === 'string' ? m.content : '';
      if (txt.trim()) parts.push(txt.trim());
      for (const tc of m.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function && tc.function.arguments || '{}'); } catch {}
        parts.push(TAG_OPEN + '\n' + JSON.stringify({ name: tc.function && tc.function.name, arguments: args }) + '\n' + TAG_CLOSE);
      }
      plain.push({ role: 'assistant', content: parts.join('\n\n') });
      continue;
    }
    // 普通消息：content 规约成 string（多模态部分取文本）
    let content = '';
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.map((p) => (typeof p === 'string' ? p : (p && p.type === 'text' && p.text) || '') || '').filter(Boolean).join('\n');
    plain.push({ role, content });
  }
  // 有工具提示时：最后一条 user 消息末尾追加提醒（近因效应，超长上下文关键）
  if (toolsPrompt) {
    for (let i = plain.length - 1; i >= 0; i--) {
      if (plain[i].role === 'user') {
        plain[i] = { ...plain[i], content: String(plain[i].content || '') + buildTailReminder() };
        break;
      }
    }
  }
  return [...out, ...plain];
}

// 入口：请求带 tools 且协议要仿真 → 返回 {messages, tools}；无 tools 返回 null。
function emulateRequest(body) {
  const tools = Array.isArray(body && body.tools) ? body.tools.filter((t) => t && (t.function || t.type)) : [];
  if (!tools.length) return null;
  const choice = body.tool_choice;
  if (choice === 'none') return null;
  const prompt = buildToolSystemPrompt(tools, choice);
  if (!prompt) return null;
  return { messages: renderEmulatedMessages(body.messages, prompt), tools };
}

// ─────────────────────────── 响应侧 ───────────────────────────

function extractCallsFromJson(parsed) {
  const calls = [];
  const pushOne = (name, args) => {
    if (typeof name !== 'string' || !name.trim()) return;
    calls.push({ name: name.trim(), arguments: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {} });
  };
  if (Array.isArray(parsed && parsed.tool_calls)) {
    for (const c of parsed.tool_calls) {
      if (c && typeof c === 'object') {
        if (c.function && typeof c.function === 'object') pushOne(c.function.name, c.function.arguments);
        else pushOne(c.name, c.arguments);
      }
    }
  } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    // 裸 {name, arguments} 形状：必须同时有 name 和参数键（arguments/args/parameters），
    // 否则 {"name":"config","port":8080} 这类普通 JSON 会被误判
    if (typeof parsed.name === 'string' && (parsed.arguments !== undefined || parsed.args !== undefined || parsed.parameters !== undefined)) {
      pushOne(parsed.name, parsed.arguments || parsed.args || parsed.parameters || {});
    }
  }
  return calls;
}

// 找出 text 中所有捕获区段（[TOOL_CALL] 标记 或 ```json 围栏），返回排序后的 span 列表
function findCaptureSpans(text) {
  const spans = [];
  let idx = -1;
  // 标记
  let from = 0;
  for (;;) {
    idx = text.indexOf(TAG_OPEN, from);
    if (idx < 0) break;
    const closeIdx = text.indexOf(TAG_CLOSE, idx + TAG_OPEN.length);
    if (closeIdx < 0) { from = idx + TAG_OPEN.length; continue; }
    spans.push({ start: idx, end: closeIdx + TAG_CLOSE.length, inner: text.slice(idx + TAG_OPEN.length, closeIdx).trim() });
    from = closeIdx + TAG_CLOSE.length;
  }
  // 围栏（```json ... ```）
  const fenceRe = /```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) spans.push({ start: m.index, end: m.index + m[0].length, inner: (m[1] || '').trim() });
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

// 连续相同调用去重：模型常在 thinking 段和 content 段重复输出同一调用
// （同 name + 同参数），会导致执行器重复执行（重复写入循环的成因之一）。
// 仅去重"紧邻的前一个"，合法的隔次重复调用不受影响。
function dedupeConsecutiveCalls(calls) {
  const out = [];
  let lastKey = null;
  for (const c of calls) {
    let argsStr;
    try { argsStr = JSON.stringify(c.arguments || {}); } catch { argsStr = String(c.arguments); }
    const key = (c.name || '') + '|' + argsStr;
    if (key === lastKey) continue;
    lastKey = key;
    out.push(c);
  }
  return out;
}

// 从文本中提取 emulated tool_calls。返回 {calls:[{name,arguments}], text} 或 null。
// text = 去掉工具调用区段后的剩余正文（作为 content 保留）。
function parseEmulatedToolCalls(text) {
  if (!text) return null;
  const spans = findCaptureSpans(text);
  let found = null;
  for (const sp of spans) {
    let parsed = null;
    try { parsed = JSON.parse(sp.inner); } catch { continue; }
    const calls = extractCallsFromJson(parsed);
    if (!calls.length) continue;
    if (found) found.calls.push(...calls);
    else found = { calls };
  }
  // 裸 JSON 兜底：整个回复就是一个 {name,arguments} / {tool_calls:[...]} JSON 对象
  if (!found) {
    const stripped = String(text).trim();
    if (stripped.startsWith('{') && stripped.endsWith('}')) {
      try {
        const parsed = JSON.parse(stripped);
        const calls = extractCallsFromJson(parsed);
        if (calls.length) found = { calls };
      } catch {}
    }
  }
  if (!found) return null;
  const deduped = dedupeConsecutiveCalls(found.calls);
  if (!deduped.length) return null;
  let content = '';
  let pos = 0;
  for (const sp of spans) { content += text.slice(pos, sp.start); pos = sp.end; }
  content += text.slice(pos);
  return { calls: deduped, text: content.trim() };
}

// ─────────────────────────── 流式扫描器 ───────────────────────────
// 边流边检测捕获区段（[TOOL_CALL] 标记优先 / ``` 围栏兜底）：
// 区段前的内容正常转发（content），区段闭合且解析为工具调用 → 一次性产出 tool_calls；
// 非工具区段原样转发（普通代码块不误伤）。
// 可能是区段开头的尾部字符会被 hold（暂缓转发）直到判定完成。
function createToolStreamScanner(onDelta, onToolCalls) {
  let buf = '';
  let sawTools = false;
  let lastCallKey = null; // 跨批次连续去重（thinking 段与 content 段重复输出同一调用）
  const MAX_HOLD = 65536;

  function emit(text) { if (text) onDelta(text); }

  // s（以 ` 或 [ 开头）是否是区段开头的未完成前缀 → 需等待更多数据
  function isPartialOpen(s) {
    if (!s) return false;
    if (s[0] === '`') {
      const run = s.match(/^`+/)[0].length;
      if (run >= 3) return false; // 完整围栏开头
      return s.length === run; // 1-2 个反引号且位于末尾 → 可能长成 ```
    }
    if (s[0] === '[') return TAG_OPEN.startsWith(s) && s.length < TAG_OPEN.length;
    return false;
  }

  // 捕获区段闭合处理：是工具调用 → onToolCalls；否则原样转发（保留代码块格式）
  // innerEnd/closeEnd 分别是内容终点/闭合标记终点（闭合标记本身不算内容）
  function handleCapture(innerStart, innerEnd, closeEnd) {
    const inner = buf.slice(innerStart, innerEnd).trim();
    const wrap = buf.slice(0, closeEnd);
    buf = buf.slice(closeEnd);
    let parsed = null;
    try { parsed = JSON.parse(inner); } catch {}
    const calls = parsed ? dedupeConsecutiveCalls(extractCallsFromJson(parsed)) : [];
    const fresh = calls.filter((c) => {
      let argsStr;
      try { argsStr = JSON.stringify(c.arguments || {}); } catch { argsStr = String(c.arguments); }
      const key = (c.name || '') + '|' + argsStr;
      if (key === lastCallKey) return false;
      lastCallKey = key;
      return true;
    });
    if (fresh.length) {
      sawTools = true;
      onToolCalls(fresh);
    } else if (!calls.length) {
      emit(wrap);
    } else {
      sawTools = true; // 全是紧邻重复调用：静默吞掉（已发过）
    }
  }

  // buf 末尾"可能是未完成标记开头"的长度（需 hold 等更多数据）
  function partialTailLen(s) {
    // 末尾连续反引号（1-2 个，可能长成 ```）
    const m = s.match(/`{1,2}$/);
    if (m) return m[0].length;
    // 末尾 [ 开头能匹配 TAG_OPEN 前缀的片段（如 "[TOOL"、"["）
    const open = s.match(/\[[A-Z_]{0,10}$/);
    if (open && TAG_OPEN.startsWith(open[0])) return open[0].length;
    return 0;
  }

  function drain() {
    for (;;) {
      if (!buf) return;
      // 捕获模式 1：[TOOL_CALL] 标记
      if (buf.startsWith(TAG_OPEN)) {
        const closeIdx = buf.indexOf(TAG_CLOSE, TAG_OPEN.length);
        if (closeIdx >= 0) handleCapture(TAG_OPEN.length, closeIdx, closeIdx + TAG_CLOSE.length);
        else if (buf.length > MAX_HOLD) { emit(buf); buf = ''; } else return;
        continue;
      }
      // 捕获模式 2：``` 围栏
      if (buf.startsWith(FENCE)) {
        const closeIdx = buf.indexOf(FENCE, 3);
        if (closeIdx >= 0) handleCapture(3, closeIdx, closeIdx + 3);
        else if (buf.length > MAX_HOLD) { emit(buf); buf = ''; } else return;
        continue;
      }
      // 非捕获：找最早的区段开头；末尾未完成前缀先 hold 住不输出
      const tagIdx = buf.indexOf(TAG_OPEN);
      const fenceIdx = buf.indexOf(FENCE);
      const tailLen = partialTailLen(buf);
      let cut = buf.length - tailLen;
      if (tagIdx >= 0) cut = Math.min(cut, tagIdx);
      if (fenceIdx >= 0) cut = Math.min(cut, fenceIdx);
      if (cut > 0) { emit(buf.slice(0, cut)); buf = buf.slice(cut); continue; }
      // buf 全是未完成前缀（或无进展）→ hold
      if (buf && !tailLen) {
        // buf[0] 确定不是标记开头（如单个 '[' 后跟小写）→ 至少放行 1 字符防死循环
        if (!isPartialOpen(buf)) { emit(buf[0]); buf = buf.slice(1); continue; }
      }
      return;
    }
  }

  return {
    push(chunk) { buf += chunk; drain(); },
    end() {
      if (buf) {
        const parsed = parseEmulatedToolCalls(buf);
        if (parsed && parsed.calls.length) { sawTools = true; onToolCalls(parsed.calls); }
        else emit(buf);
        buf = '';
      }
      return { sawTools };
    },
  };
}

// OpenAI tool_calls 响应体构造
function openaiToolCallsPayload(respId, model, calls, content) {
  return {
    id: respId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        ...(content ? { content } : { content: null }),
        tool_calls: calls.map((c, i) => ({
          id: toolCallId() + '_' + i,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
        })),
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

module.exports = {
  emulateRequest,
  parseEmulatedToolCalls,
  createToolStreamScanner,
  openaiToolCallsPayload,
  toolCallId,
  // 调试/诊断用：直接取注入的协议提示词原文
  buildToolSystemPrompt,
  buildTailReminder,
};
