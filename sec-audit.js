/* 网关安全体检（只读）——对任意部署跑一遍，报告脱敏、绝不回显密钥。
 *
 * 用法：
 *   node sec-audit.js                                   # 体检本机 127.0.0.1:8787（自带密钥时做完整检查）
 *   $env:ZZ_BASE='http://1.2.3.4:8787'; node sec-audit.js    # 体检远端部署（无密钥时只做匿名面检查）
 *   $env:ZZ_TRY_DEFAULTS='1'; node sec-audit.js              # 额外试一下仓库里公开的示例默认密钥（判断有没有沿用默认）
 *
 * 密钥来源（可选，只在有它们的机器上用）：
 *   $env_lines = docker inspect zzcsapi --format '{{range .Config.Env}}{{println .}}{{end}}'
 *   $env:ADMIN_KEY  = ($env_lines | Select-String '^ADMIN_KEY='   | Select -First 1).Line -replace '^ADMIN_KEY=',''
 *   $env:GATEWAY_KEY= ($env_lines | Select-String '^GATEWAY_KEY=' | Select -First 1).Line -replace '^GATEWAY_KEY=',''
 */
'use strict';
const fs = require('fs');
const B = process.env.ZZ_BASE || 'http://127.0.0.1:8787';
const AK = process.env.ADMIN_KEY || '';
const GK = process.env.GATEWAY_KEY || '';
const HAS_KEYS = !!(AK && GK);
const TRY_DEFAULTS = process.env.ZZ_TRY_DEFAULTS === '1';
const DEF_ADMIN = 'zz-admin-change-me', DEF_GW = 'zz-gw-change-me';

const findings = [];
const note = (sev, text) => findings.push({ sev, text });
const hdr = (t) => console.log(`\n── ${t} ──`);
const line = (ok, m) => console.log(`  ${ok ? '✓' : '✗'} ${m}`);

const req = async (path, { key = null, method = 'GET', body = null } = {}) => {
  const h = {};
  if (key) h.Authorization = `Bearer ${key}`;
  if (body) h['Content-Type'] = 'application/json';
  try {
    const r = await fetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    return { status: r.status, text: await r.text(), headers: r.headers };
  } catch (e) { return { status: 0, text: '', headers: new Map(), err: e.message }; }
};

(async () => {
  console.log(`目标：${B} · 带密钥：${HAS_KEYS ? '是（做完整检查）' : '否（只做匿名面检查）'}`);

  let upstreamKeys = [];
  if (HAS_KEYS) {
    try {
      const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
      upstreamKeys = (cfg.channels || []).map((c) => c.apiKey).filter((k) => typeof k === 'string' && k.length >= 12);
    } catch {}
  }
  const secrets = [AK, GK, ...upstreamKeys].filter(Boolean);
  const leaks = (text) => (secrets.length ? secrets.filter((s) => text.includes(s)).length : 0);

  /* ① 匿名可达性：哪些口不带密钥就能碰 */
  hdr('① 匿名可达性（不带任何密钥）');
  const anon = {};
  for (const p of ['/healthz', '/console', '/admin/api/status', '/admin/api/channels', '/admin/api/settings', '/admin/api/usage', '/metrics', '/v1/models', '/config.json', '/.env', '/usage.json', '/server.js']) {
    const r = await req(p);
    anon[p] = r.status;
    const publicOk = p === '/healthz' || p === '/console';
    const expect401 = p.startsWith('/admin') || p === '/metrics' || p === '/v1/models';
    const okCode = publicOk ? r.status === 200 : expect401 ? (r.status === 401 || r.status === 404) : r.status === 404;
    line(okCode, `${p.padEnd(24)} → ${r.status || '连接失败'}${okCode ? '' : '  ⚠ 不符预期'}`);
    if (publicOk && leaks(r.text)) note('严重', `${p} 未鉴权就回显了密钥`);
    if (p === '/config.json' || p === '/.env' || p === '/usage.json' || p === '/server.js') {
      if (r.status === 200) note('严重', `${p} 被当静态文件发出去了（本机私有文件泄露）`);
    }
  }
  if (anon['/v1/chat/completions'] === undefined) {
    const r = await req('/v1/chat/completions', { method: 'POST', body: {} });
    line([400, 401, 404].includes(r.status), `POST /v1/chat/completions 无密钥 → ${r.status}（应为 401，旧版会是 404）`);
    if (r.status === 200) note('严重', 'POST /v1/chat/completions 无密钥竟然成功');
  }

  /* ② 示例默认密钥（仓库里公开的那两个）能不能用 */
  if (TRY_DEFAULTS) {
    hdr('② 示例默认密钥是否仍可用（能进就是重大问题）');
    const a = await req('/admin/api/status', { key: DEF_ADMIN });
    const g = await req('/v1/models', { key: DEF_GW });
    line(a.status !== 200, `默认 ADMIN_KEY → /admin/api/status：${a.status}`);
    line(g.status !== 200, `默认 GATEWAY_KEY → /v1/models：${g.status}`);
    if (a.status === 200) note('严重', '管理面仍接受仓库里公开的默认 ADMIN_KEY —— 任何人都能读全部渠道（含上游密钥并改配置）');
    if (g.status === 200) note('严重', '客户端面仍接受仓库里公开的默认 GATEWAY_KEY —— 任何人都能白嫖你的上游额度');
  }

  /* ③ 这份部署跑的是哪一版控制台 */
  hdr('③ 控制台版本指纹（判断有没有含已知修复）');
  const c = await req('/console');
  if (c.status === 200) {
    const has = (s) => c.text.includes(s);
    // 版本判据只用「v1.18.1 的零数据占位文案」这一条事实：旧版没有它、新版一定有。
    // （旧版曾用「areaChart 函数体形状」当判据，但新版只是在函数开头加了空数组守卫，形状几乎没变——
    //   那条正则会同时命中新旧两版，把新部署误报成"还是旧版本"，2026-10-02 实测踩到，已废弃。）
    const emptyGuard = has('暂无数据');
    line(emptyGuard, `空数据保护（v1.18.1 起「暂无数据」占位）：${emptyGuard ? '有' : '没有'}`);
    line(has('运行期设置'), `运行期设置页（v1.18.2）：${has('运行期设置') ? '有' : '没有'}`);
    if (!emptyGuard) note('中', '这份控制台不带 v1.18.1 的零数据占位——要么是旧版本，要么有人把它改了回去；零调用记录的实例上「详情」可能点不开');
  } else line(false, `/console → ${c.status}`);

  /* ④ 安全响应头 / CORS */
  hdr('④ 安全响应头 / CORS');
  // HSTS 只在 https 上有意义：裸 http 部署报它等于制造噪声（本机/局域网部署全是 http）
  const isHttps = /^https:/i.test(B);
  const want = ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'content-security-policy', ...(isHttps ? ['strict-transport-security'] : [])];
  for (const h of want) {
    const v = c.headers.get(h);
    line(!!v, `${h.padEnd(28)}: ${v || '（缺失）'}`);
    if (!v) note(h === 'content-security-policy' ? '低' : '中',
      h === 'content-security-policy'
        ? '缺少 CSP：控制台目前靠渲染层转义兜底（v1.18.3 起统一 esc），CSP 属纵深防御，需按真实资源单独设计'
        : `缺少安全响应头 ${h}（加固项：nosniff / 防 iframe 嵌套 / 不发 Referer）`);
  }
  if (!isHttps) line(true, `${'strict-transport-security'.padEnd(28)}: （http 部署，不适用）`);
  const acao = c.headers.get('access-control-allow-origin');
  line(!acao, `access-control-allow-origin   : ${acao || '（未设置，跨站页面读不到响应）'}`);
  if (acao) note('中', `CORS 放开了来源 ${acao}`);

  if (HAS_KEYS) {
    /* ⑤ 鉴权覆盖面：无密钥 / 错密钥 / 正确密钥 */
    hdr('⑤ 鉴权覆盖面（无 / 错 / 对）');
    const wrong = 'wrong-key-wrong-key-wrong';
    const matrix = [
      ['/admin/api/status', 'GET'], ['/admin/api/channels', 'GET'], ['/admin/api/usage', 'GET'],
      ['/admin/api/settings', 'GET'], ['/metrics', 'GET'],
      ['/v1/models', 'GET'], ['/anthropic/v1/models', 'GET'], ['/gemini/v1beta/models', 'GET'],
    ];
    for (const [p, m] of matrix) {
      const kw = p.startsWith('/v1') || p.startsWith('/anthropic') || p.startsWith('/gemini') ? GK : AK;
      const no = await req(p, { method: m });
      const bad = await req(p, { method: m, key: wrong });
      const good = await req(p, { method: m, key: kw });
      const ok = no.status === 401 && bad.status === 401;
      line(ok, `${p.padEnd(24)} 无=${no.status} 错=${bad.status} 对=${good.status}`);
      if (!ok) note('高', `${p} 鉴权不符预期（无密钥 ${no.status} / 错密钥 ${bad.status}）`);
      if (leaks(no.text)) note('高', `${p} 未鉴权即回显密钥`);
    }

    /* ⑥ 密钥泄露面 */
    hdr('⑥ 密钥泄露面（网关密钥 + 本机全部上游 apiKey）');
    for (const p of ['/metrics', '/admin/api/status', '/admin/api/channels', '/admin/api/usage', '/admin/api/settings', '/console', '/v1/models']) {
      const r = await req(p, { key: p.startsWith('/v1') ? GK : AK });
      const n = leaks(r.text);
      line(n === 0, `${p.padEnd(24)} 含密钥 ${n} 个（正文 ${r.text.length} 字节）`);
    }
    const ch = await req('/admin/api/channels', { key: AK });
    let raw = 0;
    try { const j = JSON.parse(ch.text); raw = ((j.channels || j) || []).filter((x) => typeof x.apiKey === 'string' && x.apiKey.length >= 12).length; } catch {}
    if (raw) note('中', `管理面直接返回上游 apiKey 明文（${raw} 条）——控制台自己掩码，但接口给了原文：ADMIN_KEY 一旦泄漏，全部上游密钥一起泄漏`);
    else console.log('  ✓ 管理面没有返回上游 apiKey 明文');

    /* ⑦ 错误响应 */
    hdr('⑦ 错误响应泄漏');
    const errs = [
      ['/v1/chat/completions', { method: 'POST', body: { model: '__no_such_model__', messages: [] } }, GK, '未知模型'],
      ['/v1/chat/completions', { method: 'POST', body: {} }, GK, '空报文'],
      ['/admin/api/settings', { method: 'POST', body: { rateLimit: { rpmm: 1 } } }, AK, '未知设置字段'],
      ['/admin/api/nope', {}, AK, '不存在的管理端点'],
    ];
    for (const [p, opt, key, label] of errs) {
      const r = await req(p, { ...opt, key });
      const n = leaks(r.text);
      line(n === 0, `${label.padEnd(12)} → ${r.status}，含密钥 ${n} 个（${r.text.length} 字节）`);
      if (n > 0) note('高', `${label} 的错误响应里回显了 ${n} 个密钥`);
    }
  } else {
    hdr('⑤⑥⑦ 需要密钥的检查（已跳过）');
    console.log('  提示：设好 ADMIN_KEY / GATEWAY_KEY 环境变量后重跑，会加上鉴权覆盖面、密钥泄露面、错误响应泄漏三项。');
  }

  hdr('汇总');
  if (!findings.length) console.log('  ✓ 没有发现需要处理的问题');
  else findings.forEach((f, i) => console.log(`  ${i + 1}. [${f.sev}] ${f.text}`));
})().catch((e) => { console.log('  ✗ 体检脚本抛错：' + e.message); process.exitCode = 1; });
