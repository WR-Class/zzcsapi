#!/usr/bin/env node
/* notion 软墙探针（只读，低额度）—— 把"账号在墙里"与"客户端被墙"两个维度分开
 *
 * 为什么需要它：Notion 的推理接口会对某些客户端回一道**软墙** ——
 *   HTTP 200 + {"type":"error","subType":"temporarily-unavailable","isRetryable":false}
 * 通用文案、不暴露原因。它有两个**独立**维度，而两个维度给客户端的表象一模一样：
 *   维度 A · 账号状态：账号自身在墙里/不在墙里，**与传输无关**，且**随时间变**。
 *   维度 B · 客户端指纹：账号可过时，curl 过、Node 的 fetch/undici 不过。
 * 只看见其中一个维度，就会得出"账号问题"或"指纹问题"这种**只对一半**的结论
 * （本项目为此误判过三次，留档在 docs/notion-attachment-upload-research.md §7.4）。
 *
 * 做法：**在同一个时间窗内把待比较的传输交错打**（C F C F …），而不是"今天打 A、明天打 B"。
 *   - 若 curl 过、fetch 不过  → 维度 B 可见（账号可过，通道选择有意义）
 *   - 若两者都不过          → 这个账号此刻整体在墙里（维度 A），换传输无用
 *
 * 用法（零依赖，读 config.json；被墙那一发只花 1~2 秒且**不消耗真实推理**）：
 *   node notion-wall-probe.js                           # 默认 notionls，交错 curl,fetch × 3 轮
 *   node notion-wall-probe.js notion7                   # 指定渠道
 *   node notion-wall-probe.js notionls curl,fetch,h2 3  # 指定传输序列与轮数
 *   node notion-wall-probe.js notionls curl,chain 2     # chain = 线上真实走的通道链
 * 可选环境变量：ZZ_CONFIG=<config.json 路径>（默认仓库根；容器里是 /app/config.json）
 *
 * 想在**容器里**跑（容器里没有这个文件——Dockerfile 是显式 COPY 清单，只拷运行时依赖）：
 *   ① 本工具自己会去找 notion.js（先同级、再 /app/notion.js），所以放进**已挂载的 dump/** 即可：
 *        docker cp notion-wall-probe.js zzcsapi:/app/dump/
 *        docker exec zzcsapi node /app/dump/notion-wall-probe.js notionls curl,fetch 2
 *      （云端同理：scp 到 /opt/zzcsapi/dump/，再 docker exec）
 *   ② 或在宿主机直接跑（读仓库 config.json，不碰容器）。
 *   不要把 `require('./notion.js')` 写死成相对路径——放进 dump/ 就会 MODULE_NOT_FOUND。
 *
 * 判据与边界：
 *   - 只有"真答"才算过（能解出正文）；`200 + temporarily-unavailable` 记 `W`（软墙）；
 *     其它记 `?`，异常记 `E`。**绝不把软墙当成功**。
 *   - 报告**绝不回显凭据**（token_v2 / cookie / apiKey 一律脱敏）。
 *   - ⚠️ **克制使用**：有未验证的怀疑——高频用 Node 客户端敲门会把账号推入维度 A。
 *     唯一已知可过的账号往往正是活体判据的来源，拿它做压力实验的代价大于收益。
 *     要看维度 B，2~3 轮足够；不要拿它刷量。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// notion.js 的位置：同级优先（仓库根），其次 /app/notion.js（被拷进容器 dump/ 跑时）。
// 写死相对路径会让本工具在 dump/ 里直接 MODULE_NOT_FOUND。
const notion = (() => {
  for (const p of [path.join(__dirname, 'notion.js'), '/app/notion.js']) {
    try { return require(p); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error('找不到 notion.js（试过 ' + __dirname + '/notion.js 与 /app/notion.js）');
})();

const CFG_PATH = process.env.ZZ_CONFIG || (fs.existsSync('/app/config.json') && !fs.existsSync(path.join(__dirname, 'config.json'))
  ? '/app/config.json' : path.join(__dirname, 'config.json'));
const argv = process.argv.slice(2);
const channelId = argv[0] || 'notionls';
const transports = String(argv[1] || 'curl,fetch').split(',').map((s) => s.trim()).filter(Boolean);
const rounds = Math.max(1, Math.min(20, Number(argv[2]) || 3));

const mask = (s) => String(s)
  .replace(/n2a_[A-Za-z0-9_\-]+/g, '<masked>')
  .replace(/"(token_v2|api_key|key|token|signature|cookie)":"[^"]*"/gi, '"$1":"<masked>"')
  .replace(/token_v2=[^;\s"]+/g, 'token_v2=<masked>');

function loadChannel() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
  catch (e) { throw new Error('读不到 config.json（' + CFG_PATH + '）：' + e.message); }
  const ch = (cfg.channels || []).find((c) => c.id === channelId);
  if (!ch) {
    const ids = (cfg.channels || []).filter((c) => c.protocol === 'notion').map((c) => c.id);
    throw new Error('没有渠道 ' + channelId + '（config.json 里的 notion 渠道：' + (ids.join(', ') || '无') + '）');
  }
  if (ch.protocol !== 'notion') throw new Error('渠道 ' + channelId + ' 的协议是 ' + ch.protocol + '，本探针只测 notion');
  return ch;
}

function realAnswer(text) {
  const ev = [];
  try {
    const p = notion.createNotionStreamParser((e) => ev.push(e));
    for (const l of String(text).split(/\r?\n/)) p.line(l);
  } catch { /* 形状不对就当没有正文 */ }
  const out = ev.filter((e) => e.type === 'final').map((e) => e.text).join('')
    || ev.filter((e) => e.type === 'content').map((e) => e.text).join('');
  return String(out).trim();
}

const CALLS = (url, headers, body) => ({
  curl: () => notion.notionCurlFetch(url, { method: 'POST', headers, body, timeoutMs: 90000 }),
  h2: () => notion.notionH2Request(url, { method: 'POST', headers, body, timeoutMs: 90000 }),
  fetch: () => fetch(url, { method: 'POST', headers, body }),
  chain: () => notion.notionFetch(url, { method: 'POST', headers, body, timeoutMs: 90000 }),
});

(async () => {
  const ch = loadChannel();
  const base = String(ch.baseUrl || '').replace(/\/+$/, '');
  const url = base + '/api/v3/runInferenceTranscript';
  const model = Object.keys(ch.models || {})[0] || 'unknown';

  console.log('渠道 ' + ch.id + ' · 出口 ' + base + ' · 模型 ' + model);
  console.log('传输 ' + transports.join('/') + ' 交错 × ' + rounds + ' 轮 · node ' + process.version + ' · ' + CFG_PATH);

  const acct = await notion.notionDiscoverAccount(base, ch.apiKey, fetch, 20000);
  if (!acct.spaces || !acct.spaces.length) throw new Error('账号发现失败（getSpaces 没给出 space）');
  acct.spaceId = acct.spaces[0].spaceId;
  console.log('账号发现 OK（spaces=' + acct.spaces.length + '）\n');

  const b = notion.buildNotionTranscript([{ role: 'user', content: '只回答两个字：收到' }], model, acct, {});
  const body = JSON.stringify(notion.notionBuildPayload(b.transcript, b.threadType, acct, {}));
  const headers = notion.notionHeaders(acct, ch.apiKey, base);
  const calls = CALLS(url, headers, body);

  const tally = {};
  for (const t of transports) {
    if (!calls[t]) throw new Error('传输只能是 curl | h2 | fetch | chain，收到：' + t);
    tally[t] = { pass: 0, wall: 0, other: 0, err: 0 };
  }

  for (let r = 1; r <= rounds; r++) {
    const line = [];
    for (const t of transports) {
      const t0 = Date.now();
      let status = 0, text = '';
      try {
        const resp = await calls[t]();
        status = resp.status;
        text = await resp.text();
      } catch (e) {
        tally[t].err++; line.push(t + '=E(' + mask(e.message).slice(0, 40) + ')'); continue;
      }
      const dt = ((Date.now() - t0) / 1000).toFixed(1) + 's';
      if (notion.notionIsSoftWall(text)) { tally[t].wall++; line.push(t + '=W(' + dt + ')'); continue; }
      const a = realAnswer(text);
      if (a) { tally[t].pass++; line.push(t + '=★' + JSON.stringify(mask(a).slice(0, 16)) + '(' + dt + ')'); }
      else { tally[t].other++; line.push(t + '=?HTTP' + status + '(' + mask(text).replace(/\s+/g, ' ').slice(0, 40) + ')'); }
    }
    console.log('  第 ' + r + ' 轮: ' + line.join('  '));
  }

  console.log('\n汇总（真答 / 软墙 / 其它 / 异常）：');
  for (const t of transports) {
    const v = tally[t];
    console.log('  ' + t.padEnd(6) + ' ' + v.pass + ' / ' + v.wall + ' / ' + v.other + ' / ' + v.err);
  }

  // 判决：把两个维度分开说，别再说"只对一半"的结论
  const anyPass = transports.some((t) => tally[t].pass > 0);
  const allWalled = transports.every((t) => tally[t].pass === 0 && tally[t].wall > 0 && tally[t].other === 0 && tally[t].err === 0);
  console.log('');
  if (!anyPass && allWalled) {
    console.log('★ 判决：维度 A —— 这个账号此刻整体在墙里（所有传输一起软墙）。');
    console.log('  换传输没有用，网关会如实报 ok:false / notion: temporarily-unavailable。');
    console.log('  该做的是换账号或等窗口，**不要**再调报文形状或传输。');
  } else if (anyPass) {
    const winners = transports.filter((t) => tally[t].pass > 0);
    const losers = transports.filter((t) => tally[t].pass === 0);
    console.log('★ 判决：账号可过（维度 A 开着）。通过的传输：' + winners.join('/')
      + (losers.length ? '；未通过的：' + losers.join('/') : ''));
    console.log('  这正是维度 B（客户端指纹）可见的窗口，通道链的排序依据就是它。');
  } else {
    console.log('★ 判决：未取得 —— 没有真答、也没有干净的软墙（看上面的 ? 与 E 行）。');
  }
})().catch((e) => {
  console.error('探针失败：' + mask((e && e.stack) || e.message));
  process.exitCode = 1;
});
