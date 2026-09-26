#!/usr/bin/env node
/**
 * Prism (prism.openai.com) 纯 HTTP 客户端 —— 逆向自 Prism 前端，无需浏览器。
 *
 * 完整链路（8 步，缺一不可）：
 *   1. POST /api/backend/1/new                                    → sandbox {url, token}
 *   2. POST /api/projects/{projectId}/sandbox/resources-token     → {access_token, resources_base_url}
 *   3. POST {sandbox.url}/resources-token                         → 把资源令牌推给 sandbox
 *   4. POST /api/y  {docId: projectId}                            → Y-Sweet 文档令牌
 *   5. POST {sandbox.url}/token                                   → 把 Yjs 令牌推给 sandbox
 *   6. GET  {sandbox.url}/wait-for-sync?wait_ms=10000             → 轮询到 status=synced
 *   7. POST /api/llm/response_with_tools_start                    → {request_id, turn_state}
 *   8. POST /api/llm/response_with_tools_status                   → 轮询到 completed
 *
 * 用法：
 *   node prism-test.js "你的问题"
 *   node prism-test.js "问题" --model gpt-5.6-sol --effort low
 *
 * 凭据：_prism_cookies.json（数组 [{name, value}]，从浏览器 DevTools 导出）
 * 网络：必须走代理（默认 http://127.0.0.1:7897），且 __cf_bm 需与出口 IP 匹配。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROXY = process.env.PRISM_PROXY || 'http://127.0.0.1:7897';
const ORIGIN = 'https://prism.openai.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const COOKIE_FILE = path.join(__dirname, '_prism_cookies.json');

// ── curl 子进程：Node/undici 的 TLS 指纹会被 Cloudflare 拦，必须借 curl ──
function curlOnce(method, url, { headers = {}, body, timeoutMs = 60000 } = {}) {
  const args = ['-sS', '-m', String(Math.round(timeoutMs / 1000)), '-x', PROXY, '-X', method, url];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  const tmp = path.join(__dirname, '_prism_req.tmp');
  if (body !== undefined) {
    fs.writeFileSync(tmp, typeof body === 'string' ? body : JSON.stringify(body));
    args.push('--data-binary', `@${tmp}`);
  }
  args.push('-o', path.join(__dirname, '_prism_out.tmp'), '-w', '%{http_code}');
  let status = '';
  let err;
  try {
    status = execFileSync('curl.exe', args, { encoding: 'utf8' }).trim();
  } catch (e) {
    // 错误信息里含 cookie，必须剥掉
    err = String(e.message || e).split('-H cookie:')[0].split('\n')[0].slice(0, 160);
  } finally {
    if (body !== undefined) fs.rmSync(tmp, { force: true });
  }
  const outFile = path.join(__dirname, '_prism_out.tmp');
  const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  fs.rmSync(outFile, { force: true });
  return { status: Number(status) || 0, text, err };
}

/** 带重试：TLS 抖动（status 0）与 5xx 都是暂时的，Prism 经常需要重试 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function curl(method, url, opts = {}) {
  const tries = opts.retries ?? 4;
  let last;
  for (let i = 0; i < tries; i++) {
    last = curlOnce(method, url, opts);
    if (last.status && last.status < 500) return last;
    if (i < tries - 1) {
      const why = last.status === 0 ? `传输失败(${last.err || 'unknown'})` : `HTTP ${last.status}`;
      if (opts.verbose) console.log(`   ↻ ${why}，重试 ${i + 1}/${tries - 1}`);
      sleepSync(1200 * (i + 1));
    }
  }
  return last;
}

function loadCookie() {
  const arr = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  return arr.map((c) => `${c.name}=${c.value}`).join('; ');
}

function jwtPayload(t) {
  try {
    return JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

/** 完整 bootstrap：返回 { sandboxUrl, sandboxToken, projectId, userId }（已 synced） */
async function bootstrap(cookie, { projectId, model, effort } = {}) {
  const H = {
    cookie,
    'User-Agent': UA,
    accept: 'application/json',
    referer: `${ORIGIN}/`,
    origin: ORIGIN,
    'content-type': 'application/json',
  };

  // 会话身份：projectId / userId 从 prism_session_token 里取
  const sess = jwtPayload(
    (cookie.match(/prism_session_token=([^;]+)/) || [])[1] || ''
  );
  const userId = sess?.policy?.user?.id;
  let proj = projectId;
  if (!proj) {
    const r = curl('GET', `${ORIGIN}/api/projects`, { headers: H });
    const list = JSON.parse(r.text).projects || [];
    proj = list[0]?.uuid;
    if (!proj) throw new Error('账号下没有项目，请先在 prism 网页里建一个项目');
  }
  console.log(`[1/6] projectId=${proj} userId=${userId}`);

  // 1. 新 sandbox
  let r = curl('POST', `${ORIGIN}/api/backend/1/new`, { headers: H, body: '{}' });
  const sb = JSON.parse(r.text);
  if (!sb.url || !sb.token) throw new Error(`backend/1/new 失败: ${r.text.slice(0, 200)}`);
  const sbase = sb.url.replace(/\/+$/, '');
  console.log(`[2/6] sandbox 就绪 ${sbase}`);

  // 2. 资源令牌（必须带 sandbox_token，否则 sandbox 拿不到工作区文件）
  r = curl('POST', `${ORIGIN}/api/projects/${encodeURIComponent(proj)}/sandbox/resources-token`, {
    headers: H,
    body: { sandbox_session_id: null, sandbox_token: sb.token },
  });
  const rt = JSON.parse(r.text);
  if (!rt.access_token) throw new Error(`resources-token 失败: ${r.text.slice(0, 200)}`);

  // 3. 推给 sandbox
  r = curl('POST', `${sbase}/resources-token`, {
    headers: { ...H, 'X-Crixet-Sandbox-Token': sb.token },
    body: { token: rt.access_token, resourceBaseUrl: rt.resources_base_url, projectId: proj },
  });
  if (r.status !== 200) throw new Error(`推送资源令牌失败: ${r.status} ${r.text.slice(0, 200)}`);
  console.log('[3/6] 资源令牌已推送');

  // 3.5 预热：sandbox 刚创建时接口可能返回 5xx，等它就绪（首次 /token 曾见 500）
  for (let i = 0; i < 10; i++) {
    r = curl('GET', `${sbase}/wait-for-sync?wait_ms=3000`, {
      headers: { ...H, 'X-Crixet-Sandbox-Token': sb.token },
      timeoutMs: 15000,
    });
    if (r.status === 200) break;
    await new Promise((res) => setTimeout(res, 2000));
  }

  // 4. Y-Sweet 文档令牌
  r = curl('POST', `${ORIGIN}/api/y`, {
    headers: H,
    body: {
      docId: proj,
      requestContext: {
        source: 'initial-bootstrap',
        bootstrapAttempt: 0,
        previouslyConnected: false,
        sandboxUrl: sbase,
        maxAttempts: 5,
        requestSeriesId: require('crypto').randomUUID(),
      },
    },
  });
  const ytok = JSON.parse(r.text);
  if (!ytok.url) throw new Error(`/api/y 失败: ${r.text.slice(0, 200)}`);

  // 5. 推给 sandbox（重试：sandbox 预热期间可能 5xx）
  let pushed = false;
  for (let i = 0; i < 6; i++) {
    r = curl('POST', `${sbase}/token`, {
      headers: { ...H, 'X-Crixet-Sandbox-Token': sb.token },
      body: ytok,
    });
    if (r.status === 200) { pushed = true; break; }
    await new Promise((res) => setTimeout(res, 2000));
  }
  if (!pushed) throw new Error(`推送 Yjs 令牌失败: ${r.status} ${r.text.slice(0, 200)}`);
  console.log('[4/6] Y-Sweet 令牌已推送');

  // 6. 等同步完成
  for (let i = 0; i < 15; i++) {
    r = curl('GET', `${sbase}/wait-for-sync?wait_ms=10000`, {
      headers: { ...H, 'X-Crixet-Sandbox-Token': sb.token },
      timeoutMs: 30000,
    });
    let st = {};
    try { st = JSON.parse(r.text); } catch {}
    if (st.status === 'synced' && st.tokens?.hasSyncedYSweetProvider) {
      console.log('[5/6] 工作区已同步');
      return { sandboxUrl: sbase, sandboxToken: sb.token, projectId: proj, userId };
    }
    if (st.status === 'failed') throw new Error('sandbox 同步失败');
  }
  throw new Error('sandbox 同步超时');
}

/** 发起一次对话，返回 { text, usage, conversationId, files, elapsedMs }
 *  opts.conversationId 传入可复用已有会话（省掉 bootstrap，快很多）
 *  opts.reuseSandbox  复用 _prism_state.json 里缓存的 sandbox（更快）
 */
async function chat(prompt, { model = 'gpt-5.6-sol', effort = 'low', projectId, conversationId, reuseSandbox = true, timeoutMs = 180000 } = {}) {
  const cookie = loadCookie();
  const t0 = Date.now();
  const stateFile = path.join(__dirname, '_prism_state.json');
  // 复用缓存：sandbox + 会话
  let cached = {};
  if (reuseSandbox && fs.existsSync(stateFile)) {
    try { cached = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  }
  let ctx;
  if (reuseSandbox && cached.sandboxUrl && cached.sandboxToken && Date.now() < (cached.sandboxExpiresAt || 0)) {
    ctx = { sandboxUrl: cached.sandboxUrl, sandboxToken: cached.sandboxToken, projectId: cached.projectId, userId: cached.userId };
    // 校验 sandbox 还活着
    const chk = curl('GET', `${ctx.sandboxUrl}/wait-for-sync?wait_ms=1000`, {
      headers: { cookie, 'User-Agent': UA, 'X-Crixet-Sandbox-Token': ctx.sandboxToken },
      timeoutMs: 15000,
    });
    if (chk.status !== 200) ctx = null;
    else console.log('[bootstrap] 复用已就绪的 sandbox（跳过 6 步握手）');
  }
  if (!ctx) {
    ctx = await bootstrap(cookie, { projectId, model, effort });
    // sandbox 一般可存活一段时间，缓存 20 分钟
    fs.writeFileSync(stateFile, JSON.stringify({ ...ctx, sandboxExpiresAt: Date.now() + 8 * 60 * 1000 }));
  }
  const conv = conversationId || cached.conversationId || null;
  // 多轮记忆靠 previousResponseId = 上一轮 response.payload.id（形如 msg_xxx）
  // 只传 conversationId 不带 previousResponseId，模型不会记得上文
  const prevResponseId = conversationId ? null : cached.previousResponseId || null;
  if (conv) console.log(`[chat] 复用会话 ${conv}${prevResponseId ? `（previousResponseId=${prevResponseId}）` : ''}`);
  const H = {
    cookie,
    'User-Agent': UA,
    accept: 'application/json',
    referer: `${ORIGIN}/`,
    origin: ORIGIN,
    'content-type': 'application/json',
  };

  // 7. 发起
  const metadata = {
    projectId: ctx.projectId,
    userId: ctx.userId,
    model,
    reasoning_effort: effort, // ← 注意是 snake_case
    frontend_origin: ORIGIN,
    sandbox_url: ctx.sandboxUrl,
    sandbox_token: ctx.sandboxToken,
  };
  // 多轮记忆：⚠️ 实测结论
  //   - 服务端会话记忆走的是 Next.js Server Actions（createProjectConversation 等），
  //     那是框架内部协议，从外部 REST 调不动；只传 conversationId/previousResponseId
  //     并不会让模型记得上文（实测第 2 轮必答 "Unknown"）。
  //   - 所以这里用「压平历史进单条 user 文本」的稳妥做法，实测有效。
  const history = conversationId ? [] : Array.isArray(cached.history) ? cached.history : [];
  let promptText = prompt;
  if (history.length) {
    const lines = ['对话历史：'];
    for (const m of history) {
      const txt = (m.content || []).map((c) => c.text).join('');
      lines.push(`${m.role === 'user' ? '用户' : '助手'}：${txt}`);
    }
    lines.push('', `现在回答：${prompt}`);
    promptText = lines.join('\n');
    console.log(`[chat] 压平 ${history.length} 条历史进 prompt`);
  }
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: promptText }] }];
  let r = curl('POST', `${ORIGIN}/api/llm/response_with_tools_start`, {
    headers: H,
    body: {
      input,
      previousResponseId: prevResponseId,
      metadata,
      conversationId: conv,
    },
    timeoutMs: 120000,
    verbose: true,
  });
  let j = JSON.parse(r.text);
  // sandbox 可能已被回收 → 清缓存重新 bootstrap 一次
  if (j.status !== 'started' && j.status !== 'completed' && reuseSandbox && fs.existsSync(stateFile) && cached.sandboxUrl) {
    const why = String(j.response?.payload?.rootCause || j.response?.payload?.message || '');
    if (/healthz|sandbox|reconnect|lookup failed/i.test(why)) {
      console.log(`[chat] sandbox 已失效（${why.slice(0, 60)}），重新 bootstrap`);
      fs.rmSync(stateFile, { force: true });
      return chat(prompt, { model, effort, projectId, conversationId, reuseSandbox: false, timeoutMs });
    }
  }
  if (j.status === 'completed') return finish(j, ctx, t0);
  if (j.status !== 'started') throw new Error(`start 失败: ${r.text.slice(0, 400)}`);
  console.log(`[6/6] 回合已开始 request_id=${j.request_id} conv=${j.conversation_id}`);

  // 8. 轮询
  let turnState = j.turn_state;
  const reqId = j.request_id;
  const newConv = j.conversation_id;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    r = curl('POST', `${ORIGIN}/api/llm/response_with_tools_status`, {
      headers: H,
      body: { request_id: reqId, turn_state: turnState },
      timeoutMs: 60000,
    });
    const s = JSON.parse(r.text);
    if (s.turn_state) turnState = s.turn_state;
    if (s.codex_live_progress) {
      const p = s.codex_live_progress;
      const line = p.last_tool_progress_line || p.status;
      if (line) process.stdout.write(`\r  … ${String(line).slice(0, 70)}`.padEnd(80));
    }
    if (s.status === 'completed') {
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      const out = finish(s, ctx, t0);
      out.conversationId = newConv || out.conversationId;
      // 记住会话 + 历史 + 上一轮 response id + 刷新 sandbox 缓存，供下一轮复用
      try {
        const prev = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
        const hist = [
          ...(Array.isArray(prev.history) ? prev.history : []),
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: out.text }] },
        ];
        fs.writeFileSync(stateFile, JSON.stringify({ ...prev, ...ctx, conversationId: out.conversationId, previousResponseId: out.responseId, history: hist.slice(-12), sandboxExpiresAt: Date.now() + 8 * 60 * 1000 }));
      } catch {}
      return out;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error('轮询超时');
}

function finish(envelope, ctx, t0) {
  const resp = envelope.response;
  if (resp.status !== 'success') {
    const p = resp.payload || {};
    throw new Error(`回合失败 reason=${p.reason} ${p.message || ''} ${p.rootCause || ''}`);
  }
  const text = (resp.payload.output || [])
    .flatMap((it) => it.content || [])
    .filter((c) => c.type === 'output_text' || typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  const df = resp.payload.codexDeltaFiles;
  return {
    text,
    usage: resp.payload.usage || null,
    conversationId: envelope.conversation_id || ctx?.projectId,
    responseId: resp.payload.id || null, // 传给下一轮的 previousResponseId
    files: Array.isArray(df) ? df.map((f) => f.file_path) : df ? [df.file_path] : [],
    elapsedMs: t0 ? Date.now() - t0 : undefined,
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const model = opt('--model', 'gpt-5.6-sol');
  const effort = opt('--effort', 'low');
  const projectId = opt('--project', undefined);
  // 位置参数 = 提问内容（跳过所有 --opt 及其取值）
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { i++; continue; }
    positional.push(argv[i]);
  }
  const prompt = positional.join(' ') || 'Reply with exactly: HELLO PRISM';
  console.log(`prompt = ${JSON.stringify(prompt)}`);

  chat(prompt, { model, effort, projectId })
    .then((r) => {
      console.log('\n=== 模型输出 ===');
      console.log(r.text);
      if (r.usage) console.log('\nusage:', JSON.stringify(r.usage));
    })
    .catch((e) => {
      console.error('\n✗ 失败:', e.message);
      process.exit(1);
    });
}

module.exports = { chat, bootstrap, curl, loadCookie };
