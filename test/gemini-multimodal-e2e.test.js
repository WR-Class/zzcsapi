#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/gemini-multimodal-e2e.test.js — 图片链路端到端回归（真起进程，零依赖）
 *
 * 与 test/gemini-multimodal.test.js 的分工：
 *   · 那个是**单元级**：现抠函数源码，验证转换与裁剪的形态（快，秒级）。
 *   · 这个是**端到端**：真起「假上游 + 临时网关实例」，走完整 HTTP 链路，验证
 *     客户端协议 → 网关 → 上游 的实际字节，以及鉴权头、错误码、响应形态。
 *
 * 为什么需要它：
 *   本脚本在 v1.1 一次性抓到了 PT23（非流式 shim 缺 `json()` → Gemini/Anthropic 非流式请求
 *   一律 502）。单元级测试覆盖不到那种"函数都在、就是接头不对"的缺陷——它只在真 HTTP 链路上现形。
 *
 * 安全约束（很重要）：
 *   · 用**动态空闲端口**，不碰 8787；
 *   · 配置与用量写到系统临时目录（`ZZCSAPI_CONFIG` / `ZZCSAPI_USAGE`），
 *     **绝不读写仓库里的 config.json / usage.json**（那是使用者正在跑的真实数据）；
 *   · 上游是本地假服务，不出网、不消耗任何真实额度。
 *
 * 跑法：node test/gemini-multimodal-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const IMG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-e2e-'));
const GW_KEY = 'e2e-gw', AD_KEY = 'e2e-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 240) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/* ── 假上游：只认 OpenAI 协议，记录收到的 messages ── */
let lastMessages = null;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { }
    if (body) lastMessages = body.messages;
    if (req.method === 'GET' && /models/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-vision' }] }));
    }
    const sawImg = JSON.stringify(body || {}).includes('"image_url"');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock', object: 'chat.completion', model: body && body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: sawImg ? 'MOCK-SAW-IMAGE' : 'MOCK-TEXT-ONLY' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});

function startGateway(cfgPath, port) {
  return spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
    stdio: 'ignore',
  });
}
async function waitUp(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true; } catch { }
    await sleep(200);
  }
  return false;
}
async function call(port, p, body, headers) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  let txt = ''; try { txt = await r.text(); } catch { }
  let json = null; try { json = JSON.parse(txt); } catch { }
  return { status: r.status, json, txt, channel: r.headers.get('X-ZZCSAPI-Channel') };
}
const bearer = (extra = {}) => ({ Authorization: `Bearer ${GW_KEY}`, ...extra });

const writeCfg = (file, port, channels) => {
  const p = path.join(TMP, file);
  fs.writeFileSync(p, JSON.stringify({ port, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 1, maxModelFallbacks: 99 }, channels }, null, 2));
  return p;
};

(async () => {
  const UP_PORT = await freePort(), GW_PORT = await freePort(), GW2_PORT = await freePort();
  await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

  const cfgMain = writeCfg('main.json', GW_PORT, [
    { id: 'mock-openai', name: 'mock openai', protocol: 'openai', baseUrl: `http://127.0.0.1:${UP_PORT}/v1`, apiKey: 'sk-mock', priority: 1, enabled: true, models: { 'mock-vision': 'mock-vision' } },
    { id: 'mock-notion', name: 'mock notion', protocol: 'notion', baseUrl: 'http://127.0.0.1:1', apiKey: 'token_v2=mock', priority: 99, enabled: true, models: { 'mock-vision': 'mock-vision' } },
  ]);
  const cfgNoImg = writeCfg('noimg.json', GW2_PORT, [
    { id: 'mock-notion-only', name: 'mock notion only', protocol: 'notion', baseUrl: 'http://127.0.0.1:1', apiKey: 'token_v2=mock', priority: 99, enabled: true, models: { 'mock-vision': 'mock-vision' } },
  ]);
  const gw = startGateway(cfgMain, GW_PORT), gw2 = startGateway(cfgNoImg, GW2_PORT);
  const cleanup = () => {
    try { gw.kill(); } catch { }
    try { gw2.kill(); } catch { }
    try { upstream.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  };

  try {
    if (!await waitUp(GW_PORT) || !await waitUp(GW2_PORT)) throw new Error('临时网关未起来（端口 ' + GW_PORT + '/' + GW2_PORT + '）');
    const gwPath = `/gemini/v1beta/models/mock-vision:generateContent`;

    console.log('\n1. Gemini 协议带图（inlineData）→ 上游必须原样收到 image_url');
    lastMessages = null;
    let r = await call(GW_PORT, gwPath, { contents: [{ role: 'user', parts: [{ text: '这图什么颜色？' }, { inlineData: { mimeType: 'image/png', data: IMG } }] }] }, bearer());
    check('HTTP 200', r.status === 200, r);
    check('走的是能转图的 openai 渠道（notion 渠道被裁掉）', r.channel === 'mock-openai', r.channel);
    const m1 = lastMessages && lastMessages[0];
    check('上游收到 block 数组形态的 content', Array.isArray(m1 && m1.content), m1 && m1.content);
    check('image_url 与客户端字节一致（data URL 未被改动）',
      !!(m1 && Array.isArray(m1.content) && m1.content[1] && m1.content[1].image_url.url === 'data:image/png;base64,' + IMG), m1 && m1.content);
    check('文本仍在图片之前（部件顺序保留）', !!(m1 && m1.content[0] && m1.content[0].text === '这图什么颜色？'));
    check('响应被转回 Gemini 形态', !!(r.json && r.json.candidates && r.json.candidates[0].content.parts[0].text === 'MOCK-SAW-IMAGE'), r.json);

    console.log('\n2. 同路由纯文本（不得回归）');
    lastMessages = null;
    r = await call(GW_PORT, gwPath, { contents: [{ role: 'user', parts: [{ text: '只发文本' }] }] }, bearer());
    const m2 = lastMessages && lastMessages[0];
    check('纯文本仍是字符串形态（兼容只认 string 的上游）', typeof (m2 && m2.content) === 'string', m2 && m2.content);
    check('响应文本正确', !!(r.json && r.json.candidates && r.json.candidates[0].content.parts[0].text === 'MOCK-TEXT-ONLY'), r);

    console.log('\n3. OpenAI 协议带图（对照：内部格式本来就该是 image_url）');
    lastMessages = null;
    r = await call(GW_PORT, '/v1/chat/completions', { model: 'mock-vision', messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + IMG } }] }] }, bearer());
    check('HTTP 200 且上游收到 image_url', r.status === 200 && !!(lastMessages && JSON.stringify(lastMessages).includes('image_url')), r.status);

    console.log('\n4. Anthropic 协议带图（同样是非流式，PT23 的既有缺陷也在这条路上）');
    lastMessages = null;
    r = await call(GW_PORT, '/anthropic/v1/messages', { model: 'mock-vision', max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: IMG } }] }] }, bearer());
    check('HTTP 200 且 mime 保持 jpeg', r.status === 200 && !!(lastMessages && JSON.stringify(lastMessages).includes('data:image/jpeg;base64,' + IMG)), r.status);
    check('响应被转回 Anthropic 形态', !!(r.json && r.json.content && r.json.content[0].text === 'MOCK-SAW-IMAGE'), r.json);

    console.log('\n5. 没有可转图渠道时：明确报错，不静默丢图');
    const imgGem = { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: IMG } }] }] };
    r = await call(GW2_PORT, gwPath, imgGem, bearer());
    check('Gemini 路由 → 400（不是 200 后丢图作答）', r.status === 400, r.status);
    check('错误文案说明原因', !!(r.txt && r.txt.includes('only openai-protocol channels')), r.txt.slice(0, 160));
    r = await call(GW2_PORT, '/v1/chat/completions', { model: 'mock-vision', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + IMG } }] }] }, bearer());
    check('OpenAI 路由同样 400', r.status === 400, r.status);
    r = await call(GW2_PORT, '/anthropic/v1/messages', { model: 'mock-vision', max_tokens: 8, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG } }] }] }, bearer());
    check('Anthropic 路由同样 400', r.status === 400, r.status);

    console.log('\n6. 纯文本不受能力门影响（只有 notion 渠道时，老行为照旧）');
    r = await call(GW2_PORT, gwPath, { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, bearer());
    check('未误报图片错误文案', !(r.txt || '').includes('only openai-protocol channels'), r.status + ' ' + (r.txt || '').slice(0, 120));

    console.log('\n7. 原生 SDK 鉴权头（PT24）');
    const txtBody = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    r = await call(GW_PORT, gwPath, txtBody, { 'x-goog-api-key': GW_KEY });
    check('Gemini 路由只带 x-goog-api-key（无 Authorization）→ 200', r.status === 200, r.status + ' ' + r.txt.slice(0, 100));
    r = await call(GW_PORT, gwPath + '?key=' + GW_KEY, txtBody, {});
    check('Gemini 路由 ?key= 查询参数 → 200', r.status === 200, r.status);
    r = await call(GW_PORT, gwPath, txtBody, { 'x-goog-api-key': 'wrong' });
    check('错误 x-goog-api-key → 401（不无脑放行）', r.status === 401, r.status);
    r = await call(GW_PORT, '/anthropic/v1/messages', { model: 'mock-vision', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': GW_KEY });
    check('Anthropic 路由只带 x-api-key → 200', r.status === 200, r.status + ' ' + r.txt.slice(0, 100));
    let g = await fetch(`http://127.0.0.1:${GW_PORT}/admin/api/status`, { headers: { 'x-api-key': AD_KEY, 'x-goog-api-key': AD_KEY } });
    check('管理面不接受这两个头 → 401（无提权）', g.status === 401, g.status);
    g = await fetch(`http://127.0.0.1:${GW_PORT}/admin/api/status`, { headers: { Authorization: `Bearer ${AD_KEY}` } });
    check('管理面 Bearer 仍正常 → 200', g.status === 200, g.status);
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    cleanup();
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exit(fail ? 1 : 0);
})();
