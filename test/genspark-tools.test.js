#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/genspark-tools.test.js — Genspark 网页会话反代的工具调用（文本仿真）
 *                                                      （单元 + 真链路，零依赖）
 *
 * 背景：Genspark 是「网页会话反代」——POST {baseUrl}/api/agent/ask_proxy，靠 Cookie: session_id 鉴权，
 * 走 curl 子进程 + def.proxy（直连中国 IP 会被 cn_code 验证码门 / CF 挑战拦）。
 * 已知局限（genspark2api 实测）：**上游静默忽略 OpenAI tools 参数** —— 所以声明了工具也等于没声明，
 * 客户端永远收不到 tool_calls（用户报的"无法调用工具"）。
 *
 * 整改（v1.14）：与 notion / notion-agent 同套路做**文本仿真**：
 *   ① 请求侧 toolEmu.emulateRequest 把 tools 协议注入消息 + 把历史 tool_calls / tool 结果渲染成文本；
 *   ② 网页会话只认 user/assistant → gensparkMessagesFor 把 system 折进第一条 user
 *      （不折的话，仿真注入的协议是 system，会被上游丢掉，等于没注入）；
 *   ③ 响应侧把回复里的 [TOOL_CALL]{…}[/TOOL_CALL] 解析回真 tool_calls（流式与非流式都发）。
 *
 * §2 是**真链路**：临时网关 + 假「Genspark 上游兼 HTTP 代理」——
 *   真网关配 baseUrl=http://genspark.invalid（故意用不存在的主机）+ proxy=http://127.0.0.1:PORT，
 *   于是 curl 必须把请求交给我们的假代理（走代理不解析该主机名），请求报文、注入结果、SSE 全在掌控中。
 * 跑法：node test/genspark-tools.test.js   （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
// 源码是 CRLF：归一成 LF，装配守卫才敢用 "\n" 写跨行正则
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const toolEmu = require(path.join(ROOT, 'tool-emu.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-gs-'));
const GW_KEY = 'gs-gw', AD_KEY = 'gs-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
/* 从 server.js 现抠函数（花括号配对），避免在测试里维护第二份实现 */
function extract(name) {
  let i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('server.js 里找不到函数 ' + name + '（改名了？请同步本脚本）');
  if (SRC.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
  let depth = 0, started = false;
  for (let k = i; k < SRC.length; k++) {
    if (SRC[k] === '{') { depth++; started = true; }
    else if (SRC[k] === '}') { depth--; if (started && depth === 0) return SRC.slice(i, k + 1); }
  }
  throw new Error('花括号不配对：' + name);
}

/* 假「Genspark 上游兼代理」：既是 HTTP 代理（收到绝对 URI），也是那个上游本身 */
function makeGensparkFake(tag) {
  const st = { asks: [], logins: 0, reply: '', replyText: '' };
  st.server = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      const url = req.url || '';
      if (/\/api\/is_login/.test(url)) {                       // 探测：免费接口
        st.logins++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 0, data: { is_login: true, cogen_email: 'gs@example.com' } }));
      }
      if (/\/api\/agent\/ask_proxy/.test(url)) {
        let body = {}; try { body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}'); } catch { }
        st.asks.push(body);
        const text = st.reply;                                  // 本次要回给客户端的内容
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // 按真实形状吐 SSE：增量 + 终态（终态里带 _llm_usage 真实 token）
        const parts = String(text).match(/[\s\S]{1,40}/g) || [];
        for (const p of parts) res.write('data: ' + JSON.stringify({ type: 'message_field_delta', field_name: 'content', delta: p }) + '\n\n');
        res.write('data: ' + JSON.stringify({
          type: 'message_result',
          message: { content: text, session_state: { _llm_usage: { prompt_tokens: 41, completion_tokens: 7, total_tokens: 48 } } },
        }) + '\n\n');
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected path ' + url }));
    });
  });
  return st;
}

(async () => {
  /* ══════════ 0. 装配守卫 ══════════ */
  console.log('0. 装配守卫（源码里必须真的是这套接线）');
  {
    const gs = extract('tryGensparkChannel');
    check('★ 请求侧做了仿真（emulateRequest）', /toolEmu\.emulateRequest\(body\)/.test(gs));
    check('★ 送上游的消息经过 system 折叠（否则注入的协议是 system，会被网页会话丢掉）',
      /gensparkMessagesFor\(toolEmuReq \? toolEmuReq\.messages/.test(gs) && /gensparkBuildPayload\(candidate\.upstream, outMessages\)/.test(gs));
    check('★ 响应侧把 [TOOL_CALL] 解析回真 tool_calls', /toolEmu\.parseEmulatedToolCalls\(replyText\)/.test(gs) && /replyTools = parsed\.calls/.test(gs));
    check('★ 非流式回 tool_calls 报文（带 usage）',
      /toolEmu\.openaiToolCallsPayload\(respId, displayModel, replyTools/.test(gs) && /payloadOut\.usage = usage/.test(gs));
    check('★ 流式发 tool_calls 分片 + finish_reason=tool_calls',
      /tool_calls: replyTools\.map/.test(gs) && /finish_reason: 'tool_calls'/.test(gs));
    check('★ 没有工具调用时行为不变（照旧纯文本，不会被"有 tools"吃掉）',
      /\} else \{\n      res\.write\(chunk\(\{ role: 'assistant', content: '' \}\)\);/.test(gs)
      && /res\.write\(chunk\(\{ content: replyText \}\)\);/.test(gs));
    check('★ 头部注释已改正（不再写"暂不做工具仿真"）',
      !SRC.includes('本渠道暂不做工具仿真') && /v1\.14 已整改「工具调用不可用」/.test(SRC));
  }

  /* ══════════ 1. 纯函数：system 折叠 + 仿真往返 ══════════ */
  console.log('\n1. 纯函数：gensparkMessagesFor（system → 首条 user）');
  {
    const fold = new Function('DATA', extract('gensparkMessagesFor') + '\nreturn gensparkMessagesFor;')({});
    const f1 = fold([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在' },
      { role: 'user', content: '继续' },
    ]);
    check('★ 出站不再有 system 角色（网页会话只认 user/assistant）', !f1.some((m) => m.role === 'system'));
    check('★ system 文本折进**第一条** user，且原问题还在',
      f1[0].role === 'user' && f1[0].content.startsWith('你是助手') && f1[0].content.includes('你好'));
    check('只有一条 user 时也是它（不会折到别的 role 上）', f1.filter((m) => m.role === 'user').length === 2);
    const f2 = fold([{ role: 'system', content: 'S' }]);
    check('只有 system 时补出一条 user（模型总得有点东西可回）', f2.length === 1 && f2[0].role === 'user' && f2[0].content === 'S');
    check('多个 system 合并（顺序保留）', fold([{ role: 'system', content: 'A' }, { role: 'system', content: 'B' }, { role: 'user', content: 'q' }])[0].content === 'A\n\nB\n\nq');
    check('没有 system 时原样返回（不动用户的报文）',
      JSON.stringify(fold([{ role: 'user', content: 'q' }])) === JSON.stringify([{ role: 'user', content: 'q' }]));
    check('数组型 content 取文本部分（多模态不会变成 [object Object]）',
      fold([{ role: 'system', content: [{ type: 'text', text: 'S1' }, { type: 'text', text: 'S2' }] }, { role: 'user', content: 'q' }])[0].content === 'S1\nS2\n\nq');
  }

  console.log('\n2. 仿真往返：协议注入 → 模型吐标记 → 解析回真 tool_calls');
  {
    const tools = [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
    const emu = toolEmu.emulateRequest({ messages: [{ role: 'user', content: '北京天气' }], tools, tool_choice: 'auto' });
    check('emulateRequest 注入协议（返回 messages）', !!emu && Array.isArray(emu.messages));
    check('协议里点名了工具（模型才知道有 get_weather）', JSON.stringify(emu.messages).includes('get_weather'));
    check('协议是 system（所以上面那步折叠是必须的）', emu.messages[0].role === 'system');
    const reply = '好的，我来查。\n[TOOL_CALL]\n{"name": "get_weather", "arguments": {"city": "北京"}}\n[/TOOL_CALL]';
    const parsed = toolEmu.parseEmulatedToolCalls(reply);
    check('解析出 1 个调用且参数是对象', parsed.calls.length === 1 && parsed.calls[0].name === 'get_weather' && parsed.calls[0].arguments.city === '北京');
    check('标记从给用户的正文里剥掉（不会把协议文本当回答）', !parsed.text.includes('[TOOL_CALL]') && parsed.text.includes('好的'));
    const payload = toolEmu.openaiToolCallsPayload('chatcmpl-x', 'gs-model', parsed.calls, parsed.text || null);
    check('openaiToolCallsPayload 形状正确（tool_calls + finish_reason=tool_calls）',
      payload.choices[0].message.tool_calls[0].function.name === 'get_weather'
      && JSON.parse(payload.choices[0].message.tool_calls[0].function.arguments).city === '北京'
      && payload.choices[0].finish_reason === 'tool_calls');
    check('工具结果回灌时渲染成文本（第二轮模型看得到执行结果）',
      JSON.stringify(toolEmu.emulateRequest({
        tools,
        messages: [{ role: 'user', content: 'q' }, { role: 'tool', tool_call_id: 't1', name: 'get_weather', content: '晴 26℃' }],
      }).messages).includes('晴 26℃'));
  }

  /* ══════════ 3. 真链路 ══════════ */
  const PROXY = await freePort(), GW = await freePort();
  const fake = makeGensparkFake('gs');
  await new Promise((r) => fake.server.listen(PROXY, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'c.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW,
    health: { intervalSec: 3600, timeoutMs: 8000 },
    channels: [{
      id: 'genspark', name: 'Genspark 网页会话', protocol: 'genspark',
      baseUrl: 'http://genspark.invalid',          // 故意不存在的主机：curl 必须走代理
      apiKey: 'session-abc', proxy: `http://127.0.0.1:${PROXY}`,
      priority: 1, enabled: true, models: { 'gs-model': 'gpt-6-luna' },
    }],
  }));

  const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'u.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
    stdio: 'ignore',
  });
  const stop = (cp) => new Promise((res) => {
    if (!cp || cp.exitCode !== null || cp.signalCode !== null) return res();
    cp.once('exit', () => res());
    try { cp.kill(); } catch { }
    setTimeout(res, 1500);
  });
  const chat = (payload) => fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GW_KEY}` },
    body: JSON.stringify(payload),
  }).then(async (r) => ({ code: r.status, chan: r.headers.get('x-zzcsapi-channel'), ctype: r.headers.get('content-type') || '', text: await r.text() }));

  const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
  const MARK = '[TOOL_CALL]\n{"name": "get_weather", "arguments": {"city": "北京"}}\n[/TOOL_CALL]';

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${GW}/healthz`)).ok; } catch { await sleep(150); } }
    check('临时网关起来了', up);
    if (!up) throw new Error('网关未启动');
    check('启动探测也走了假代理（genspark is_login）', fake.logins >= 1, fake.logins);

    console.log('\n3. 非流式：带 tools 的请求 → 客户端拿到 tool_calls');
    {
      fake.reply = '好的，我查一下。\n' + MARK;
      const r = await chat({ model: 'gs-model', messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: '北京天气怎么样' }], tools: TOOLS });
      check('HTTP 200 且落在 genspark 渠道', r.code === 200 && r.chan === 'genspark', { code: r.code, chan: r.chan });
      const j = JSON.parse(r.text);
      const msg = j.choices[0].message;
      check('★★ 客户端真的拿到了 tool_calls（这就是"无法调用工具"的修复）',
        Array.isArray(msg.tool_calls) && msg.tool_calls.length === 1, msg.tool_calls);
      check('★ 函数名与参数都对（参数是 JSON 字符串，解析后是对象）',
        msg.tool_calls[0].function.name === 'get_weather'
        && JSON.parse(msg.tool_calls[0].function.arguments).city === '北京', msg.tool_calls[0].function);
      check('★ finish_reason=tool_calls（客户端据此进工具回合）', j.choices[0].finish_reason === 'tool_calls', j.choices[0].finish_reason);
      check('正文只剩给用户的话（标记已剥离）', msg.content === '好的，我查一下。', msg.content);
      check('用量照实带（上游 _llm_usage 的 prompt 41 / completion 7）',
        j.usage && j.usage.prompt_tokens === 41 && j.usage.completion_tokens === 7, j.usage);

      const sent = fake.asks[fake.asks.length - 1];
      check('★ 上游收到的是仿真协议（tools 定义进了消息，不是被静默忽略的 tools 字段）',
        JSON.stringify(sent.messages).includes('get_weather') && JSON.stringify(sent.messages).includes('[TOOL_CALL]'));
      check('★ 上游报文里没有 system 角色（已折进首条 user）', !sent.messages.some((m) => m.role === 'system'));
      check('上游报文里没塞原生 tools 字段（该上游根本不认，塞了也是噪音）', sent.tools === undefined);
      check('模型名按 aliasMap 翻译（gs-model → gpt-6-luna）', sent.ai_chat_model === 'gpt-6-luna', sent.ai_chat_model);
    }

    console.log('\n4. 第二轮：把工具结果回灌 → 模型看得到执行结果');
    {
      fake.reply = '北京今天晴，26℃。';
      const r = await chat({
        model: 'gs-model',
        messages: [
          { role: 'user', content: '北京天气怎么样' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: '晴 26℃' },
        ],
        tools: TOOLS,
      });
      check('HTTP 200 且是纯文本回答（这一轮模型没再要工具）',
        r.code === 200 && JSON.parse(r.text).choices[0].message.tool_calls === undefined, r.text.slice(0, 160));
      check('★ 上游看到了工具执行结果（历史 tool 消息被渲染成文本）',
        JSON.stringify(fake.asks[fake.asks.length - 1].messages).includes('晴 26℃'));
      check('★ 历史里的 assistant.tool_calls 也被渲染（模型知道上一轮调了什么）',
        JSON.stringify(fake.asks[fake.asks.length - 1].messages).includes('get_weather'));
      check('这一轮的回复是上游原文', JSON.parse(r.text).choices[0].message.content.includes('26℃'));
    }

    console.log('\n5. 流式：tool_calls 分片 + finish_reason=tool_calls');
    {
      fake.reply = MARK;
      const r = await chat({ model: 'gs-model', messages: [{ role: 'user', content: '北京天气' }], tools: TOOLS, stream: true });
      check('HTTP 200 且真的是 SSE（别把 JSON 当流式测）', r.code === 200 && /text\/event-stream/.test(r.ctype), r.ctype);
      const chunks = r.text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6).trim()).filter((d) => d && d !== '[DONE]').map((d) => JSON.parse(d));
      const withTools = chunks.find((c) => c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.tool_calls);
      check('★★ 流式里也发了 tool_calls 分片', !!withTools, chunks.map((c) => c.choices && c.choices[0].delta));
      check('★ finish_reason=tool_calls（不是 stop）',
        chunks.some((c) => c.choices && c.choices[0].finish_reason === 'tool_calls'),
        chunks.map((c) => c.choices && c.choices[0].finish_reason));
      check('分片里函数名与参数齐全',
        withTools && withTools.choices[0].delta.tool_calls[0].function.name === 'get_weather'
        && JSON.parse(withTools.choices[0].delta.tool_calls[0].function.arguments).city === '北京');
      check('以 [DONE] 收尾', r.text.trim().endsWith('data: [DONE]'));
    }

    console.log('\n6. 对照：不带 tools 的普通请求一个字没变');
    {
      const before = fake.asks.length;
      fake.reply = '你好呀，有什么可以帮你？';
      const r = await chat({ model: 'gs-model', messages: [{ role: 'user', content: '你好' }] });
      const j = JSON.parse(r.text);
      check('HTTP 200 + 纯文本 + finish_reason=stop',
        r.code === 200 && j.choices[0].message.content.includes('你好呀') && j.choices[0].finish_reason === 'stop', j.choices[0]);
      check('没有 tool_calls 字段（不无中生有）', j.choices[0].message.tool_calls === undefined);
      const sent = fake.asks[before];
      check('★ 上游报文里没有被注入工具协议（没声明工具就不注入）',
        !JSON.stringify(sent.messages).includes('[TOOL_CALL]') && !JSON.stringify(sent.messages).includes('get_weather'));
    }

    console.log('\n7. 对照：tool_choice=none 时也不注入（客户端明说别用工具）');
    {
      const before = fake.asks.length;
      fake.reply = '好的。';
      const r = await chat({ model: 'gs-model', messages: [{ role: 'user', content: '你好' }], tools: TOOLS, tool_choice: 'none' });
      check('HTTP 200', r.code === 200);
      check('★ 上游没收到工具协议（tool_choice:none → 不仿真）',
        !JSON.stringify(fake.asks[before].messages).includes('[TOOL_CALL]'));
    }
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message) + '\n' + (e && e.stack ? String(e.stack).split('\n').slice(1, 4).join('\n') : ''));
  } finally {
    await stop(gw);
    try { fake.server.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;
})();
