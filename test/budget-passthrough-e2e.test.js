#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/budget-passthrough-e2e.test.js — 客户端的输出预算必须活着穿过每一层（v1.18.31，真起进程，零依赖）
 *
 * 现场（我查「200 + 空流 / 截断」到底是体积问题还是预算问题时，用留证开关抓到 DSH 真实报文）：
 *   DSH 发的是 `max_completion_tokens: 32768`（OpenAI 把 max_tokens 改名后的新字段），**不发** max_tokens。
 *   而我们的跨协议转换器只读老字段 `oai.max_tokens`：
 *     · → anthropic：读不到 → 套上缺省 **8192**（Anthropic 的 max_tokens 是必填，不给就 400，所以有缺省）
 *     · → gemini：读不到 → **整个不设** maxOutputTokens，只能吃模型自己的缺省
 *   推理型上游把「思考 token」算进同一份预算，8192 被思考吃光就是「可见正文 0 字符 + finish_reason=length」
 *   ——用户看到的"回答被截断/空回复"，有一类根因是**预算在我们这一层被悄悄改小/丢掉了**，不是客户端给得少。
 *
 * 覆盖：
 *   ① 纯函数真值表：clientBudgetOf 认两个字段名、max_tokens 优先、非法值/0/缺省 → 0；
 *   ② 真链路 ★：客户端只发 max_completion_tokens=32768 → anthropic 上游**真收到 max_tokens=32768**（不是 8192）；
 *   ③ 真链路 ★：同样只发新字段 → gemini 上游真收到 generationConfig.maxOutputTokens=32768；
 *   ④ 对照组：客户端什么都不发 → anthropic 仍是缺省 8192、gemini 仍不设上限（缺省语义没被改坏）；
 *   ⑤ 对照组：两个字段都给 → 老字段 max_tokens 优先（客户端显式给的一字不改）；
 *   ⑥ 结构性守卫：三处（anthropic 转换 / gemini 转换 / 思考吃光判据）共用同一个 clientBudgetOf，
 *      且全仓不再有 `Number(oai.max_tokens) > 0` 这种"只认老字段"的预算读法。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/budget-passthrough-e2e.test.js     （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-budget-e2e-'));
const GW_KEY = 'e2e-gw', AD_KEY = 'e2e-admin';

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
// 从 server.js 现抠一个函数体（与其它用例同一套纪律：跑真源码，不抄一份）
function extract(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('extract: 找不到 ' + name);
  let d = 0, j = SRC.indexOf('{', i);
  for (let k = j; k < SRC.length; k++) {
    if (SRC[k] === '{') d++;
    else if (SRC[k] === '}') { d--; if (!d) return SRC.slice(i, k + 1); }
  }
  throw new Error('extract: ' + name + ' 括号不配对');
}

/* 假上游：一个服务同时扮演三种原生上游，并把每次收到的报文记下来 */
const seen = { anthropic: [], gemini: [], openai: [] };
const upstream = http.createServer((req, res) => {
  const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
    const raw = Buffer.concat(cs).toString('utf8');
    if (req.method === 'GET' && /models/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    }
    let body = null; try { body = JSON.parse(raw); } catch { }
    if (/\/v1\/messages/.test(req.url)) {
      seen.anthropic.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'mock', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    }
    if (/generateContent/.test(req.url)) {
      seen.gemini.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }));
    }
    seen.openai.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'c', object: 'chat.completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
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

(async () => {
  /* ══════════ 1. clientBudgetOf 真值表（现抠真源码） ══════════ */
  console.log('\n1. clientBudgetOf（两个字段名读成同一个值）');
  const clientBudgetOf = new Function(extract('clientBudgetOf') + '\nreturn clientBudgetOf;')();
  check('只发老字段 max_tokens → 认', clientBudgetOf({ max_tokens: 999 }) === 999);
  check('★ 只发新字段 max_completion_tokens → 认（DSH 就是这一种）', clientBudgetOf({ max_completion_tokens: 32768 }) === 32768);
  check('两个都发 → 老字段优先（客户端显式给的一字不改）', clientBudgetOf({ max_tokens: 111, max_completion_tokens: 222 }) === 111);
  check('都不发 → 0（表示"客户端没给"，由调用方决定缺省）', clientBudgetOf({}) === 0);
  check('0 / 负数 / 非数字 / 字符串垃圾 → 0', clientBudgetOf({ max_tokens: 0 }) === 0 && clientBudgetOf({ max_tokens: -5 }) === 0 && clientBudgetOf({ max_tokens: 'abc' }) === 0 && clientBudgetOf({ max_completion_tokens: null }) === 0);
  check('小数向下取整', clientBudgetOf({ max_tokens: 1024.9 }) === 1024);

  /* ══════════ 2. 真链路：预算活着穿过跨协议转换 ══════════ */
  console.log('\n2. 真链路（openai 客户端 → anthropic / gemini 渠道）');
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const port = await freePort();
  const cfg = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port, health: { intervalSec: 3600, timeoutMs: 3000 },
    channels: [
      { id: 'ant', name: 'ant', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${upPort}`, apiKey: 'sk-ant', enabled: true, priority: 10, models: { 'm-ant': 'mock' } },
      { id: 'gem', name: 'gem', protocol: 'gemini', baseUrl: `http://127.0.0.1:${upPort}`, apiKey: 'sk-gem', enabled: true, priority: 10, models: { 'm-gem': 'mock' } },
    ],
  }));
  const gw = startGateway(cfg, port);
  const ask = async (model, extra) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY, 'User-Agent': 'e2e-budget-client' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }),
    });
    return { status: r.status, text: await r.text() };
  };
  try {
    check('网关启动', await waitUp(port));

    // ★ 主用例：客户端只发新字段（DSH 的形态）
    const a1 = await ask('m-ant', { max_completion_tokens: 32768 });
    check('anthropic 渠道请求成功', a1.status === 200, a1.status);
    const ant1 = seen.anthropic[seen.anthropic.length - 1] || {};
    check('★ anthropic 上游真收到 max_tokens=32768（v1.18.31 前这里被悄悄换成缺省 8192）', ant1.max_tokens === 32768, { got: ant1.max_tokens });

    const g1 = await ask('m-gem', { max_completion_tokens: 32768 });
    check('gemini 渠道请求成功', g1.status === 200, g1.status);
    const gem1 = seen.gemini[seen.gemini.length - 1] || {};
    check('★ gemini 上游真收到 generationConfig.maxOutputTokens=32768（v1.18.31 前这里整个丢失）',
      gem1.generationConfig && gem1.generationConfig.maxOutputTokens === 32768, { got: gem1.generationConfig });

    // 对照组：客户端什么都没给
    await ask('m-ant', {});
    const ant2 = seen.anthropic[seen.anthropic.length - 1] || {};
    check('对照组：客户端没给预算 → anthropic 仍是缺省 8192（Anthropic 必填，缺省语义没改坏）', ant2.max_tokens === 8192, { got: ant2.max_tokens });
    await ask('m-gem', {});
    const gem2 = seen.gemini[seen.gemini.length - 1] || {};
    check('对照组：客户端没给预算 → gemini 不设 maxOutputTokens（保持"不封顶"）', !(gem2.generationConfig && gem2.generationConfig.maxOutputTokens), { got: gem2.generationConfig });

    // 对照组：两个字段都给 → 老字段优先
    await ask('m-ant', { max_tokens: 111, max_completion_tokens: 32768 });
    const ant3 = seen.anthropic[seen.anthropic.length - 1] || {};
    check('对照组：两个字段都给 → anthropic 收到 111（老字段优先）', ant3.max_tokens === 111, { got: ant3.max_tokens });
  } finally { gw.kill('SIGKILL'); }
  upstream.close();

  /* ══════════ 3. 结构性守卫：别再冒出"只认老字段"的预算读法 ══════════ */
  console.log('\n3. 结构性守卫（防回潮）');
  check('clientBudgetOf 已定义', /function clientBudgetOf\(oai\) \{/.test(SRC));
  check('anthropic 转换用它（clientBudgetOf(oai) || 8192）', /max_tokens: clientBudgetOf\(oai\) \|\| 8192,/.test(SRC));
  check('gemini 转换用它', /const cbGem = clientBudgetOf\(oai\);/.test(SRC) && /if \(cbGem > 0\) gc\.maxOutputTokens = cbGem;/.test(SRC));
  check('思考吃光判据也用它（三处共用同一个读法）', /const askedMaxTokens = clientBudgetOf\(body\);/.test(SRC));
  check('全仓不再有"只认 max_tokens"的预算读法 Number(oai.max_tokens)', !/Number\(oai\.max_tokens\)/.test(SRC));

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不用硬 process.exit：避免 Windows libuv 句柄竞态把退出码搞脏
  await sleep(250);
})();
