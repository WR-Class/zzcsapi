// arena-agent.js — 宿主机侧 arena.ai sidecar 服务
// 架构：本脚本跑在宿主机（Windows），spawn 真 Chrome headless 并经 CDP 控制，
//       通过 HTTP API (127.0.0.1:9225) 服务容器里的网关。
// 原因：arena.ai 的 Cloudflare 拦截一切非真浏览器指纹（容器内 Alpine Chromium 也被拦），
//       只有宿主机上的真 Chrome 二进制（与用户日常浏览器同款）能通过。
//       Chrome DevTools 又拒绝非 localhost Host 头（容器无法直连 CDP），
//       所以容器网关改为调用本 agent 的 HTTP API。
//
// 端点：
//   POST /ensure   {cookie} → {ok, cookie, models:[{displayName,id}...]}   就绪+模型注册表+最新cookie
//   POST /chat     {payload} → NDJSON 流：{t:'c',d}文本 {t:'g',d}思考 {t:'e',d}错误 {t:'done',ok,status}
//   POST /refresh  {} → {ok, status} 主动续期
//   GET  /healthz  → {ok}
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const arena = require('./arena.js');

const AGENT_PORT = Number(process.env.ZZCSAPI_ARENA_AGENT_PORT || 9225);
const COOKIE_FILE = path.join(__dirname, 'arena-data', 'agent-cookie.txt');

let latestCookie = '';
try { latestCookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim(); } catch {}
// agent 重启后自己的轮换记录可能还没写过：从 config.json 的 arena 渠道兜底（宿主机同目录文件）
if (!latestCookie) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    const arenaCh = (cfg.channels || []).find((x) => x.id === 'arena');
    if (arenaCh && arenaCh.apiKey) latestCookie = arenaCh.apiKey;
  } catch {}
}

arena.sidecar.onPersist = (cookieStr) => {
  latestCookie = cookieStr;
  try { fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true }); fs.writeFileSync(COOKIE_FILE, cookieStr); } catch {}
};

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { if (buf.length < 2_000_000) buf += c; });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function log(...a) { console.log('[arena-agent]', ...a); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, cookie: !!latestCookie, chrome: !!arena.sidecar.proc }));
    }
    if (req.method === 'POST' && url.pathname === '/ensure') {
      const body = await readBody(req);
      const cookie = body.cookie || latestCookie;
      // 网关传了更新的 cookie（用户重新上传）→ 记住它
      if (body.cookie && body.cookie !== latestCookie) latestCookie = body.cookie;
      const reg = await arena.sidecar.ensure(cookie, {});
      const models = [];
      for (const [name, m] of reg.byName) models.push({ displayName: m.displayName, id: m.id });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, cookie: latestCookie || cookie, count: reg.count, models }));
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      const body = await readBody(req);
      if (!body || !body.payload) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'missing payload' })); }
      // agent 刚重启时 sidecar 可能还没起：先确保就绪（幂等，已就绪则秒过）
      // 用 agent 自己的最新 cookie（可能比网关传的更新——轮换先发生在 agent 侧）
      try { await arena.sidecar.ensure(latestCookie || body.cookie || '', {}); } catch (e) {
        log('chat ensure failed:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'agent ensure: ' + String(e && e.message || e) }));
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      let closed = false;
      res.on('close', () => {
        closed = true;
        try { arena.sidecar._evaluate('window.__zzArenaAbort = true', false, 3000).catch(() => {}); } catch {}
      });
      const parser = arena.createArenaStreamParser((evt) => {
        if (closed) return;
        if (evt.type === 'content') res.write(JSON.stringify({ t: 'c', d: evt.text }) + '\n');
        else if (evt.type === 'thinking') res.write(JSON.stringify({ t: 'g', d: evt.text }) + '\n');
        else if (evt.type === 'error') res.write(JSON.stringify({ t: 'e', d: evt.text }) + '\n');
      });
      const r = await arena.sidecar.chat({
        payload: body.payload,
        onChunk: (text) => { if (!closed) parser.push(text); },
        firstChunkTimeoutMs: body.firstChunkTimeoutMs || 300000,
      });
      parser.end();
      if (!closed) {
        res.write(JSON.stringify({ t: 'done', ok: r.ok, status: r.status, err: (r.errText || '').slice(0, 200) }) + '\n');
        res.end();
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/refresh') {
      await arena.sidecar._tick().catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, cookie: latestCookie }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    log('handler error:', e.message);
    try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e && e.message || e) })); } catch {}
  }
});

server.listen(AGENT_PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${AGENT_PORT}`);
});
