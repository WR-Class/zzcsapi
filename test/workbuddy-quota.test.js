#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/workbuddy-quota.test.js — WorkBuddy 渠道：额度用尽要看得懂、冷却对齐重置点
 *                                                      （单元 + 真链路，零依赖）
 *
 * 用户报：「workbuddy 渠道也出现了问题，我记得它用的是 CodeBuddyExtension auth 文件里的
 *          accessToken，但现在复制这个好像也不能获取模型了，提示 ✗ workbuddy: non-SSE response」。
 *
 * 实测真因（本用例把这三点钉死）：
 *   1) token 没问题——上游 429 响应头里回显 `X-User-Id` = token 的 `sub`，说明鉴权已通过；
 *      真实原因是**额度/频率用尽**：HTTP 429 + {"code":6004,"msg":"usage exceeds frequency limit …
 *      your usage will reset at 2026-09-28 10:00:39 UTC+8"}。
 *   2) 旧代码把这句吐成了 `non-SSE response`：探测侧用 `text.startsWith('{')`（**没 trim**）判 JSON，
 *      响应体只要以换行/BOM 开头就被当成「未知响应」，上游明说的重置时刻被整段丢掉。
 *   3) 那个 auth 文件里的 accessToken 现在被 CodeBuddy 加密了（{$wbEncrypted:1, envelope:{suite,keyId,
 *      nonce,authTag,ciphertext}}）——是 AES-GCM 密文，不是 JWT，复制粘贴必然会失败。
 *
 * 处置：① trim + BOM 后再判 JSON，额度类按 rate_limit 记；② 从文案里抠重置时刻 → retryAfterMs，
 * 冷却精确对齐（不再按曲线瞎猜）；③ 非 SSE/非 JSON 的错误带上 HTTP 码与响应开头；
 * ④ 密文 key 在发请求前就拦下并说清原因。
 *
 * 跑法：node test/workbuddy-quota.test.js   （退出码非 0 表示有回归）
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-wb-'));
const GW_KEY = 'wb-gw', AD_KEY = 'wb-admin';

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
// 从 server.js 现抠函数（花括号配对）。注意：**必须跳过字符串/注释里的花括号**——
// 本文件要抠的 workbuddyChatProbe 里有 `startsWith('{')` 这种字面量，朴素计数器会把它算进去，
// 结果"花括号不配对"（这正是本次要修的 bug 的镜像：把响应体里的 `{` 当结构）。
function extract(name) {
  let i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('server.js 里找不到函数 ' + name + '（改名了？请同步本脚本）');
  if (SRC.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
  let depth = 0, started = false, quote = null, esc = false;
  for (let k = i; k < SRC.length; k++) {
    const c = SRC[k], n = SRC[k + 1];
    if (esc) { esc = false; continue; }
    if (quote) {
      if (c === '\\') { esc = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { const e = SRC.indexOf('\n', k); k = e < 0 ? SRC.length : e; continue; }
    if (c === '/' && n === '*') { const e = SRC.indexOf('*/', k); k = e < 0 ? SRC.length : e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return SRC.slice(i, k + 1); }
  }
  throw new Error('花括号不配对：' + name);
}
const load = (name) => new Function(extract(name) + '\nreturn ' + name + ';')();

/* 真实的 429 文案（本机实测原文，原样抄来当夹具，避免"按想象写测试"） */
const realQuotaBody = (resetLocal) => JSON.stringify({
  code: 6004,
  msg: `usage exceeds frequency limit, but don't worry, your usage will reset at ${resetLocal} UTC+8, alternatively, you can switch to the other models to continue using it.`,
  requestId: 'a4dbab57-7cef-4300-88d9-e91995ffd273',
});
/* CodeBuddy 新版 auth 文件里的加密信封（结构照抄，密文是占位） */
const encryptedEnvelope = JSON.stringify({
  $wbEncrypted: 1,
  envelope: 'eyJzdWl0ZSI6MSwia2V5SWQiOiJkZWFkYmVlZmNhZmUwMDAwIiwibm9uY2UiOiJBQUFBQUFBQUFBQUFBQUFBIiwiYXV0aFRhZyI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUE9PSIsImNpcGhlcnRleHQiOiJQTEFDRUhPTERFUjBQTEFDRUhPTERFUjFQTEFDRUhPTERFUjJQTEFDRUhPTERFUjMifQ==',
});
/* 从服务器现抠的真实 JWT 形状（三段点分，本文件里没有任何真实签名） */
const fakeJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl';

/* 假 WorkBuddy 上游：无 /models，只有 POST /v2/chat/completions */
function makeWbFake() {
  const st = { mode: 'ok', hits: 0, quotaBody: '', lastBody: null };
  st.server = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      st.hits++;
      try { st.lastBody = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}'); } catch { st.lastBody = null; }
      if (st.mode === 'quota') {
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(st.quotaBody);                       // 真实的 429 + code 6004 文案
      }
      if (st.mode === 'html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf</body></html>');
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n');
      res.write('data: {"id":"x","choices":[{"index":0,"delta":{"content":"pong"}}]}\n\n');
      res.write('data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  return st;
}

(async () => {
  /* 第二个假上游：openai 协议。探测（/v1/models）正常 → 渠道是健康的；聊天一律 500 →
     用来构造"另一家被真试过并失败、workbuddy 却在冷却里"的混合场景 */
  function makeOaiFake() {
    const st = { hits: 0 };
    st.server = http.createServer((req, res) => {
      st.hits++;
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'wb-demo', object: 'model' }] }));
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"boom"}}');
    });
    return st;
  }

  /* ══════════ 0. 装配守卫 ══════════ */
  console.log('0. 装配守卫（源码里必须真的是这套判据）');
  {
    const probe = extract('workbuddyChatProbe');
    const chat = extract('tryWorkbuddyChannel');
    check('★ 探测侧先 trim/BOM 再判 JSON（旧写法 startsWith(\'{\') 会把 429 文案吞成 non-SSE）',
      /const trimmed = text\.replace\(\/\^\\uFEFF\/, ''\)\.trim\(\)/.test(probe) && /trimmed\.startsWith\('\{'\)/.test(probe));
    check('★ 探测侧识别额度类文案并带出重置时刻', /wbQuotaLimited\(trimmed\)/.test(probe) && /wbQuotaResetMs\(msg\)/.test(probe) && /retryAfterMs/.test(probe));
    check('★ 探测侧不再吐裸的 non-SSE response（必须有 HTTP 码与响应开头）',
      !/error: 'non-SSE response'/.test(probe) && /wbOpaqueBodyMsg\(out\.status, text\)/.test(probe));
    check('★ 探测失败时把分类带出去（rateLimited / retryAfterMs 不丢）',
      /e\.rateLimited = probe\.rateLimited; e\.retryAfterMs = probe\.retryAfterMs/.test(SRC));
    check('★ 探测的失败交给记录层时走 rate_limit（额度用尽 ≠ 渠道故障）',
      /err\.rateLimited \|\| err\.retryAfterMs\) recordFailure\(ch, 'workbuddy: ' \+ \(err\.message \|\| err\), 'rate_limit'/.test(SRC));
    check('★ 聊天侧额度类按 rate_limit 记 + 精确冷却', /limited \? 'rate_limit' : failureKindFromStatus/.test(chat) && /resetMs \? \{ retryAfterMs: resetMs \}/.test(chat));
    check('★ 聊天侧非 SSE 也带上 HTTP 码与响应开头', !/'workbuddy: non-SSE response'/.test(chat) && /wbOpaqueBodyMsg\(out\.status, sseText\)/.test(chat));
    check('★ 密文 token 在发请求前就拦下（两处都拦）',
      /const keyHint = wbEncryptedKeyHint\(def\.apiKey\)/.test(probe) && /const wbKeyHint = wbEncryptedKeyHint\(ch\.def\.apiKey\)/.test(chat));
  }

  /* ══════════ 1. 真值表 ══════════ */
  console.log('\n1. 纯函数真值表');
  {
    const limited = load('wbQuotaLimited'), reset = load('wbQuotaResetMs'), opaque = load('wbOpaqueBodyMsg'), hint = load('wbEncryptedKeyHint');

    check('额度文案认得（真实原文）', limited(JSON.parse(realQuotaBody('2026-09-28 10:00:39')).msg));
    check('普通限流文案也认得', limited('too many requests') && limited('Rate limit exceeded'));
    check('正常内容不误判', !limited('你好，很高兴为你服务') && !limited(''));

    const now = Date.UTC(2026, 8, 27, 20, 27, 0); // 2026-09-27 20:27 UTC = 09-28 04:27 UTC+8
    const ms = reset('usage … reset at 2026-09-28 10:00:39 UTC+8', now);
    check('★ 重置时刻按 UTC+8 换算准确（04:27 → 10:00:39 = 5 小时 33 分 39 秒）',
      ms === (Date.UTC(2026, 8, 28, 2, 0, 39) - now), ms);
    check('UTC 无偏移也认', reset('reset at 2026-09-28 02:00:39 UTC', now) === (Date.UTC(2026, 8, 28, 2, 0, 39) - now));
    check('旧时刻（已过去）返回 0（不产生负冷却）', reset('reset at 2026-01-01 00:00:00 UTC+8', now) === 0);
    check('抠不到就返回 0（照曲线走，不瞎猜）', reset('usage exceeds frequency limit', now) === 0 && reset('', now) === 0);

    const o = opaque(200, '<!DOCTYPE html>\n<html>  <head>');
    check('★ 非 SSE 错误带 HTTP 码与响应开头（这次就不会再看到一句光秃秃的 non-SSE）',
      o.startsWith('non-SSE response (HTTP 200') && o.includes('<!DOCTYPE html> <html>'), o);
    check('空响应体也有说明', opaque(0, '').includes('响应体为空'), opaque(0, ''));

    check('★ 密文信封被认出来并说清"不是 JWT"',
      /不是 JWT/.test(hint(encryptedEnvelope)) && /envelope/.test(hint(encryptedEnvelope)), hint(encryptedEnvelope));
    check('裸 envelope 串（只粘了 ciphertext 那半截）也认得', /不是 JWT/.test(hint('{"suite":1,"keyId":"x","nonce":"y","authTag":"z","ciphertext":"q"}').toString()) || /不是 JWT/.test(hint('{"suite":1,"keyId":"x","nonce":"y","authTag":"z","ciphertext":"q"')));
    check('正常 JWT 不误报（三段点分原样放行）', hint(fakeJwt) === '');
    check('空 key 不误报', hint('') === '' && hint(undefined) === '');
  }

  /* ══════════ 2. 真链路 ══════════ */
  const UP = await freePort(), GW = await freePort(), OAI = await freePort();
  const fake = makeWbFake();
  const oai = makeOaiFake();
  await new Promise((r) => fake.server.listen(UP, '127.0.0.1', r));
  await new Promise((r) => oai.server.listen(OAI, '127.0.0.1', r));
  // 上游"重置时刻"取本地时间 +2 小时，格式化成 UTC+8 文案里的样子
  const resetLocal = (d) => {
    const t = new Date(d + 8 * 3600e3); // 挪到 UTC+8 再按 UTC 字段打印
    const p = (n) => String(n).padStart(2, '0');
    return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
  };

  const cfgPath = path.join(TMP, 'c.json');
  const writeCfg = (apiKey, enabled = true) => fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW,
    health: { intervalSec: 3600, timeoutMs: 8000 },
    channels: [{
      id: 'workbuddy', name: 'WorkBuddy', protocol: 'workbuddy',
      baseUrl: `http://127.0.0.1:${UP}/v2`, apiKey,
      priority: 1, enabled, models: { 'wb-demo': 'deepseek-v4.1-flash' },
    }],
  }));
  writeCfg(fakeJwt);

  const gwEnv = { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'u.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' };
  let gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: gwEnv, stdio: 'ignore' });
  const stop = (cp) => new Promise((res) => {
    if (!cp || cp.exitCode !== null || cp.signalCode !== null) return res();
    cp.once('exit', () => res());
    try { cp.kill(); } catch { }
    setTimeout(res, 1500);
  });
  const AH = { Authorization: `Bearer ${AD_KEY}`, 'Content-Type': 'application/json' };
  const recheck = (id = 'workbuddy') => fetch(`http://127.0.0.1:${GW}/admin/api/recheck`, {
    method: 'POST', headers: AH, body: JSON.stringify({ id }),
  }).then((r) => r.json()).then((j) => j.results[0]);
  const statusOf = (id) => fetch(`http://127.0.0.1:${GW}/admin/api/status`, { headers: AH })
    .then((r) => r.json()).then((j) => j.channels.find((c) => c.id === id));
  const chat = () => fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GW_KEY}` },
    body: JSON.stringify({ model: 'wb-demo', messages: [{ role: 'user', content: 'ping' }] }),
  }).then(async (r) => ({ code: r.status, text: await r.text() }));
  const waitUp = async () => { for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${GW}/healthz`)).ok) return true; } catch { } await sleep(150); } return false; };

  try {
    check('临时网关起来了', await waitUp());
    const before = fake.hits;

    console.log('\n2. 额度用尽（真实 429 code 6004）');
    {
      fake.mode = 'quota';
      const resetAt = Date.now() + 2 * 3600e3;
      fake.quotaBody = '\n' + realQuotaBody(resetLocal(resetAt));   // 故意以换行开头：旧代码就是栽在这
      const r = await recheck();
      check('★ 探测不再说 non-SSE，而是原样带出上游的额度文案',
        r.status !== 'down' && /usage exceeds frequency limit/.test(r.error || '') && !/non-SSE/.test(r.error || ''), r.error);
      const st = await statusOf('workbuddy');
      check('★ 记成 rate_limit 语义（冷却对齐重置点，而不是"渠道故障"）',
        st.status !== 'down' && Math.abs(st.cooldownUntil - resetAt) < 90_000,
        { status: st.status, cooldownUntil: st.cooldownUntil, resetAt, deltaMs: st.cooldownUntil - resetAt });
      check('lastError 保留上游原文（排障时看得见是哪家、为什么）', /usage exceeds frequency limit/.test(st.lastError || ''), st.lastError);
      const c = await chat();
      const cj = (() => { try { return JSON.parse(c.text); } catch { return null; } })();
      check('★ 冷却期间客户端被告知"为什么 + 何时恢复"（不再是光秃秃一句 all channels in cooldown）',
        c.code === 503 && /all channels in cooldown/.test(c.text)
        && /usage exceeds frequency limit/.test(c.text) && /workbuddy/.test(c.text),
        { code: c.code, text: c.text.slice(0, 200) });
      check('★ 明确给出最近一家多久后恢复（对齐上游的重置点，约 2 小时）',
        !!(cj && cj.error && cj.error.cooldown && cj.error.cooldown[0]
          && Math.abs(cj.error.cooldown[0].recoverInMs - 2 * 3600e3) < 90_000
          && /小时/.test(cj.error.cooldown[0].recoverIn)),
        cj && cj.error && cj.error.cooldown);
    }

    console.log('\n3. 上游返回 HTML（CF 挑战页）——错误里要能看见它是什么');
    {
      fake.mode = 'html';
      const r = await recheck();
      check('★ 错误带 HTTP 码与响应开头（以后一眼看出是挑战页/代理页，而不是"未知"）',
        /non-SSE response \(HTTP 200/.test(r.error || '') && /<!DOCTYPE html>/.test(r.error || ''), r.error);
    }

    console.log('\n4. 密文 token：发请求前就拦下');
    {
      const hitsBefore = fake.hits;
      fs.writeFileSync(cfgPath, JSON.stringify({
        port: GW, health: { intervalSec: 3600, timeoutMs: 8000 },
        channels: [{
          id: 'workbuddy', name: 'WorkBuddy', protocol: 'workbuddy',
          baseUrl: `http://127.0.0.1:${UP}/v2`, apiKey: encryptedEnvelope,
          priority: 1, enabled: true, models: { 'wb-demo': 'deepseek-v4.1-flash' },
        }],
      }));
      await stop(gw); gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: gwEnv, stdio: 'ignore' });
      check('重启后网关在线', await waitUp());
      const r = await recheck();
      check('★ 明确说出"这是 CodeBuddy 加密的 envelope，不是 JWT"', /envelope/.test(r.error || '') && /不是 JWT/.test(r.error || ''), r.error);
    }

    console.log('\n5. 混合场景：别的渠道还在试，workbuddy 在冷却 —— 502 的 attempts 里也要说清原因');
    {
      // 同一模型挂两家：dead（先试，一直连不上）+ workbuddy（在冷却里）→ 走到 502 那一支
      fs.writeFileSync(cfgPath, JSON.stringify({
        port: GW, health: { intervalSec: 3600, timeoutMs: 8000 }, retries: { perChannel: 0 },
        channels: [
          {
            id: 'wb-demo', name: 'WorkBuddy', protocol: 'workbuddy',
            baseUrl: `http://127.0.0.1:${UP}/v2`, apiKey: fakeJwt, enabled: true,
            models: { 'wb-demo': 'deepseek-v4.1-flash' },
          },
          {
            id: 'dead', name: 'Dead', protocol: 'openai', enabled: true,
            baseUrl: `http://127.0.0.1:${OAI}/v1`, apiKey: 'x', priority: 9,
            models: { 'wb-demo': 'deepseek-v4.1-flash' },
          },
        ],
      }));
      await stop(gw); gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: gwEnv, stdio: 'ignore' });
      check('重启后网关在线（workbuddy 会被打到额度、进冷却；dead 探测正常但聊天 500）', await waitUp(), await waitUp);
      fake.mode = 'quota';
      fake.quotaBody = realQuotaBody(resetLocal(Date.now() + 2 * 3600e3));   // 再压一次：让 workbuddy 进冷却
      await recheck('wb-demo');
      const st5 = await statusOf('dead');
      check('对照前提：dead 是健康的（探测通过、不在冷却）', st5.status === 'ok' && !(st5.cooldownUntil > Date.now()), st5 && st5.status);
      const c = await chat();
      let j = null; try { j = JSON.parse(c.text); } catch { }
      const att = (j && j.error && j.error.attempts) || [];
      const wb = att.find((a) => a.ch === 'wb-demo');
      check('★ 别的渠道失败 + workbuddy 冷却 → attempts 里带上"为什么"与"还有多久"',
        c.code === 502 && !!wb && /in cooldown/.test(wb.err) && /usage exceeds frequency limit/.test(wb.err) && /\d+[hm]/.test(wb.err),
        att);
      check('冷却的候选没有被真的发请求（它的那行不是上游错误）',
        !!wb && !/curl|non-SSE/.test(wb.err), wb);
    }

    console.log('\n6. 对照：token 正常时一切照旧');
    {
      writeCfg(fakeJwt);
      await stop(gw); gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: gwEnv, stdio: 'ignore' });
      check('重启后网关在线', await waitUp());
      fake.mode = 'ok';
      const r = await recheck();
      check('探测通过（真实轻量聊天读到 SSE 即判活）', r.status === 'ok', r);
      const st = await statusOf('workbuddy');
      check('成功后冷却清零、失败计数归零', st.cooldownUntil === 0 && st.consecutiveFail === 0, { cd: st.cooldownUntil, cf: st.consecutiveFail });
      const c = await chat();
      check('★ 聊天链路正常（上游 SSE 全量转发，文本拿到）',
        c.code === 200 && /pong/.test(c.text), { code: c.code, text: c.text.slice(0, 160) });
      check('上游收到的是 OpenAI 报文 + 强制流式（首条 system 也在）',
        fake.lastBody && fake.lastBody.stream === true && fake.lastBody.model === 'deepseek-v4.1-flash'
        && fake.lastBody.messages[0].role === 'system', fake.lastBody);
    }
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message) + '\n' + (e && e.stack ? String(e.stack).split('\n').slice(1, 4).join('\n') : ''));
  } finally {
    await stop(gw);
    try { fake.server.close(); } catch { }
    try { oai.server.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;
})();
