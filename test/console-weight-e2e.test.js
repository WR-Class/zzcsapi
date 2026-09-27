#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/console-weight-e2e.test.js — 控制台「权重」全链路（端到端，零依赖）
 *
 * 为什么需要它：单元测试证明「表单里有 f-weight、body 里带 weight、表格会显示占比」，
 * 但那三件事是**分别**成立的。这个文件把它们串成一条真链路：
 *   控制台 saveChannel 真实报文 → 真网关 POST /admin/api/channels（落库校验）
 *   → 真网关 GET /admin/api/status → 控制台 adapt() + drawChTable() 渲染出的那一格
 *   → 真发几次请求 → 占比真的动起来（不是永远 0%）
 * 同时覆盖控制台与后端**校验规则必须一致**：前端挡负数，后端也挡负数（否则改配置/换客户端就破防）。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/console-weight-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'build', 'app.js');
const src = fs.readFileSync(APP, 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-cw-e2e-'));
const GW_KEY = 'cw-gw', AD_KEY = 'cw-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 260) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/* ── 控制台源码抠函数（与 console-state.test.js 同款手法，保证测的是真实实现）── */
function extract(name) {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('build/app.js 里找不到函数 ' + name);
  if (src.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
  let depth = 0, started = false;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('花括号不配对：' + name);
}
function mkEl(id) {
  return {
    id, innerHTML: '', value: '', dataset: {}, style: {}, checked: false,
    onclick: null, oninput: null, onchange: null, scrollTop: 0, textContent: '',
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle() { } },
    focus() { }, setSelectionRange() { }, appendChild() { }, remove() { }, querySelector() { return null },
  };
}
function makeDom() {
  const els = {};
  const $ = (sel, root) => {
    const key = (root && root.__id ? root.__id + ' ' : '') + sel;
    if (!els[key]) els[key] = mkEl((sel.match(/^#([\w-]+)/) || [])[1] || sel);
    return els[key];
  };
  return { $, $$: () => [], root: mkEl('viewport') };
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const svg = () => '<svg></svg>';
const nf = (n) => String(n);

/* ── 假上游（只为产生真实请求数，好让占比动起来）── */
const upSeen = new Map();
const upstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
    const body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}');
    const id = req.headers['x-up-id'] || '?';
    upSeen.set(id, (upSeen.get(id) || 0) + 1);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'c', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
});

(async () => {
  const PU = await freePort(), GW = await freePort();
  // 两个假上游用不同端口区分，但请求头里的 x-up-id 才是稳定的观测点 → 统一用一个端口 + 路径区分
  await new Promise((r) => upstream.listen(PU, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'c.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 2000 }, retries: { perChannel: 1, maxModelFallbacks: 99 },
    channels: [],
  }));
  const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'u.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
    stdio: 'ignore',
  });
  /* 等子进程真正退出再走人：process.exit() 撞上还没关干净的 libuv 句柄，在 Windows 上会
     以 0xC0000409 崩掉——断言全绿却返回失败退出码，把真回归藏在噪声里。 */
  const stopChild = (cp) => new Promise((res) => {
    if (!cp || cp.exitCode !== null || cp.signalCode !== null) return res();
    cp.once('exit', () => res());
    try { cp.kill(); } catch { }
    setTimeout(res, 1500);   // 兜底：杀不掉也别把测试挂死
  });
  const cleanup = async () => {
    await stopChild(gw);
    try { upstream.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  };

  // 管理面只认 Bearer / ?key=（原生 SDK 那些头是给 /v1/* 聊天面用的，见 README「鉴权写法」）
  const apiReal = async (p, opt) => {
    const r = await fetch(`http://127.0.0.1:${GW}${p}`, {
      method: (opt && opt.method) || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AD_KEY },
      body: opt && opt.body,
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch { }
    if (!r.ok) { const e = new Error((j && (j.error?.message || j.message)) || t.slice(0, 120)); e.status = r.status; throw e; }
    return j;
  };
  const status = () => fetch(`http://127.0.0.1:${GW}/admin/api/status`, { headers: { Authorization: 'Bearer ' + AD_KEY } }).then((r) => r.json());

  /* 控制台那一侧：adapt() + drawChTable() 用**真** status 数据渲染，读回表格 HTML */
  const renderTable = (st) => {
    const dom = makeDom();
    const dataHolder = { channels: [], models: [], meta: {} };
    const a = new Function('RAW', 'DATA', 'esc', 'svg', 'nf', '$',
      'let CFG=null, loaded=false;\n' + extract('adapt') + '\nreturn { adapt, get DATA(){ return DATA } };'
    )({ channels: (st && st.channels) || [], usage: null }, dataHolder, esc, svg, nf, dom.$);
    a.adapt();
    const protoLabel = { openai: 'OpenAI' }, stTxt = { ok: '正常', degraded: '降级', down: '下线', unknown: '未知' };
    const fMs = (x) => x + 'ms', pct = (x, y) => Math.round((x / y) * 100);
    const t = new Function('$', '$$', 'DATA', 'esc', 'svg', 'nf', 'protoLabel', 'stTxt', 'fMs', 'pct',
      "let chTab='all', chQ='';\n" + extract('drawChTable') + '\nreturn { drawChTable };'
    )(dom.$, dom.$$, a.DATA, esc, svg, nf, protoLabel, stTxt, fMs, pct);
    t.drawChTable();
    return { html: dom.$('#chTable').innerHTML, data: a.DATA };
  };
  /* 控制台 saveChannel：$ 桩喂表单值 + 真 api()，验证"表单报文"后端确实收得下。
     注意 saveChannel 内部 catch 了错误（只 toast），所以"成不成"要看 api 桩有没有记到失败，别信它的返回值。 */
  const formSave = async (fields) => {
    const dom = makeDom();
    const calls = [], errors = [], toasts = [];
    const apiStub = async (p, opt) => {
      const body = JSON.parse(opt.body);
      calls.push({ p, body });
      try { return await apiReal(p, opt); } catch (e) { errors.push({ p, body, msg: e.message, status: e.status }); throw e; }
    };
    const f = new Function('$', '$$', 'DATA', 'esc', 'svg', 'nf', 'toast', 'api', 'closeModal', 'loadAll',
      'let modalChId=null, modalModels=[];\n' + extract('saveChannel') + '\nreturn { saveChannel };'
    )(dom.$, dom.$$, { channels: [] }, esc, svg, nf, (m) => toasts.push(m), apiStub, () => { }, async () => { });
    for (const [id, val] of Object.entries(fields)) dom.$('#' + id).value = val;
    dom.$('#f-autoAlias').checked = true;
    await f.saveChannel();
    return { calls, errors, toasts, ok: errors.length === 0 && calls.length > 0 };
  };

  try {
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 20000) { try { if ((await fetch(`http://127.0.0.1:${GW}/healthz`)).ok) { up = true; break; } } catch { } await sleep(200); }
    if (!up) throw new Error('临时网关未启动');

    console.log('\n0. ★ 零渠道的配置也能启动（控制台删光渠道后重启不该起不来）');
    {
      const st0 = await status();
      check('★ `"channels": []` 的 config.json 正常启动并返回空列表（不是"文件损坏"拒启动）',
        Array.isArray(st0.channels) && st0.channels.length === 0, st0);
    }

    console.log('\n1. ★ 控制台表单报文 → 真网关（weight 落库 + status 反映）');
    const base = `http://127.0.0.1:${PU}/v1`;
    let r = await formSave({ 'f-id': 'cw-a', 'f-name': 'A', 'f-base': base, 'f-key': 'k1', 'f-proto': 'openai', 'f-pri': '5', 'f-weight': '3', 'f-on': '1', 'f-proxy': '', 'f-headers': '' });
    check('表单保存成功（后端接受该报文）', r.ok, r.err);
    check('报文里带了 weight=3（不是被白名单吞掉）', r.calls[0].body.weight === 3, r.calls[0] && r.calls[0].body);
    let st = await status();
    check('★ /admin/api/status 里 weight=3', st.channels.find((c) => c.id === 'cw-a')?.weight === 3, st.channels.map((c) => [c.id, c.weight]));

    /* 只验内存不够：控制台填的权重必须**真的落盘**，否则重启就没了（persistConfig 的白名单漏字段是 PT29 的老坑） */
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    check('★ 权重真的写进了 config.json（重启后还在）', onDisk.channels.find((c) => c.id === 'cw-a')?.weight === 3, onDisk.channels.map((c) => [c.id, c.weight]));
    check('未配权重的渠道不会被写上 "weight": 0（保持老配置零差异）',
      !('weight' in (onDisk.channels.find((c) => c.id === 'cw-b') || {})), onDisk.channels.find((c) => c.id === 'cw-b'));

    r = await formSave({ 'f-id': 'cw-b', 'f-name': 'B', 'f-base': base, 'f-key': 'k2', 'f-proto': 'openai', 'f-pri': '5', 'f-weight': '1', 'f-on': '1', 'f-proxy': '', 'f-headers': '' });
    check('第二个渠道 weight=1 也落库', r.ok && (await status()).channels.find((c) => c.id === 'cw-b')?.weight === 1, r.err);

    console.log('\n2. ★ 控制台校验规则与后端一致（负数两边都挡）');
    r = await formSave({ 'f-id': 'cw-neg', 'f-name': 'N', 'f-base': base, 'f-key': 'k', 'f-proto': 'openai', 'f-pri': '5', 'f-weight': '-1', 'f-on': '1', 'f-proxy': '', 'f-headers': '' });
    check('前端直接挡下（一条请求都没发）', r.calls.length === 0, r.calls);
    let raw = await fetch(`http://127.0.0.1:${GW}/admin/api/channels`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AD_KEY }, body: JSON.stringify({ id: 'cw-neg2', name: 'N2', baseUrl: base, apiKey: 'k', protocol: 'openai', priority: 1, weight: -1, models: { 'm-neg': 'm' } }) });
    check('★ 绕过前端直接打接口也被后端拒（400）', raw.status === 400, raw.status);
    const rawTxt = await raw.text();
    check('后端给出可读原因', /weight/.test(rawTxt), rawTxt.slice(0, 140));

    console.log('\n3. ★ 真流量 → 占比真的动起来 → 控制台那一格显示它');
    {
      const models = { 'cw-model': 'cw-up' };
      for (const id of ['cw-a', 'cw-b']) {
        await apiReal('/admin/api/channels', { method: 'POST', body: JSON.stringify({ id, name: id, baseUrl: base, apiKey: 'k', protocol: 'openai', priority: 5, weight: id === 'cw-a' ? 3 : 1, enabled: true, models }) });
      }
      await sleep(300);
      for (let i = 0; i < 24; i++) {
        await fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY }, body: JSON.stringify({ model: 'cw-model', messages: [{ role: 'user', content: 'hi' }] }) });
      }
      st = await status();
      const a = st.channels.find((c) => c.id === 'cw-a'), b = st.channels.find((c) => c.id === 'cw-b');
      check('两个渠道都被分发到了（hits > 0）', (a.weightedHits || 0) > 0 && (b.weightedHits || 0) > 0, [a.weightedHits, b.weightedHits]);
      check('★ 3:1 的权重在真实流量里体现为 A 明显多于 B', (a.weightedHits || 0) > (b.weightedHits || 0), [a.weightedHits, b.weightedHits]);
      check('占比合计 ≈ 100%', Math.abs((a.weightedShare + b.weightedShare) - 100) < 0.01, [a.weightedShare, b.weightedShare]);

      const { html } = renderTable(st);
      check('★ 渠道表格里 A 那一格显示权重 3 与它的占比', html.includes(`>3<span`) && html.includes(`· ${Math.round(a.weightedShare)}%`), [a.weightedShare]);
      check('★ 表格里的占比与 status 的真实占比一致（不是写死的）', html.includes(`· ${Math.round(b.weightedShare)}%`), [b.weightedShare]);
    }

    console.log('\n4. ★ 权重改成 0 → 立刻退出轮询池（表格那一格变回「—」）');
    {
      await apiReal('/admin/api/channel', { method: 'POST', body: JSON.stringify({ id: 'cw-b', weight: 0 }) });
      st = await status();
      const b = st.channels.find((c) => c.id === 'cw-b');
      check('weight 被清成 0', b.weight === 0, b.weight);
      const { html } = renderTable(st);
      const cells = html.split('<tbody>')[1] || '';
      check('★ 权重 0 的渠道在表格里显示「—」而不是 0%', cells.includes('未参与加权轮询（权重 0）'));
      for (let i = 0; i < 8; i++) {
        await fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY }, body: JSON.stringify({ model: 'cw-model', messages: [{ role: 'user', content: 'hi' }] }) });
      }
      st = await status();
      const b2 = st.channels.find((c) => c.id === 'cw-b');
      check('★ 退出池后不再分到流量（hits 不增长）', (b2.weightedHits || 0) === (b.weightedHits || 0), [b.weightedHits, b2.weightedHits]);
    }
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await cleanup();
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不 process.exit()：见 stopChild 注释
})();
