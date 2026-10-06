#!/usr/bin/env node
/* notion 内联附件的「判决实验」（v1.18.41）——只读诊断工具，跑在仓库根，非测试。
 *
 * 它回答一个问题：**模型到底有没有读到我们内联进提示词的那份文件？**
 *   · 判据只有一条：模型能不能答出**只存在于 CSV 里**的随机串（默认 K7Q2M9）。
 *   · 做法：同一个账号、同一时刻打两发——**对照**（不带附件）与**附件**（带内联文件）。
 *     对照不真答（软墙/空/400）→ 这一发拿不到判据，换下一个账号；只有对照真答了，附件那一发才可信。
 *
 * 为什么必须成对打：notion 的软墙是**账号级**的（200 + temporarily-unavailable），
 * 软墙下发出来的"空"与"模型没读到文件"长得一模一样 —— 不成对打就会把软墙误判成"附件不生效"。
 *
 * 用法：
 *   node notion-attachment-verdict.js              # 默认预算 14 发
 *   node notion-attachment-verdict.js 8            # 更小的预算
 *   node notion-attachment-verdict.js 8 notion5    # 只打某个渠道
 *
 * 成本：还在软墙里的账号一发只花 ~1~2 秒、**不消耗真实推理**；只有对照真答了才会真的用额度。
 * 纪律：**绝不打印任何凭据**（token_v2 / API key 一律只用于请求，进不了输出）。
 *
 * 结果怎么读：
 *   判决：已打通            → 模型答出了随机串，附件能力成立（可以打开渠道的 notionAttachments）
 *   判决：没读到            → 对照真答、附件真答但答不出随机串 → 这一发的文件没进模型
 *   判决：未取得（全是软墙） → 所有账号都在软墙里，实验条件不成立，过一段时间再跑（见 docs/notion-attachment-upload-research.md §5）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const notion = require(path.join(__dirname, 'notion.js'));

const CSV = 'secret,note\nK7Q2M9,only-in-file\n';
const TOKEN = 'K7Q2M9';
const QUESTION = '我上传的 CSV 里 secret 这一列的值是什么？只回答那个值本身。';
const FILE_LINE = JSON.stringify({
  file: { file_data: 'data:text/csv;base64,' + Buffer.from(CSV, 'utf8').toString('base64'), filename: 'probe.csv' },
  type: 'file'
});

const BUDGET = Math.max(1, Number(process.argv[2] || 14));
const ONLY = process.argv[3] || '';
let calls = 0;
const overBudget = () => calls >= BUDGET;

function mask(s) {
  return String(s)
    .replace(/n2a_[A-Za-z0-9_\-]+/g, '<masked>')
    .replace(/"(token_v2|api_key|key|token|signature)":"[^"]*"/g, '"$1":"<masked>"')
    .replace(/\s+/g, ' ');
}

function loadChannels() {
  const p = path.join(__dirname, 'config.json');
  if (!fs.existsSync(p)) { console.error('找不到 config.json（工具要读本机渠道清单）'); process.exit(2); }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error('config.json 解析失败：' + e.message); process.exit(2); }
  let chans = (cfg.channels || []).filter((c) => c.protocol === 'notion' && c.apiKey);
  if (ONLY) chans = chans.filter((c) => c.id === ONLY);
  return chans;
}

/* 一发：attach=false 是对照，attach=true 把文件内联进最后一条 user step（并在 config step 打开开关）。
   这两样就是参照实现 notion2api 的实发报文形状（见 docs/notion-attachment-upload-research.md §4.2）。 */
async function send(ch, acct, { attach }) {
  const alias = Object.keys(ch.models || {})[0];
  const built = notion.buildNotionTranscript([{ role: 'user', content: QUESTION }], alias, acct, {});
  const t = built.transcript;
  const cfgStep = t.find((s) => s.type === 'config');
  if (attach) {
    cfgStep.value.enableCsvAttachmentSupport = true;
    const lastUser = [...t].reverse().find((s) => s.type === 'user');
    if (lastUser) lastUser.value = [[String(lastUser.value[0][0]) + '\n' + FILE_LINE]];
  }
  const body = notion.notionBuildPayload(t, built.threadType, acct);
  const base = (ch.baseUrl || 'https://www.notion.so').replace(/\/+$/, '');
  const hdrs = notion.notionHeaders(acct, ch.apiKey, base);
  calls++;
  const t0 = Date.now();
  const resp = await fetch(base + '/api/v3/runInferenceTranscript', { method: 'POST', headers: hdrs, body: JSON.stringify(body) });
  const raw = await resp.text();
  const ms = Date.now() - t0;
  const events = [];
  try {
    const p = notion.createNotionStreamParser((e) => events.push(e));
    for (const line of raw.split(/\r?\n/)) p.line(line);
  } catch { /* 解析失败就当没正文 */ }
  const text = String(
    events.filter((e) => e.type === 'final').map((e) => e.text).join('') ||
    events.filter((e) => e.type === 'content').map((e) => e.text).join('')
  );
  const walled = /temporarily-unavailable/.test(raw);
  const verdict = walled ? '软墙' : (text.trim() ? '真答' : '空');
  return { http: resp.status, ms, walled, text, verdict, hasToken: text.includes(TOKEN) };
}

async function main() {
  const chans = loadChannels();
  if (!chans.length) { console.error(ONLY ? ('没找到渠道 ' + ONLY + '（需要 protocol=notion 且有 apiKey）') : 'config.json 里没有 protocol=notion 且有 apiKey 的渠道'); process.exit(2); }
  console.log('notion 内联附件判决实验 · 判据 = 能否答出只存在于 CSV 里的 ' + TOKEN);
  console.log('候选渠道 ' + chans.map((c) => c.id).join(' ') + ' · 预算 ' + BUDGET + ' 发 · 成对打（对照 + 附件）\n');

  let healthy = null;
  let tried = 0;
  console.log('── 阶段 A：找能真答的账号（对照）──');
  for (const ch of chans) {
    if (overBudget()) { console.log('  预算用尽'); break; }
    const base = (ch.baseUrl || 'https://www.notion.so').replace(/\/+$/, '');
    let acct;
    try { acct = await notion.notionDiscoverAccount(base, ch.apiKey, fetch, 20000); }
    catch (e) { console.log('  ' + ch.id.padEnd(9) + ' 账号发现失败：' + mask(e.message).slice(0, 70)); continue; }
    acct.spaceId = acct.spaces[0].spaceId;
    const c = await send(ch, acct, { attach: false });
    tried++;
    console.log('  ' + ch.id.padEnd(9) + ' 对照 ' + c.verdict.padEnd(4) + ' http=' + c.http + ' ' + String(c.ms).padStart(5) + 'ms  ' + JSON.stringify(mask(c.text).slice(0, 70)));
    if (c.verdict === '真答') { healthy = { ch, acct }; console.log('  → ' + ch.id + ' 可用，进入阶段 B'); break; }
    await new Promise((r) => setTimeout(r, 1200));
  }

  if (!healthy) {
    console.log('\n判决：未取得（预算内试了 ' + tried + ' 个账号，没有一个能真答——软墙/空/凭据失效）');
    console.log('说明：这不是"附件不生效"，而是实验条件不成立。软墙是账号级的，只挂在 AI 推理层');
    console.log('      （同一批账号的 getInferenceTranscriptsForUser 仍是 200），别再改报文形状 —— 等账号恢复即可。');
    console.log('      详见 docs/notion-attachment-upload-research.md §5。');
    return 0;
  }

  console.log('\n── 阶段 B：同一账号上打附件（' + healthy.ch.id + '）──');
  if (overBudget()) { console.log('  预算用尽，附件这一发没打成'); return 0; }
  const a = await send(healthy.ch, healthy.acct, { attach: true });
  console.log('  附件 ' + a.verdict.padEnd(4) + ' http=' + a.http + ' ' + String(a.ms).padStart(5) + 'ms  含随机串=' + a.hasToken);
  console.log('    ' + JSON.stringify(mask(a.text).slice(0, 200)));

  if (a.verdict !== '真答') {
    console.log('\n判决：未取得（对照真答、但附件这一发是 ' + a.verdict + '——多半又是软墙，同一账号上软墙是逐发间歇的）');
    console.log('      建议：过一会儿再跑一次；或换账号重跑。');
    return 0;
  }
  if (a.hasToken) {
    console.log('\n★★★ 判决：已打通 —— 模型答出了只存在于 CSV 里的 ' + TOKEN);
    console.log('      可以打开渠道的 notionAttachments（默认关），并把 docs/notion-attachment-upload-research.md');
    console.log('      的状态表那一格从"未取得"改成"已活体验证"。');
    return 0;
  }
  console.log('\n判决：没读到 —— 对照真答、附件也真答，但答不出随机串 → 这一发的文件没进模型。');
  console.log('      下一步怀疑对象：config step 里那 61 个开关的其余部分、或 notion2api 的 "user: " 前缀。');
  return 0;
}

main().catch((e) => { console.error('异常：' + mask((e && e.stack) || e.message)); process.exitCode = 1; });
