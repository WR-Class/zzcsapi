#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
 * channel-fingerprint-probe.js — 「这家上游是不是在查客户端指纹」的判决探针
 *                    （仓库根，只读为主，低额度）
 *
 * 跑法：
 *   node channel-fingerprint-probe.js <渠道id>                  只判决这一家
 *   node channel-fingerprint-probe.js <渠道id> --save-check    额外做「保存不丢请求头」那一组
 *   node channel-fingerprint-probe.js --all                    扫全部已启用渠道（★ 慎用，见下）
 *   node channel-fingerprint-probe.js <渠道id> --sha <sha256>  钉住期望指纹值（入库比对）
 *   ZZ_BASE=http://127.0.0.1:8787 覆盖管理面地址
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 「模型不回答 / 获取模型失败」有一整类根因是**上游在查客户端指纹**，而它长得极像
 * 「上游今天心情不好」。本项目已经踩过两次：
 *   · Notion 的软墙（200 + `temporarily-unavailable`）：同一秒交替打，curl 3/3 真答、fetch 0/3 软墙
 *     （见 docs/notion-attachment-upload-research.md §7）
 *   · AgentRouter 的 401 `unauthorized client detected`（v1.18.44）：只带 Authorization 必 401，
 *     加上 `User-Agent: claude-cli/2.0.0 (external, cli)` 就 200 列出模型，**而浏览器 UA 一样被拒**
 *     —— 它认的是那个客户端指纹本身，不是"任意浏览器化的 UA"
 * 两次都花了一整轮去定性。这个探针把那一刻的对照实验固定下来：**同一渠道、同一时刻、
 * 只改一个变量（有没有自定义请求头）**，跑完直接给判决。
 *
 * ── 它做什么（全部走管理面，上游调用由网关发出）───────────────────────────
 *   ① 带渠道配的 `headers` 探测  → 期望 ok:true 且列出模型
 *   ② 剥掉 `headers` 再探同一家 → 期望被拒（401/403 之类）
 *   ③ 判决：①成 ②败 ⇒ **这家在查客户端指纹，且它要的就是渠道里配的那套头**
 *           ①败 ②败 ⇒ 不是指纹问题（凭证/额度/渠道本身），探针给不出一致结论就不硬下
 *           ①成 ②成 ⇒ 不查指纹（或那个头是可选风格项）
 *   ④ （--save-check）模拟"控制台保存时没带 headers 字段"→ 落库后请求头必须仍在
 *      （v1.18.44 的现场：一个从不回填的输入框 + 没有 prevDef 兜底的 POST = 静默删除）
 *
 * ── 成本与纪律 ────────────────────────────────────────────────────────────
 *   · **这是探测，不是推理**：不发对话、不消耗推理额度。但它确实会敲上游两次。
 *   · `--all` 会对**每一家**已启用渠道敲两发。渠道多的时候这既慢又唐突，**别当例行体检跑**
 *     —— 它是一次性的现场判决工具，一次只问一家。
 *   · ⚠️ 对 notion 尤其克制：有未验证的怀疑认为高频敲门会把账号推进软墙（研究文档 §7）。
 *     notion 的软墙问题请优先用 `notion-wall-probe.js`（它是**同一时间窗内交错打**的，更省更准）。
 *   · `--save-check` 会**写一次配置**（把该渠道原样存回去）——它验证的正是写库路径。
 *     剥掉的那一份只用于探测，**绝不落库**：POST 之前先删掉 `probe` 字段，别把一次失败的探测
 *     变成一次持久化的失败记录。
 *
 * ── 报告纪律（血泪条款）────────────────────────────────────────────────────
 *   **绝不回显任何凭据**：`apiKey` / `token_v2` / cookie 一律只出长度与前缀；错误文案也过一遍 mask。
 *   本文件只从 `.env` 取管理密钥，不读其它私有文件。
 * ═══════════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CFG = path.join(ROOT, 'config.json');
const BASE = process.env.ZZ_BASE || 'http://127.0.0.1:8787';

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const positional = argv.filter((a) => !a.startsWith('--'));
const ALL = flags.includes('--all');
const SAVE_CHECK = flags.includes('--save-check');
const shaIdx = argv.indexOf('--sha');
const EXPECT_SHA = shaIdx >= 0 ? argv[shaIdx + 1] : null;
const CH_ID = positional[0] || null;

let pass = 0, fail = 0, undecided = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const note = (s) => { undecided++; console.log('  · ' + s); };

/* 凭据屏蔽：任何要打印的字符串都先过这里。 */
const mask = (s) => {
  const t = String(s == null ? '' : s);
  if (!t) return '';
  return t
    .replace(/(sk-|Bearer\s+)[A-Za-z0-9._\-]{6,}/gi, '$1<已隐去>')
    .replace(/("[a-zA-Z_]*(key|token|secret|signature|cookie)[a-zA-Z_]*"\s*:\s*)"[^"]*"/gi, '$1"<已隐去>"')
    .replace(/(token_v2=)[^;\s]+/gi, '$1<已隐去>');
};
/* 密钥只出长度——长度也是信息，前缀会泄露字符集。 */
const maskKey = (s) => (s ? '<' + String(s).length + ' 字符，已隐去>' : '（空）');

const readCfg = () => JSON.parse(fs.readFileSync(CFG, 'utf8'));
const readCh = (id) => readCfg().channels.find((c) => c.id === id);
/* 请求头指纹：排序后逐行拼。它是**给人看的形态**，也是 `--sha` 比对的对象。 */
const hdrFingerprint = (h) => {
  const o = h && typeof h === 'object' && !Array.isArray(h) ? h : {};
  return Object.keys(o).sort().map((k) => `${k}: ${o[k]}`).join('\n');
};

const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const ADMIN = (envText.match(/^ZZCSAPI_ADMIN_KEY=(.*)$/m) || [])[1];
if (!ADMIN) { console.log('✗ .env 里没读到 ZZCSAPI_ADMIN_KEY'); process.exit(1); }

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { Authorization: 'Bearer ' + ADMIN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch { }
  return { status: r.status, json: j };
}

/* 判决一家：带 headers 探一次、剥掉 headers 再探一次（只改这一个变量）。 */
async function judge(ch, label) {
  console.log('\n' + '─'.repeat(62));
  console.log(`${label}  ${ch.id}  protocol=${ch.protocol || 'openai'}`);
  console.log(`  baseUrl=${ch.baseUrl}`);
  console.log(`  apiKey=${maskKey(ch.apiKey)}`);
  console.log(`  headers=${hdrFingerprint(ch.headers) || '（没配任何自定义请求头）'}`);

  const common = { baseUrl: ch.baseUrl, apiKey: ch.apiKey, protocol: ch.protocol || 'openai', timeoutMs: 15000 };

  console.log('\n  ① 带渠道配的请求头探测（探测不消耗推理额度）');
  const withH = await api('POST', '/admin/api/probe', { ...common, headers: ch.headers });
  console.log('     HTTP ' + withH.status + ' → ' + mask(JSON.stringify(withH.json)));
  const withOk = !!(withH.json && withH.json.ok === true);
  const nWith = withH.json && Array.isArray(withH.json.models) ? withH.json.models.length : 0;
  if (withOk) check('★ 带请求头探测成功（ok:true）且列出了模型（≥1）', nWith >= 1, { models: nWith });
  else note('带请求头这一发没通过（HTTP ' + withH.status + '）——见下面的判决');

  console.log('\n  ② 剥掉请求头再探同一家（只改这一个变量）');
  const withoutH = await api('POST', '/admin/api/probe', common);
  console.log('     HTTP ' + withoutH.status + ' → ' + mask(JSON.stringify(withoutH.json)));
  const withoutOk = !!(withoutH.json && withoutH.json.ok === true);
  if (withoutOk) note('剥掉请求头也能过（HTTP ' + withoutH.status + '）——见下面的判决');
  else check('★ 不带请求头真的被拒（ok:false）', true);
  if (!withoutOk) {
    check('★ 失败时带回了上游原文与 HTTP 码（不给一个光秃秃的 ok:false）',
      !!(withoutH.json && withoutH.json.error && withoutH.json.status), mask(JSON.stringify(withoutH.json)));
  }
  if (EXPECT_SHA) {
    const got = crypto.createHash('sha256').update(hdrFingerprint(ch.headers)).digest('hex');
    console.log('  指纹 sha256 = ' + got.slice(0, 16) + '…');
    check('★ 渠道里配的请求头指纹与期望一致', got === String(EXPECT_SHA).toLowerCase(), got);
  }

  console.log('\n  判决');
  let verdict;
  if (withOk && !withoutOk) {
    verdict = 'fingerprint';
    console.log('  ★ 这家在查客户端指纹：它要的就是渠道里配的那套请求头。');
    console.log('    （别改成"更浏览器化"的 UA —— AgentRouter 实测浏览器 UA 一样被拒，它认的是具体指纹。）');
  } else if (!withOk && !withoutOk) {
    verdict = 'not-fingerprint';
    console.log('  · 两次都被拒 → **不是指纹问题**（凭证 / 额度 / 渠道本身 / 上游故障）。');
    console.log('    探针在这里给不出一致结论，别硬下结论：先看 HTTP 码与上游原文。');
    note('该渠道两次都失败，判决为"非指纹类"，不计入通过数');
  } else if (withOk && withoutOk) {
    verdict = 'no-fingerprint-check';
    console.log('  · 带不带都能过 → 这家不查指纹（或那个头只是可选风格项）。');
  } else {
    verdict = 'inverted';
    console.log('  · 剥掉头反而通了（反常）——上游可能对某个特定的头更敏感，逐个头二分再定位。');
    note('方向反常，需要逐头二分');
  }
  return { id: ch.id, withOk, withoutOk, verdict };
}

/* ④ 保存渠道时缺省 headers 字段 → 落库必须保住（v1.18.44 的现场）。会写一次配置。 */
async function saveCheck(id) {
  console.log('\n' + '─'.repeat(62));
  console.log('④ 保存渠道时**缺省 headers 字段** → 落库必须保住');
  const before = readCh(id);
  if (!before) { note('配置里找不到渠道 ' + id + '，跳过保存检查'); return; }
  const def = { ...before };
  delete def.headers;
  delete def.probe;              // ★ 绝不把探测结果一起写回去（那会把一次失败探测持久化）
  const save = await api('POST', '/admin/api/channels', def);
  console.log('  POST /admin/api/channels → HTTP ' + save.status);
  check('保存本身成功（HTTP 200）', save.status === 200, save.status);
  const after = readCh(id);
  check('★ 落库后 headers 仍在（没有 prevDef 兜底时，这里会被静默删掉）',
    !!after.headers && hdrFingerprint(after.headers) !== '', after.headers);
  check('★ 值一字未改', hdrFingerprint(after.headers) === hdrFingerprint(before.headers),
    { before: hdrFingerprint(before.headers), after: hdrFingerprint(after.headers) });
  check('apiKey 也没被这次保存动过（保存必须用原文，不许回写掩码）',
    String(after.apiKey || '') === String(before.apiKey || ''),
    { before: maskKey(before.apiKey), after: maskKey(after.apiKey) });
}

(async () => {
  const cfg = readCfg();
  const targets = ALL
    ? cfg.channels.filter((c) => c.enabled !== false)
    : (CH_ID ? [readCh(CH_ID)] : []);
  if (!targets.length || !targets[0]) {
    if (CH_ID) console.log('✗ 配置里没有渠道 ' + CH_ID);
    console.log('用法：node channel-fingerprint-probe.js <渠道id> [--save-check] [--sha <sha256>]');
    console.log('      node channel-fingerprint-probe.js --all');
    console.log('\n可用渠道：' + cfg.channels.map((c) => c.id).join(', '));
    return void (process.exitCode = 1);
  }
  if (ALL) console.log('⚠️  --all 会对每一家已启用渠道各敲两发探测。渠道多时既慢又唐突，别当例行体检。');
  console.log('管理面 ' + BASE + ' · 目标 ' + targets.map((c) => c.id).join(', '));

  const verdicts = [];
  let i = 0;
  for (const ch of targets) {
    verdicts.push(await judge(ch, ALL ? `[${++i}/${targets.length}] 判决` : '判决'));
  }
  if (SAVE_CHECK) await saveCheck(targets[0]);

  console.log('\n' + '═'.repeat(62));
  if (verdicts.length > 1) {
    const fp = verdicts.filter((v) => v.verdict === 'fingerprint').map((v) => v.id);
    console.log('查客户端指纹的家：' + (fp.length ? fp.join(', ') : '（无）'));
    const dead = verdicts.filter((v) => v.verdict === 'not-fingerprint').map((v) => v.id);
    if (dead.length) console.log('两次都被拒（非指纹问题）：' + dead.join(', '));
  }
  console.log((fail === 0 ? '✓' : '✗') + ' 判决探针：' + (pass + fail) + ' 项，通过 ' + pass + '，失败 ' + fail +
    (undecided ? '，另有 ' + undecided + ' 项未作判定' : ''));
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => { console.log('✗ 异常: ' + mask(e && e.message || e)); process.exitCode = 1; });
