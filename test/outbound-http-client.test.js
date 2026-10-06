#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/outbound-http-client.test.js — 出站长连接客户端 + 流式写路径（v1.16）
 *
 * 两件事，都是实测出来的开销，不是"看起来更快"：
 *
 * ① 出站不再用 Node 全局 fetch（undici）。同一台机器、同一个回环目标实测：
 *      容器内(Linux)  每跳 1.28ms vs keep-alive http.request 0.54ms（2.4×）
 *                     并发 32 吞吐 881 vs 2012 req/s（只有 44%）
 *      Windows 开发机 每请求 +13ms
 *    网关出站就在流式首字节路径上，所以换成 http/https + keep-alive Agent 的 zzFetch，
 *    接口保持 fetch 形状（status/ok/headers.get/text/json/body.getReader + signal），
 *    调用点零改动。本用例既要守住"接口真的像 fetch"（否则调用点会静默退化），
 *    也要守住"真的复用连接"（否则换了等于没换）。
 *
 * ② 流式写路径：直通模式改为**原始字节转发**（旧的逐行重组会把 CRLF 归一成 LF，
 *    并把每帧拆成"数据行 + 空行"两次写，上游 11 个 TCP 事件变成客户端 24 次写）；
 *    非直通模式把一次 drain 的所有输出合并成一次 write。
 *
 * 跑法：node test/outbound-http-client.test.js   （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-outbound-'));
const GW_KEY = 'ob-gw', AD_KEY = 'ob-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 320) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
// 抠函数：必须跳过字符串/注释里的花括号（源码里有 startsWith('{') 这类字面量），
// 也要跳过**默认参数**里的 {}（zzFetch(urlStr, opts = {}) —— 先按括号配对找到形参表结尾再数花括号）
function extract(name) {
  let i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('server.js 里找不到函数 ' + name);
  if (SRC.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
  const scan = (from, open, close) => {          // 从 from（指向 open 字符）起做配对扫描
    let depth = 0, quote = null, esc = false;
    for (let k = from; k < SRC.length; k++) {
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
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return k; }
    }
    throw new Error('括号不配对：' + name);
  };
  const parenEnd = scan(SRC.indexOf('(', i), '(', ')');
  const bodyStart = SRC.indexOf('{', parenEnd);
  const bodyEnd = scan(bodyStart, '{', '}');
  return SRC.slice(i, bodyEnd + 1);
}
const constLine = (name) => {
  const m = SRC.match(new RegExp('^const ' + name + ' = .*$', 'm'));
  if (!m) throw new Error('server.js 里找不到常量 ' + name);
  return m[0];
};
// 把 zzFetch + makeResponseLite 抠出来在隔离作用域里跑（Agent 由调用方传入，便于数连接）
const zzFetch = new Function(
  'http', 'https', 'URL', 'zlib', 'OUT_HTTP_AGENT', 'OUT_HTTPS_AGENT',
  extract('makeResponseLite') + '\n' + extract('zzFetch') + '\nreturn zzFetch;',
)(http, https, URL, zlib, new http.Agent({ keepAlive: true, maxSockets: 128 }), new https.Agent({ keepAlive: true, maxSockets: 128 }));

/* ── 测试用本机服务：一次覆盖状态码/头/压缩/重定向/分片/中止/连接计数 ── */
function makeServer() {
  const st = { connections: 0, hits: [], writeCount: 0 };
  st.server = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      const raw = Buffer.concat(cs).toString('utf8');
      st.hits.push({ url: req.url, method: req.method, headers: req.headers, raw });
      if (req.url === '/ok') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Case': 'Yes', 'X-Multi': ['a', 'b'] });
        return res.end('{"a":1}');
      }
      if (req.url === '/404') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"e":"nope"}'); }
      if (req.url === '/gzip') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
        return res.end(zlib.gzipSync(Buffer.from('{"gz":true}')));
      }
      if (req.url === '/redir307') { res.writeHead(307, { Location: '/echo' }); return res.end(); }
      if (req.url === '/redir302') { res.writeHead(302, { Location: '/echo' }); return res.end(); }
      if (req.url === '/echo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ method: req.method, body: raw }));
      }
      if (req.url === '/chunked') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: one\n\n'); st.writeCount++;
        setTimeout(() => { res.write('data: two\n\n'); st.writeCount++; }, 20);
        setTimeout(() => { res.end('data: three\r\n\r\n'); st.writeCount++; }, 40);
        return;
      }
      if (req.url === '/slow') return;                       // 永不响应，用于中止用例
      res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok');
    });
  });
  st.server.on('connection', (s) => { st.connections++; s.setNoDelay(true); });
  return st;
}

/* ── 假原生上游：Anthropic SSE，帧间用 CRLF，且故意把一帧拆到两个 TCP 片上 ── */
function makeAnthropicUpstream() {
  const st = { writes: 0, raw: null };
  st.server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'claude-3-5-sonnet-20241022' }] }));
    }
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      const f1 = Buffer.from('event: message_start\r\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":11,"output_tokens":0},"content":[]}}\r\n\r\n');
      const f2head = Buffer.from('event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"text":"你');
      const f2tail = Buffer.from('好"}}\r\n\r\n');
      const f3 = Buffer.from('event: message_delta\r\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\r\n\r\n');
      st.raw = Buffer.concat([f1, f2head, f2tail, f3]);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(f1); st.writes++;
      res.write(f2head); st.writes++;
      setTimeout(() => { res.write(f2tail); st.writes++; }, 25);        // 同一帧劈成两片
      setTimeout(() => { res.end(f3); st.writes++; }, 50);
    });
  });
  return st;
}

(async () => {
  /* ══════════ 0. 装配守卫（源码级） ══════════ */
  console.log('0. 装配守卫');
  {
    const bareFetch = (SRC.match(/(?<![A-Za-z_$.])fetch\(/g) || []).length;
    check('★ server.js 里不再出现裸 fetch(（出站全部走 zzFetch）', bareFetch === 0, bareFetch);

    const awaitCalls = (SRC.match(/await zzFetch\(/g) || []).length;
    // v1.18.42：6 → 4 —— notion 推理的两处（主推理 tryNotionChannel、管理面手动测试）**刻意**改走
    // `notion.notionFetch`（curl 主 → h2 兜底的通道链）：Notion 会对 Node 的 HTTP/1.1 客户端回"软墙"，
    // 那两处留在 zzFetch 上就是留在被墙的通道上。剩下的 4 处是探测 2 + 常规聊天 1 + 原生/直通 1。
    check('★ 4 个出站调用点走 zzFetch（探测 2 + 聊天 1 + 原生/直通 1），notion 推理那 2 处走 notionFetch',
      awaitCalls === 4, awaitCalls);
    const notionOut = (SRC.match(/notion\.notionFetch\(/g) || []).length;
    check('★ notion 推理的三处（主推理 / 流断取回 / 管理面手动测试）都走 notionFetch 的通道链',
      notionOut === 3, notionOut);

    const modArgs = (SRC.match(/, zzFetch, /g) || []).length;
    check('★ notion / notion-agent 模块拿到的也是 zzFetch（11 处实参）', modArgs === 11, modArgs);
    check('★ 后台任务注入的 fetchFn 也是 zzFetch', /fetchFn: zzFetch,/.test(SRC));

    check('★ 客户端自带 keep-alive Agent（没有它，换掉 undici 只是换了个不复用的客户端）',
      /const OUT_HTTP_AGENT = new http\.Agent\(\{ keepAlive: true/.test(SRC)
      && /const OUT_HTTPS_AGENT = new https\.Agent\(\{ keepAlive: true/.test(SRC));

    check('★ 直通流式走原始字节转发：passthroughWrite 里是 res.write(u8)，不是按行拼字符串',
      /const passthroughWrite = \(u8\) => \{[\s\S]{0,200}?res\.write\(u8\);/.test(SRC));
    check('★ handleLine 里已经不存在直通分支（直通不再进逐行重组路径）',
      !/const handleLine = \(line\) => \{\s*\n\s*if \(passthrough\)/.test(SRC));
    check('★ 旁路的 usage 扫描仍在（字节直接转发，但真实 token 不能丢）',
      /nativeStreamUsageScan\(passthrough, line, passthroughUsage\)/.test(SRC));

    check('★ 非直通合并写：handleLine 只 push，写回只此一处',
      /outChunks\.push\(line \+ '\\n'\)/.test(SRC)
      && (SRC.match(/res\.write\(outChunks\.join\(''\)\)/g) || []).length === 1
      && !/const handleLine = \(line\) => \{[\s\S]*?\n    \};[\s\S]{0,40}?res\.write\(/.test(SRC));
  }

  /* ══════════ 1. zzFetch 的 fetch 形状（真值表） ══════════ */
  console.log('\n1. zzFetch 的 fetch 形状');
  const srv = makeServer();
  {
    const port = await freePort();
    await new Promise((r) => srv.server.listen(port, '127.0.0.1', r));
    const base = `http://127.0.0.1:${port}`;

    const r1 = await zzFetch(base + '/ok');
    check('200 → status 200 且 ok === true', r1.status === 200 && r1.ok === true, r1.status);
    check('headers.get 大小写不敏感', r1.headers.get('X-CASE') === 'Yes' && r1.headers.get('x-case') === 'Yes');
    check('同名多头按 fetch 规则用 ", " 连接', r1.headers.get('x-multi') === 'a, b', r1.headers.get('x-multi'));
    check('headers.get 不存在的头返回 null（不是 undefined）', r1.headers.get('x-nope') === null);
    check('json() 能解析', (await r1.json()).a === 1);

    const r2 = await zzFetch(base + '/ok');
    const t1 = await r2.text();
    const t2 = await r2.text();
    check('text() 可重复调用且第二次不重读（PT23 那类 shim 坑的同族）', t1 === '{"a":1}' && t2 === t1, [t1, t2]);

    const r3 = await zzFetch(base + '/404');
    check('404 → ok === false（调用点靠它分失败）', r3.status === 404 && r3.ok === false);

    const r4 = await zzFetch(base + '/gzip');
    check('上游硬塞 gzip 也自动解压（即使我们请求的是 identity）', (await r4.text()) === '{"gz":true}', await r4.text());

    const r5 = await zzFetch(base + '/redir307', { method: 'POST', body: 'x=1' });
    const j5 = await r5.json();
    check('307 跟随且保留 POST 与请求体（与 fetch 一致）', j5.method === 'POST' && j5.body === 'x=1', j5);

    const r6 = await zzFetch(base + '/redir302', { method: 'POST', body: 'x=1' });
    const j6 = await r6.json();
    check('302 跟随并退化成 GET、不带体（与 fetch 一致）', j6.method === 'GET' && j6.body === '', j6);

    const r7 = await zzFetch(base + '/echo', { method: 'POST' });
    const j7 = await r7.json();
    check('POST 无 body 时补 Content-Length: 0', j7.method === 'POST' && srv.hits[srv.hits.length - 1].headers['content-length'] === '0');
    check('未显式指定时请求 Accept-Encoding: identity（自己解压，不赌上游）', srv.hits[srv.hits.length - 1].headers['accept-encoding'] === 'identity');

    // body.getReader()：与 fetch 的 reader 同语义
    const r8 = await zzFetch(base + '/chunked');
    const reader = r8.body.getReader();
    const dec = new TextDecoder();
    let text = '', rounds = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; rounds++; text += dec.decode(value, { stream: true }); }
    check('body.getReader() 逐片可读，读完 done === true', text === 'data: one\n\ndata: two\n\ndata: three\r\n\r\n', text);
    check('分片没有被合并成一片（reader 保留上游分帧）', rounds >= 2, rounds);
    check('★ 原始 CRLF 没有被改写（这是直通字节一致的基础）', text.includes('three\r\n\r\n'));

    // 中止语义
    const ctrl = new AbortController();
    const p9 = zzFetch(base + '/slow', { signal: ctrl.signal }).then(() => 'resolved', (e) => e);
    setTimeout(() => ctrl.abort(), 30);
    const e9 = await p9;
    check('signal.abort() 后以 AbortError 拒绝（调用点按 err.message 记失败）', e9 && e9.name === 'AbortError', e9 && e9.name);

    // keep-alive 复用：对照组用 agent:false（每请求新建连接），证明计数器能区分两者
    const before = srv.connections;
    for (let i = 0; i < 20; i++) await zzFetch(base + '/ok').then((r) => r.text());
    const reused = srv.connections - before;
    const beforeCtl = srv.connections;
    for (let i = 0; i < 20; i++) {
      await new Promise((res, rej) => {
        const rq = http.request({ host: '127.0.0.1', port, path: '/ok', method: 'GET', agent: false }, (rs) => { rs.resume(); rs.on('end', res); });
        rq.on('error', rej); rq.end();
      });
    }
    const ctl = srv.connections - beforeCtl;
    check('★ 20 次请求 0 条新 TCP 连接（keep-alive 真的复用），对照组 agent:false 建了 20 条',
      reused === 0 && ctl === 20, { reused, ctl });
  }

  /* ══════════ 2. 真链路：直通流式逐字节一致（含 CRLF 与跨片帧） ══════════ */
  console.log('\n2. 直通流式：字节一致 + 分帧对齐');
  const up = makeAnthropicUpstream();
  {
    const UP = await freePort(), GW = await freePort();
    await new Promise((r) => up.server.listen(UP, '127.0.0.1', r));
    const cfg = path.join(TMP, 'cfg.json'), usage = path.join(TMP, 'usage.json');
    fs.writeFileSync(cfg, JSON.stringify({
      port: GW,
      health: { intervalSec: 3600, timeoutMs: 8000 },
      channels: [{ id: 'ant-raw', name: 'ant-raw', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${UP}`, apiKey: 'k', priority: 1, models: { 'pt-raw': 'claude-3-5-sonnet-20241022' } }],
    }));
    const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, stdio: 'ignore',
      env: { ...process.env, ZZCSAPI_CONFIG: cfg, ZZCSAPI_USAGE: usage, GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
    });
    let upNow = false;
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${GW}/healthz`)).ok) { upNow = true; break; } } catch { } await sleep(150); }
    check('临时网关起来了', upNow);
    await sleep(700);

    // 用原始 socket 观察服务端到底写了几次（每片 ≈ 一次 write）
    const received = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: 'pt-raw', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] });
      const chunks = [];
      const req = http.request({
        host: '127.0.0.1', port: GW, path: '/anthropic/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'x-api-key': GW_KEY, Authorization: `Bearer ${GW_KEY}`,
          'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, chunks, buf: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end(body);
    });

    check('HTTP 200', received.status === 200, received.status);
    check('★ 客户端收到的字节与上游发出的**逐字节相等**（含 CRLF、含被劈开的帧）',
      up.raw && received.buf.equals(up.raw),
      { up: up.raw && up.raw.length, got: received.buf.length, same: up.raw ? received.buf.equals(up.raw) : null });
    check('★ CRLF 原样保留（旧的逐行重组会归一成 LF）', received.buf.toString('utf8').includes('message_start\r\n'));
    check('★ 写入次数不超过上游分片数（旧写法每帧拆成"数据行 + 空行"两次写）',
      received.chunks.length <= up.writes, { client: received.chunks.length, upstream: up.writes });

    // 旁路扫描仍要拿到真实 token
    const usageJ = await fetch(`http://127.0.0.1:${GW}/admin/api/usage`, { headers: { Authorization: `Bearer ${AD_KEY}` } }).then((r) => r.json());
    const rec = (usageJ.recent || [])[0] || {};
    check('★ 字节直传的同时，真实 usage 仍被记录（11 / 7）', rec.in === 11 && rec.out === 7, { in: rec.in, out: rec.out });

    try { gw.kill(); } catch { }
  }

  try { srv.server.close(); } catch { }
  try { up.server.close(); } catch { }
  await sleep(200);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }

  console.log('\n' + '─'.repeat(58));
  if (fail) { console.log(`✗ ${pass} 通过 / ${fail} 失败`); process.exitCode = 1; }
  else console.log(`✓ 全部通过（${pass} 项断言）`);
})();
