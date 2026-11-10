#!/usr/bin/env node
/* 渠道级「正文命中就判失败」回归（node test/channel-drop-if-body-e2e.test.js，零依赖）
 *
 * 现场（v1.18.95，free.hiyo.top）：它按 User-Agent 做客户端白名单，不认就回
 *   **HTTP 200 + 正常结构 + 正文只有一句固定话术**，并带 `usage:{prompt_tokens:0,completion_tokens:1}`。
 *   于是网关把它记成**成功**、不换家、账本一片绿，客户端只拿到一句废话。
 *   这正是本项目 v1.18.26 / v1.18.32 修过的同一族"幽灵成功"，只是这次判据是**正文内容**。
 *
 * 守四条：
 *  ① **非流式**：命中 → 判失败、**切下一家**（响应未提交，真换得了家）
 *  ② **流式首块**：命中 → 判失败、切下一家（关键：必须在 writeHead **之前**，否则写完就换不了）
 *  ③ **没配这个字段的渠道零影响**（对照组：同一个上游、同样的话术、但没配 → 照旧当成功）
 *  ④ 落库往返 + 三态语义（保存别的渠道后仍在、显式空数组 = 清空）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-dropif-'));
const FAKE = '本站仅限主流 Coding 客户端';   // 假上游要回的那句话

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
function startGateway(cfgPath, port) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage.json'),
      ZZCSAPI_NOAUTH: '1', ZZCSAPI_BIND: '127.0.0.1', ZZCSAPI_DUMP_BODIES: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}

console.log('\n渠道级「正文命中就判失败」');
(async () => {
  const upPort = await freePort();
  const gwPort = await freePort();
  let fakeHits = 0, goodHits = 0;

  /* 假上游：/fake 回那句固定话术（200 + 正常结构 + 0进1出）；
     /good 回正常的 SSE / JSON。探测路径一律放行。 */
  const upstream = http.createServer((req, res) => {
    const u = String(req.url || '');
    /* ★ 探测路径必须放行：网关启动会打 /models 之类的健康探测，
       不放行会把渠道直接打进冷却，后面的请求一个都发不出去（第一版就是这么红的：
       `all channels in cooldown` + fakeHits 恒为 0）。 */
    if (!/chat\/completions/.test(u)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }] }));
      req.resume();
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const isFake = u.startsWith('/fake');
      const wantStream = (() => { try { return JSON.parse(body || '{}').stream === true; } catch { return false; } })();
      if (isFake) {
        fakeHits++;
        /* 关键：**即使 stream:true 也回整段 JSON**（现场就是这样） */
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-freeblock000', object: 'chat.completion', created: 1750000000, model: 'gpt-5.5',
          choices: [{ index: 0, message: { role: 'assistant', content: FAKE + '/CLI 使用……当前客户端不支持。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
        }));
        return;
      }
      goodHits++;
      if (wantStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"REAL"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'REAL' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
      }
    });
  });
  await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: gwPort, health: { intervalSec: 3600, timeoutMs: 3000 },
    retries: { perChannel: 0, maxModelFallbacks: 99 },
    channels: [
      /* 主渠道：命中判据就判失败 → 链会切到 bare */
      { id: 'hit', name: 'hit', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/fake`, apiKey: 'k', enabled: true, priority: 100, models: { m1: 'm1' }, dropIfBodyContains: [FAKE] },
      /* 对照组：同一个假上游、同一句话术，但**没配**判据 → 应当照旧当成功 */
      { id: 'nohit', name: 'nohit', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/fake`, apiKey: 'k', enabled: false, priority: 1, models: { m1: 'm1' } },
      /* 兜底：正常上游 */
      { id: 'bare', name: 'bare', protocol: 'openai', baseUrl: `http://127.0.0.1:${upPort}/good`, apiKey: 'k', enabled: true, priority: 0, models: { m1: 'm1' } },
    ],
  }));
  const gw = startGateway(cfgPath, gwPort);
  const base = `http://127.0.0.1:${gwPort}`;

  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { up = (await fetch(base + '/healthz')).ok; } catch { await sleep(120); }
    }
    check('临时网关起来了', up);
    if (!up) throw new Error('gateway not up');

    const call = async (stream, chHint) => {
      const h = { 'Content-Type': 'application/json' };
      if (chHint) h['X-ZZCSAPI-Channel'] = chHint;
      const r = await fetch(base + '/v1/chat/completions', {
        method: 'POST', headers: h,
        body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream }),
      });
      const t = await r.text();
      return { status: r.status, text: t, land: r.headers.get('x-zzcsapi-channel') || '' };
    };

    /* ── 1. 非流式：命中 → 切家 ── */
    console.log('\n1. 非流式：正文命中 → 判失败并切下一家');
    {
      fakeHits = 0; goodHits = 0;
      const r = await call(false, 'hit');
      check('请求最终成功（由兜底渠道服务）', r.status === 200, { status: r.status, head: r.text.slice(0, 120) });
      check('★ 客户端拿到的是**真回复**，不是那句固定话术', r.text.includes('REAL') && !r.text.includes(FAKE), { head: r.text.slice(0, 160) });
      check('★ 命中判据的渠道确实被打了（说明它真被尝试过，不是被跳过）', fakeHits >= 1, { fakeHits });
      check('★ 而且立刻切到了兜底渠道（不是靠重试蒙对的）', goodHits >= 1, { goodHits });
    }

    /* ── 2. 流式：命中 → 必须在写头之前切走 ── */
    console.log('\n2. 流式：首块命中 → 判失败并切下一家（关键：写头之前）');
    {
      /* 上一节把 `hit` 记了失败 → 进了 5 秒冷却。不等它过去，这一节会直接跳过 hit，
         `fakeHits` 恒为 0，断言会因为**错误的原因**而红（第一版就是这么红的）。 */
      await sleep(6500);
      fakeHits = 0; goodHits = 0;
      const r = await call(true, 'hit');
      check('请求最终成功', r.status === 200, { status: r.status });
      check('★ 客户端拿到的是真正文 REAL', r.text.includes('REAL'), { head: r.text.slice(0, 160) });
      check('★ 而不是那句固定话术（说明首块就被拦下、没写出去）', !r.text.includes(FAKE), { head: r.text.slice(0, 160) });
      check('★ 命中渠道被尝试过、且已切到兜底', fakeHits >= 1 && goodHits >= 1, { fakeHits, goodHits });
    }

    /* ── 3. 对照组：没配这个字段 → 零影响 ── */
    console.log('\n3. 对照组：同一上游、同一句话术，但没配判据 → 照旧当成功');
    {
      const st = await (await fetch(base + '/admin/api/channels')).json();
      const list = st.channels || st || [];
      const hitCh = list.find((c) => c.id === 'hit');
      const nohitCh = list.find((c) => c.id === 'nohit');
      check('★ 配了判据的渠道 GET 里能看见该字段（控制台要能回填）',
        Array.isArray(hitCh.dropIfBodyContains) && hitCh.dropIfBodyContains[0] === FAKE, hitCh.dropIfBodyContains);
      check('★ 没配的渠道 GET 里没有这个字段（不凭空造）',
        nohitCh.dropIfBodyContains === undefined, nohitCh.dropIfBodyContains);

      /* 把 hit 停用、nohit 启用 → 同一句话术应当**照旧被当成功** */
      await fetch(base + '/admin/api/channel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'hit', enabled: false }),
      });
      await fetch(base + '/admin/api/channel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'nohit', enabled: true }),
      });
      await sleep(200);
      const r = await call(false);
      check('★ 没配判据时同样的话术**照旧原样返回**（默认零影响，不是偷偷拦了）',
        r.text.includes(FAKE), { head: r.text.slice(0, 140) });
      /* 复原 */
      await fetch(base + '/admin/api/channel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'hit', enabled: true }) });
      await fetch(base + '/admin/api/channel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'nohit', enabled: false }) });
    }

    /* ── 4. 落库往返 + 三态 ── */
    console.log('\n4. 落库往返与三态语义');
    {
      const post = (b) => fetch(base + '/admin/api/channels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ id: 'hit', name: 'hit', baseUrl: `http://127.0.0.1:${upPort}/fake`, protocol: 'openai', apiKey: 'k', models: { m1: 'm1' } }, b)),
      });
      /* 保存一个**别的**渠道，这条配置不许被抹掉（PT29 一族第五例） */
      await fetch(base + '/admin/api/channels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'other', name: 'other', baseUrl: `http://127.0.0.1:${upPort}/good`, protocol: 'openai', apiKey: 'k', models: { m1: 'm1' } }),
      });
      const disk1 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const diskHit = (disk1.channels || []).find((c) => c.id === 'hit');
      check('★ 保存别的渠道后，dropIfBodyContains 仍在磁盘上（白名单没漏）',
        Array.isArray(diskHit.dropIfBodyContains) && diskHit.dropIfBodyContains[0] === FAKE, diskHit.dropIfBodyContains);

      /* 显式空数组 = 清空 */
      await post({ dropIfBodyContains: [] });
      const disk2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const d2 = (disk2.channels || []).find((c) => c.id === 'hit');
      check('★ 显式空数组 = 清空（不是"没意见"）', !d2.dropIfBodyContains || !d2.dropIfBodyContains.length, d2.dropIfBodyContains);

      /* 字段缺省 = 沿用旧值 */
      await post({ dropIfBodyContains: [FAKE] });
      await post({ name: 'hit-renamed' });
      const disk3 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const d3 = (disk3.channels || []).find((c) => c.id === 'hit');
      check('★ 字段缺省时沿用旧值（不是清空）',
        Array.isArray(d3.dropIfBodyContains) && d3.dropIfBodyContains[0] === FAKE, d3.dropIfBodyContains);

      /* 超长/超条数 400 */
      const rLong = await post({ dropIfBodyContains: ['x'.repeat(300)] });
      check('★ 单条超 200 字符 → 400（不静默截断）', rLong.status === 400, rLong.status);
      const rMany = await post({ dropIfBodyContains: Array(9).fill('a') });
      check('★ 超过 8 条 → 400 且报出实际条数', rMany.status === 400 && /9/.test(await rMany.text()), rMany.status);
    }
  } finally {
    try { gw.kill('SIGKILL'); } catch { /* 已退出 */ }
    try { upstream.close(); } catch { /* 已关 */ }
  }

  console.log('\n' + '─'.repeat(58));
  if (fail === 0) console.log(`✓ 全部通过（${pass} 项断言）`);
  else { console.log(`✗ ${pass} 通过 / ${fail} 失败`); process.exitCode = 1; }
})();
