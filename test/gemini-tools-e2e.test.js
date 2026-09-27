#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/gemini-tools-e2e.test.js — Gemini 客户端路由的工具调用（真起进程，零依赖）
 *                                                                    PT33 的端到端回归
 *
 * 单元回归（test/gemini-tools.test.js）证明"三个转换函数各自对不对"；
 * 这个文件证明"整条 HTTP 链路真的通"：Gemini 原生 SDK 形状的请求 → `/gemini/v1beta/...`
 * → 临时网关 → **OpenAI 协议**假上游（PT33 明说这与渠道协议无关，openai 渠道同样如此）
 * → 再翻回 Gemini 形状给客户端。两轮工具回合（要工具 → 回传结果）+ 流式 + 三态 toolConfig。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/gemini-tools-e2e.test.js   （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-gtools-e2e-'));
const GW_KEY = 'gt-gw', AD_KEY = 'gt-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 260) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/* 假上游（OpenAI 协议）：把收到的请求体记下来给断言看；回复形状由 state.mode 决定 */
function makeUpstream(state) {
  return http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}'); } catch { }
      state.lastBody = body;
      state.requests.push(body);
      const sse = /stream/.test(req.url) || body.stream === true;
      if (!sse) {
        if (state.mode === 'tool') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            id: 'chatcmpl-t', object: 'chat.completion', model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_upstream_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
          }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'chatcmpl-t', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: '上海 31 度' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
        }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const frame = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const base = { id: 'chatcmpl-t', object: 'chat.completion.chunk', model: body.model };
      if (state.mode === 'tool') {
        frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '我查一下' } }] });
        frame({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_upstream_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] });
        frame({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }] });
        frame({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"上海"}' } }] } }] });
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } });
      } else {
        frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '上海' } }] });
        frame({ ...base, choices: [{ index: 0, delta: { content: ' 31 度' } }] });
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
}

(async () => {
  const UP = await freePort(), GW = await freePort();
  const state = { mode: 'text', requests: [], lastBody: null };
  const upstream = makeUpstream(state);
  await new Promise((r) => upstream.listen(UP, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'c.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 2000 }, retries: { perChannel: 0, maxModelFallbacks: 5 },
    channels: [{ id: 'gt-up', name: 'Up', baseUrl: `http://127.0.0.1:${UP}/v1`, apiKey: 'sk-up', protocol: 'openai', priority: 10, enabled: true, models: { 'gemini-2.5-pro': 'gpt-x' } }],
  }));

  const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'u.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
    stdio: 'ignore',
  });
  const stopChild = (cp) => new Promise((res) => {
    if (!cp || cp.exitCode !== null || cp.signalCode !== null) return res();
    cp.once('exit', () => res());
    try { cp.kill(); } catch { }
    setTimeout(res, 1500);
  });

  const url = (action) => `http://127.0.0.1:${GW}/gemini/v1beta/models/gemini-2.5-pro:${action}?key=${GW_KEY}`;
  const gen = async (body, action = 'generateContent') => {
    const r = await fetch(url(action), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (action === 'streamGenerateContent') {
      const text = await r.text();
      const frames = text.split(/\n/).filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean);
      return { code: r.status, frames, text, ch: r.headers.get('x-zzcsapi-channel') };
    }
    let j = null; try { j = await r.json(); } catch { }
    return { code: r.status, body: j, ch: r.headers.get('x-zzcsapi-channel') };
  };
  const TOOLS = [{ functionDeclarations: [{ name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } }, { name: 'get_time', description: '查时间', parameters: { type: 'object', properties: {} } }] }];

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${GW}/healthz`)).ok; } catch { await sleep(150); } }
    check('临时网关起来了', up);
    if (!up) throw new Error('网关未启动');

    /* ══════════ 1. 非流式：要工具 → 客户端拿到 functionCall ══════════ */
    console.log('\n1. 非流式工具回合：Gemini 客户端声明 tools → 上游收到 OpenAI tools → 客户端拿到 functionCall');
    {
      state.mode = 'tool'; state.requests.length = 0;
      const r = await gen({ contents: [{ role: 'user', parts: [{ text: '上海天气？' }] }], tools: TOOLS });
      check('HTTP 200 且带渠道头', r.code === 200 && r.ch === 'gt-up', { code: r.code, ch: r.ch });
      const sent = state.lastBody;
      check('★ 上游真的收到了 tools（functionDeclarations → OpenAI tools）',
        Array.isArray(sent.tools) && sent.tools.length === 2 && sent.tools[0].function.name === 'get_weather', sent.tools);
      check('★ tool_choice 默认 auto', sent.tool_choice === 'auto', sent.tool_choice);
      const parts = r.body.candidates[0].content.parts;
      check('★★ 客户端拿到了 functionCall（PT33 里这里以前只有文本）',
        parts.some((p) => p.functionCall && p.functionCall.name === 'get_weather'), parts);
      const fc = parts.find((p) => p.functionCall).functionCall;
      check('★★ args 是对象（Gemini 认对象，不认 JSON 字符串）',
        fc.args && typeof fc.args === 'object' && fc.args.city === '上海', fc.args);
      check('finishReason = STOP（Gemini 没有 tool_calls 结束原因）',
        r.body.candidates[0].finishReason === 'STOP', r.body.candidates[0].finishReason);
      check('usageMetadata 照旧有值（工具支持没挤掉用量）',
        r.body.usageMetadata && r.body.usageMetadata.totalTokenCount === 14, r.body.usageMetadata);
    }

    /* ══════════ 2. 第二轮：functionResponse → 上游收到配对的 role:tool ══════════ */
    console.log('\n2. 第二轮：把 functionResponse 送回去 → 上游看到 assistant.tool_calls + 配对的 role:tool');
    {
      state.mode = 'text'; state.requests.length = 0;
      const r = await gen({
        contents: [
          { role: 'user', parts: [{ text: '上海天气？' }] },
          { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: '上海' } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 31 } } }] },
        ],
        tools: TOOLS,
      });
      check('HTTP 200（整条回传链路没被上游拒）', r.code === 200, r.code);
      const sent = state.lastBody;
      const asst = (sent.messages || []).find((m) => m.role === 'assistant' && m.tool_calls);
      const tool = (sent.messages || []).find((m) => m.role === 'tool');
      check('★★ 上游收到 assistant.tool_calls（真报文，不再是降级文本）',
        !!asst && asst.tool_calls.length === 1 && asst.tool_calls[0].function.name === 'get_weather', asst);
      check('★★ 上游收到 role:\'tool\' 且 tool_call_id 与上面严格配对（配错上游就 400）',
        !!tool && tool.tool_call_id === asst.tool_calls[0].id && tool.content === '{"temp":31}',
        { id: asst.tool_calls[0].id, got: tool && tool.tool_call_id, content: tool && tool.content });
      check('合成的 id 形状可读（call_g0_get_weather）', asst.tool_calls[0].id === 'call_g0_get_weather', asst.tool_calls[0].id);
      check('最终回复照旧翻回 Gemini 文本', r.body.candidates[0].content.parts[0].text === '上海 31 度', r.body.candidates[0].content.parts);
    }

    /* ══════════ 3. toolConfig 三态真的生效 ══════════ */
    console.log('\n3. toolConfig：NONE / ANY+白名单 真的传到上游（以前读错字段，永远是 auto）');
    {
      state.mode = 'text'; state.requests.length = 0;
      await gen({ contents: [{ role: 'user', parts: [{ text: 'x' }] }], tools: TOOLS, toolConfig: { functionCallingConfig: { mode: 'NONE' } } });
      check('★ NONE → 上游 tool_choice = none', state.lastBody.tool_choice === 'none', state.lastBody.tool_choice);

      await gen({ contents: [{ role: 'user', parts: [{ text: 'x' }] }], tools: TOOLS, toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_time'] } } });
      const b2 = state.lastBody;
      check('★ ANY + 单一白名单 → 上游 tool_choice 强制该函数，且工具集被收窄到 1 个',
        b2.tool_choice && b2.tool_choice.type === 'function' && b2.tool_choice.function.name === 'get_time'
        && b2.tools.length === 1 && b2.tools[0].function.name === 'get_time',
        { tc: b2.tool_choice, tools: b2.tools.map((t) => t.function.name) });

      await gen({ contents: [{ role: 'user', parts: [{ text: 'x' }] }], tools: TOOLS, toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather', 'get_time'] } } });
      check('ANY + 多白名单 → required（有损，README 已记）', state.lastBody.tool_choice === 'required', state.lastBody.tool_choice);
    }

    /* ══════════ 4. 无状态客户端：配不上的 functionResponse 退回文本 ══════════ */
    console.log('\n4. 无状态客户端（只回结果、不带上文）：退回文本，绝不造孤儿 tool 消息');
    {
      state.mode = 'text'; state.requests.length = 0;
      const r = await gen({ contents: [{ role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 31 } } }] }], tools: TOOLS });
      check('HTTP 200（没有因为孤儿 tool 消息把请求弄成 400）', r.code === 200, r.code);
      const sent = state.lastBody;
      check('★ 上游没收到 role:\'tool\'（硬造 id 会让上游 400）', !(sent.messages || []).some((m) => m.role === 'tool'), sent.messages);
      check('★ 结果以文本进了上下文（模型照样看得到）',
        (sent.messages || []).some((m) => typeof m.content === 'string' && m.content.includes('get_weather') && m.content.includes('31')),
        sent.messages);
    }

    /* ══════════ 5. 流式工具回合 ══════════ */
    console.log('\n5. 流式：分片 tool_calls 攒成完整 functionCall，且在结束帧之前发出');
    {
      state.mode = 'tool'; state.requests.length = 0;
      const r = await gen({ contents: [{ role: 'user', parts: [{ text: '上海天气？' }] }], tools: TOOLS }, 'streamGenerateContent');
      check('HTTP 200 且是 SSE', r.code === 200 && r.frames.length > 0, { code: r.code, frames: r.frames.length });
      check('★ 上游收到的请求显式带 stream:true（否则它会回整包 JSON，网关按 SSE 写就成垃圾）',
        state.lastBody.stream === true, state.lastBody.stream);
      const texts = r.frames.map((f) => ((f.candidates[0].content.parts || []).find((p) => p.text) || {}).text || '').join('');
      check('流式文本照旧逐帧送达', texts === '我查一下', texts);
      const callIdx = r.frames.findIndex((f) => (f.candidates[0].content.parts || []).some((p) => p.functionCall));
      const finIdx = r.frames.findIndex((f) => f.candidates[0].finishReason);
      check('★★ 客户端拿到了 functionCall', callIdx >= 0, r.frames.map((f) => f.candidates[0].content.parts));
      const fc = callIdx >= 0 ? r.frames[callIdx].candidates[0].content.parts.find((p) => p.functionCall).functionCall : {};
      check('★★ args 是完整对象（半截 JSON 绝不外发）', fc.args && fc.args.city === '上海', fc.args);
      check('★ functionCall 帧在 finishReason 帧之前（客户端读到结束就停手也不漏）',
        callIdx >= 0 && finIdx >= 0 && callIdx < finIdx, { callIdx, finIdx });
      check('结束帧 finishReason=STOP 且带 usageMetadata',
        finIdx >= 0 && r.frames[finIdx].candidates[0].finishReason === 'STOP' && r.frames[finIdx].usageMetadata.totalTokenCount === 14,
        finIdx >= 0 ? r.frames[finIdx].candidates[0].finishReason : null);
    }

    /* ══════════ 6. 不含工具的普通请求不受影响（老行为回归） ══════════ */
    console.log('\n6. 回归：普通 Gemini 请求（不带 tools）行为一个字没变');
    {
      state.mode = 'text'; state.requests.length = 0;
      const nr = await gen({ contents: [{ role: 'user', parts: [{ text: '你好' }] }] });
      check('非流式纯文本照旧', nr.code === 200 && nr.body.candidates[0].content.parts[0].text === '上海 31 度', nr.body);
      check('★ 没声明 tools 时上游收到的报文体里不出现 tools/tool_choice',
        !state.lastBody.tools && !state.lastBody.tool_choice, { tools: state.lastBody.tools, tc: state.lastBody.tool_choice });
      const sr = await gen({ contents: [{ role: 'user', parts: [{ text: '你好' }] }] }, 'streamGenerateContent');
      const sTexts = sr.frames.map((f) => ((f.candidates[0].content.parts || []).find((p) => p.text) || {}).text || '').join('');
      check('流式纯文本照旧（分片拼接正确）', sTexts === '上海 31 度', sTexts);
    }
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message) + '\n' + (e && e.stack ? String(e.stack).split('\n').slice(1, 4).join('\n') : ''));
  } finally {
    await stopChild(gw);
    try { upstream.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不 process.exit()：Windows 上强退会和子进程收尾抢跑
})();
