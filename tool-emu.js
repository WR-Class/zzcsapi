// tool-emu.js — 无原生 function calling 的渠道（notion / arena）的工具调用仿真
// 原理：把 OpenAI tools 数组注入 system 提示（协议约定模型输出独立 ```json 围栏的
//       tool_calls），上游回复文本里解析出工具调用 → 还原成 OpenAI tool_calls 格式。
// MCP 客户端（Claude Desktop / DSH 等）发来的就是标准 tools 数组——网关支持 tools
// 字段后它们天然可用，无需任何 MCP 特殊处理。
'use strict';

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
    '参数 JSON Schema（严格遵守，output 必须是合法参数 JSON 对象）:',
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
  const force = mode === 'required' ? '本次回复你必须调用一个工具。'
    : mode.startsWith('required:') ? `本次回复你必须调用工具 ${mode.slice('required:'.length)}。`
      : '由你判断：需要外部信息或动作时调用工具；能直接回答时正常回答。';
  return [
    '# 工具调用协议（严格遵守）',
    '',
    '你可以调用以下外部工具。工具清单：',
    '',
    tools.map(stringifyTool).join('\n\n'),
    '',
    '## 调用格式',
    '决定调用工具时，回复中必须包含一个独立的 json 代码围栏，且只包含这一个围栏：',
    '```json',
    '{"tool_calls": [{"name": "<工具名>", "arguments": {<参数对象>}}]}',
    '```',
    '多个工具可并列在 tool_calls 数组中。围栏之外可以有简短说明文字。',
    '',
    '## 判定',
    force,
    '除工具调用围栏外，不要输出任何其他 json 围栏。',
    '调用工具后立即停止（等待工具结果）；工具结果会以用户消息形式回传，再继续。',
  ].join('\n');
}

// messages 里的 assistant.tool_calls / tool 角色 → 上游能理解的纯文本
function renderEmulatedMessages(messages, toolsPrompt) {
  const out = [];
  if (toolsPrompt) out.push({ role: 'system', content: toolsPrompt });
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    const role = m.role;
    if (role === 'tool') {
      // 工具结果 → user 视角文本（含结果引用）
      const name = String(m.name || m.tool_call_id || 'tool');
      let content = '';
      if (typeof m.content === 'string') content = m.content;
      else if (Array.isArray(m.content)) content = m.content.map((p) => (p && (typeof p === 'string' ? p : p.text)) || '').filter(Boolean).join('\n');
      out.push({ role: 'user', content: `[工具 ${name} 的执行结果如下]\n${content}\n[请根据以上工具结果继续]` });
      continue;
    }
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const parts = [];
      const txt = typeof m.content === 'string' ? m.content : '';
      if (txt.trim()) parts.push(txt.trim());
      for (const tc of m.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function && tc.function.arguments || '{}'); } catch {}
        parts.push('```json\n{"tool_calls": [{"name": ' + JSON.stringify(tc.function && tc.function.name) + ', "arguments": ' + JSON.stringify(args) + '}]}\n```');
      }
      out.push({ role: 'assistant', content: parts.join('\n\n') });
      continue;
    }
    // 普通消息：content 规约成 string（多模态部分取文本）
    let content = '';
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.map((p) => (typeof p === 'string' ? p : (p && p.type === 'text' && p.text) || '') || '').filter(Boolean).join('\n');
    out.push({ role, content });
  }
  return out;
}

// 入口：请求带 tools 且协议要仿真 → 返回 {messages, tools}（消息已注入协议提示）；
// 无 tools 返回 null（原样走）。
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

const FENCE_RE = /```(?:json|JSON)?\s*\n([\s\S]*?)\n?```/g;

// 从文本中提取 emulated tool_calls。返回 {calls:[{name,arguments}]},text} 或 null
// text = 去掉工具围栏后的剩余正文（作为 content 保留）。
function parseEmulatedToolCalls(text) {
  if (!text) return null;
  let m;
  let found = null;
  let rest = text;
  const fenceSpans = [];
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const inner = (m[1] || '').trim();
    let parsed = null;
    try { parsed = JSON.parse(inner); } catch { continue; }
    const calls = extractCallsFromJson(parsed);
    if (!calls.length) continue;
    if (found) { found.calls.push(...calls); }
    else { found = { calls }; }
    fenceSpans.push([m.index, m.index + m[0].length]);
  }
  if (!found) return null;
  // 去掉命中的围栏，剩余做正文
  let content = '';
  let pos = 0;
  for (const [s, e] of fenceSpans) { content += text.slice(pos, s); pos = e; }
  content += text.slice(pos);
  return { calls: found.calls, text: content.trim() };
}

function extractCallsFromJson(parsed) {
  const calls = [];
  const pushOne = (name, args) => {
    if (typeof name !== 'string' || !name.trim()) return;
    calls.push({ name: name.trim(), arguments: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {} });
  };
  if (Array.isArray(parsed && parsed.tool_calls)) {
    for (const c of parsed.tool_calls) {
      if (c && typeof c === 'object') {
        // {name, arguments} 或 {function:{name, arguments}}
        if (c.function && typeof c.function === 'object') pushOne(c.function.name, c.function.arguments);
        else pushOne(c.name, c.arguments);
      }
    }
  } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (typeof parsed.name === 'string') pushOne(parsed.name, parsed.arguments || parsed.args || parsed.parameters || {});
  }
  return calls;
}

// ─────────────────────────── 流式扫描器 ───────────────────────────
// 边流边检测 ```json 围栏：围栏起始前的内容正常转发（content），
// 围栏闭合且解析为工具调用 → 一次性产出 tool_calls。
// 流式中"可能是围栏开头"的尾部字符会被 hold（暂缓转发）直到判定完成。
//
// onDelta(text)：正文增量（可安全直接转发给客户端）
// onToolCalls(calls)：工具调用产出（每个 call 一次性完整产出）
// done()：流结束；返回 {sawTools:bool}
function createToolStreamScanner(onDelta, onToolCalls) {
  let buf = ''; // 未判定的尾部缓冲（含可能的围栏开头）
  let flushed = true; // buf 之外是否全部已转发
  let sawTools = false;
  const FENCE_OPEN = '```';
  const FENCE_CLOSE_RE = /```/;

  // 尝试从 buf 里解析一个完整围栏；成功 → true（buf 被消费到围栏结束）
  function tryParseFence() {
    if (!buf.startsWith(FENCE_OPEN)) return false;
    // 找闭合 ```
    const closeIdx = buf.indexOf(FENCE_OPEN, 3);
    if (closeIdx < 0) {
      // 未闭合：围栏可能还在增长。防止无限 hold：超长（16KB）且无闭合 → 放弃当文本
      if (buf.length > 16384) return false;
      return true; // hold 住（等更多数据）
    }
    const inner = buf.slice(3, closeIdx).replace(/^(?:json|JSON)?\s*\n/, '').replace(/\n?$/, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(inner); } catch {}
    const calls = parsed ? extractCallsFromJson(parsed) : [];
    buf = buf.slice(closeIdx + 3);
    if (calls.length) {
      sawTools = true;
      onToolCalls(calls);
      // 围栏后可能还有正文（模型继续唠叨）——继续走正文路径
      flushSafe();
      return true;
    }
    // 不是工具调用的围栏 → 原样输出（含围栏本身）
    onDelta('```' + buf.slice(3, closeIdx + 3));
    buf = buf.slice(closeIdx + 3);
    flushSafe();
    return true;
  }

  // 把 buf 里"确定安全"的部分转发：截止到最后一个可能的围栏前缀位置
  function flushSafe() {
    if (!buf) return;
    // 找最后一个 '`' 序列起点（可能是 ``` 开头的开头）
    // 检查所有 ` 连续段，长度<3 且之后字符不足以判定时 hold
    let safeEnd = buf.length;
    for (let i = buf.length - 2; i >= 0; i--) {
      if (buf[i] === '`') {
        // 从 i 开始的连续反引号
        let j = i;
        while (j < buf.length && buf[j] === '`') j++;
        const run = buf.slice(i, j);
        if (run.length >= 3) { safeEnd = i; break; } // 完整 ``` 出现在中间 → 截到这里（后续按围栏处理）
        // 不完整反引号段且在末尾 → hold
        if (j >= buf.length) { safeEnd = i; break; }
        // 中间的短反引号（单个/双个）→ 正文，继续往前找
      }
    }
    if (safeEnd > 0) {
      onDelta(buf.slice(0, safeEnd));
      buf = buf.slice(safeEnd);
    }
  }

  return {
    push(chunk) {
      buf += chunk;
      if (buf.startsWith(FENCE_OPEN)) {
        // 正在围栏内：等闭合或放弃
        if (!tryParseFence()) {
          // 超长无闭合 → 放弃，全当正文
          onDelta(buf); buf = '';
        }
        return;
      }
      flushSafe();
      // flush 后 buf 若以 ``` 开头 → 进围栏判定（下轮 push 或这里直接试）
      if (buf.startsWith(FENCE_OPEN)) {
        if (!tryParseFence()) { onDelta(buf); buf = ''; }
      }
    },
    end() {
      // 流结束：残留 buf 当正文
      if (buf) {
        if (!sawTools) {
          // 尝试最后的围栏/裸 JSON 兜底
          const parsed = parseEmulatedToolCalls(buf);
          if (parsed && parsed.calls.length) {
            sawTools = true;
            onToolCalls(parsed.calls);
          } else { onDelta(buf); }
        } else { onDelta(buf); }
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
};
