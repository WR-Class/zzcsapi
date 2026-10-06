// notion-transport.test.js — notion 出站的**通道链**必须挡住"软墙"（零依赖回归）
//
// 现场（2026-10-06）：Notion 推理接口会返回 200 +
//   {"type":"error","subType":"temporarily-unavailable"} 的"软墙"（通用文案、isRetryable:false），
//   即"反爬式静默拒绝"。用**同一发报文**在四个环境逐一对打，结论是**客户端指纹评分**：
//
//   | 客户端                     | node:20 容器 | node:24 容器 | 宿主机 Node 24 |
//   | curl（HTTP/1.1 或 --http2） | ★真答        | ★真答        | ★真答          |
//   | node:http2                 | 软墙         | ★真答        | ★真答          |
//   | fetch / undici（HTTP/1.1）  | 软墙         | 软墙         | 软墙           |
//
// ⇒ 出站必须是 **curl 主 → h2 兜底 → fetch 最后**，且软墙要在通道内自动换（软墙不消耗真实推理）。
//   历史误判留档：①「账号权益被限、只能等」②「undici TLS 指纹被 block」（方向对，但只做了 curl 一条路，
//   且没意识到 Node 版本会让 h2 的成败翻面）。
//
// 本用例守：
//   §1 notionH2Request 真跑 HTTP/2（本地 h2c 明文 HTTP/2 服务器，无需证书）
//   §2 notionCurlFetch 真跑 curl（本地 HTTP/1.1 服务器；环境无 curl 时如实跳过）
//   §3 notionFetch 的协议门 + 通道链结构（★ curl 主、软墙换 h2、fetch 最后）
//   §4 装配守卫（★ 三处 notion 推理调用点必须用 notion.notionFetch；curl 子进程那条"唯一通道"写法已废）
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const http2 = require('http2');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const notion = require(path.join(ROOT, 'notion.js'));
const NOTION_SRC = fs.readFileSync(path.join(ROOT, 'notion.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0, skip = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
function skipNote(name) { skip++; console.log('  – ' + name + '（环境没有 curl，跳过）'); }

const H2_SESSIONS = new Set();
function startH2Server(handler) {
  return new Promise((resolve) => {
    const srv = http2.createServer(handler);
    srv.on('session', (s) => { H2_SESSIONS.add(s); s.on('close', () => H2_SESSIONS.delete(s)); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
function startH1Server(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
const hasCurl = (() => {
  try {
    const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const r = spawnSync(bin, ['--version'], { windowsHide: true });
    return r.status === 0;
  } catch { return false; }
})();

(async () => {
  console.log('§1 notionH2Request 真跑 HTTP/2（本地 h2c）');

  const seen = [];
  const { srv: h2srv, port: h2port } = await startH2Server((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, body, httpVersion: req.httpVersion });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, got: body }));
    });
  });

  await checkAsync('★ 同一发 POST 走 h2 往返成功（200 + 正文）', async () => {
    const r = await notion.notionH2Request(`http://127.0.0.1:${h2port}/api/v3/runInferenceTranscript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', Cookie: 'token_v2=x' },
      body: '{"hello":"world"}',
    });
    assert.strictEqual(r.status, 200, 'HTTP 200');
    assert.strictEqual(r.ok, true, 'ok');
    assert.strictEqual((await r.json()).got, '{"hello":"world"}', '正文原样到达');
  });

  await checkAsync('★ 服务端看到的确实是 HTTP/2（httpVersion 2.0）', async () => {
    assert.ok(seen.length >= 1, '服务端至少收到一发');
    assert.strictEqual(seen[0].httpVersion, '2.0', '必须是 HTTP/2，不是 1.1');
    assert.strictEqual(seen[0].path, '/api/v3/runInferenceTranscript', '路径原样');
  });

  await checkAsync('出站头原样到达（Notion 那几枚一个不少）', async () => {
    const h = seen[0].headers;
    assert.strictEqual(h['content-type'], 'application/json');
    assert.strictEqual(h['accept'], 'application/x-ndjson');
    assert.strictEqual(h['cookie'], 'token_v2=x');
    assert.strictEqual(h['accept-encoding'], 'identity', '要明文，避免压缩体分支');
    assert.strictEqual(h['content-length'], '17', '正文长度如实');
  });

  await checkAsync('连接级头被剔除（HTTP/2 禁止 host/connection/keep-alive）', async () => {
    const before = seen.length;
    await notion.notionH2Request(`http://127.0.0.1:${h2port}/x`, {
      method: 'POST',
      headers: { host: 'evil.example', connection: 'keep-alive', 'keep-alive': 'timeout=5', 'transfer-encoding': 'chunked', upgrade: 'h2c', 'X-Keep': 'yes' },
      body: 'a',
    });
    const h = seen[seen.length - 1].headers;
    assert.strictEqual(seen.length, before + 1, '请求发出');
    assert.strictEqual(h['x-keep'], 'yes', '普通头保留');
    assert.notStrictEqual(h.host, 'evil.example', '伪造 host 不进 h2 伪头');
    assert.strictEqual(h.connection, undefined, 'connection 已剔');
  });

  await checkAsync('非 2xx 也如实返回（不抛）', async () => {
    const { srv, port } = await startH2Server((req, res) => { res.writeHead(401); res.end('{"isNotionError":true}'); });
    try {
      const r = await notion.notionH2Request(`http://127.0.0.1:${port}/x`, { method: 'POST', body: 'a' });
      assert.strictEqual(r.status, 401);
      assert.strictEqual(r.ok, false);
      assert.ok((await r.text()).includes('isNotionError'));
    } finally { srv.close(); }
  });

  console.log('\n§2 notionCurlFetch 真跑 curl（本地 HTTP/1.1）');

  const curlSeen = [];
  const { srv: h1srv, port: h1port } = await startH1Server((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      curlSeen.push({ method: req.method, path: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ via: 'curl', body }));
    });
  });

  if (!hasCurl) {
    skipNote('★ curl 往返（200 + 正文 + 状态码）');
    skipNote('curl 把出站头与正文原样送达');
  } else {
    await checkAsync('★ curl 往返（200 + 正文 + 状态码）', async () => {
      const r = await notion.notionCurlFetch(`http://127.0.0.1:${h1port}/api/v3/runInferenceTranscript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'notion-client-version': '23.13.20261006.0243' },
        body: '{"q":"收到"}',
        timeoutMs: 15000,
      });
      assert.strictEqual(r.status, 200, 'HTTP 200（状态码来自 -w 标记）');
      assert.strictEqual((await r.json()).body, '{"q":"收到"}', '正文原样');
    });

    await checkAsync('curl 把出站头与正文原样送达', async () => {
      assert.ok(curlSeen.length >= 1, '服务端收到');
      assert.strictEqual(curlSeen[0].headers['notion-client-version'], '23.13.20261006.0243');
      assert.strictEqual(curlSeen[0].body, '{"q":"收到"}');
    });
  }

  await checkAsync('curl 超时抛错（不挂死）', async () => {
    if (!hasCurl) return skipNote('curl 超时');
    const { srv, port } = await startH1Server(() => { /* 故意不回 */ });
    try {
      const t0 = Date.now();
      await assert.rejects(() => notion.notionCurlFetch(`http://127.0.0.1:${port}/hang`, { method: 'POST', body: 'a', timeoutMs: 800 }), /timeout|curl exit/);
      assert.ok(Date.now() - t0 < 9000, '很快返回');
    } finally { srv.close(); }
  });

  console.log('\n§3 notionFetch 的协议门与通道链');

  await checkAsync('http:// → 回落 fetch（假上游与既有测试逐字不变）', async () => {
    const r = await notion.notionFetch(`http://127.0.0.1:${h1port}/fake`, { method: 'POST', body: 'ping' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).via, 'curl', '这一发是 fetch 打的（本地 h1 服务器）');
  });

  check('★ 通道链：curl 主 → 软墙换 h2 → 最后才 fetch', () => {
    const i = NOTION_SRC.indexOf('function notionFetch');
    const seg = NOTION_SRC.slice(i, NOTION_SRC.indexOf('// HTTP/2 内核') > i ? NOTION_SRC.indexOf('// HTTP/2 内核') : i + 3000);
    assert.ok(/u\.protocol !== 'https:'/.test(seg), '协议门在');
    assert.ok(/await notionCurlFetch\(urlStr, opts\)/.test(seg), '★ curl 是主通道（两环境都实测通过）');
    assert.ok(/notionIsSoftWall\(await first\.text\(\)\)/.test(seg), '★ 主通道回来先判软墙');
    assert.ok(/await notionH2Request\(urlStr, opts\)/.test(seg), '★ 软墙/curl 不可用时换 h2');
    assert.ok(!/zzFetch/.test(seg), 'notionFetch 里不许出现 zzFetch（HTTP/1.1 且被墙）');
  });

  check('软墙判据（真值表）', () => {
    assert.strictEqual(notion.notionIsSoftWall('{"type":"error","subType":"temporarily-unavailable"}'), true);
    assert.strictEqual(notion.notionIsSoftWall('{"type":"record-map","recordMap":{}}'), false);
    assert.strictEqual(notion.notionIsSoftWall(''), false);
    assert.strictEqual(notion.notionIsSoftWall(null), false);
  });

  console.log('\n§4 装配守卫（★ 推理路径不许回退到被墙的通道）');

  check('★ server.js 三处 notion 推理调用点都用 notion.notionFetch', () => {
    const hits = SERVER_SRC.match(/notion\.notionFetch\(/g) || [];
    assert.strictEqual(hits.length, 3, '恰好三处（实际 ' + hits.length + '）——少一处就是把某条路留在了被墙的通道上');
  });

  check('★ server.js 里已无 notionCurlRequest（通道选择统一收口到 notionFetch）', () => {
    assert.ok(!/notionCurlRequest/.test(SERVER_SRC), 'notionCurlRequest 已删除');
    const i = SERVER_SRC.indexOf('async function tryNotionChannel');
    const seg = SERVER_SRC.slice(i, i + 4000);
    assert.ok(i > 0, '找得到 tryNotionChannel');
    assert.ok(/notion\.notionFetch\(/.test(seg), '主推理走 notionFetch');
    assert.ok(!/zzFetch\(/.test(seg), 'notion 路径不许用 zzFetch');
  });

  check('notion.js 两条通道都在（curl + h2），fetch 只在非 https 时用', () => {
    assert.ok(/function notionCurlFetch/.test(NOTION_SRC), 'curl 通道在');
    assert.ok(/function notionH2Request/.test(NOTION_SRC), 'h2 通道在');
    assert.ok(/const http2 = require\('http2'\)/.test(NOTION_SRC), '引了 node:http2');
    assert.ok(!/https\.request\(/.test(NOTION_SRC), 'notion.js 里不该有 https.request');
  });

  check('导出面齐全', () => {
    assert.strictEqual(typeof notion.notionFetch, 'function');
    assert.strictEqual(typeof notion.notionH2Request, 'function');
    assert.strictEqual(typeof notion.notionCurlFetch, 'function');
    assert.strictEqual(typeof notion.notionIsSoftWall, 'function');
  });

  check('软墙判据仍在 server.js（回归守不住它，但别让它被顺手删掉）', () => {
    assert.ok(/temporarily-unavailable/.test(SERVER_SRC), '流内错误检测里仍认这个 subType');
  });

  h2srv.close(); h1srv.close();
  for (const s of H2_SESSIONS) { try { s.destroy(); } catch { } }
  const tail = fail ? `有失败：${pass} 通过 / ${fail} 失败` : `全部通过：${pass} 通过 / 0 失败`;
  console.log('\n' + tail + (skip ? `（${skip} 项因环境无 curl 跳过）` : ''));
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('用例自身异常：' + ((e && e.stack) || e.message)); process.exitCode = 1; });
