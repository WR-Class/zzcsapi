#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/font-assets-e2e.test.js — 自托管字体（v1.18.37，真起进程，零依赖）
 *
 * 这一版把全站字体从「小米 MiSans 官方 CDN」换成「寒蝉全圆体（SIL OFL 1.1）自托管分片」。
 * 换字体只是表面，真正要守住的是四件事，每件都能悄悄坏掉而页面不报错：
 *
 *   ① **许可合规**：子集化在 OFL 里算「修改版」，修改版**不得再使用上游保留字体名**
 *      （OFL-FAQ §2.6 与《Webfonts and Reserved Font Names》都写明；§2.2.1 那条"纯 WOFF 压缩可
 *      不改名"的例外不适用于子集化）。所以分片前先用 build/fonts.js 把 name 表改名为 HCRound。
 *      本用例断言**发出去的 CSS 与分片里都不出现 `ChillRoundF`/`ChillRoundM`** —— 合规是可复核的事实，
 *      不是文档里的一句话；同时断言 LICENSE.txt 随字体可公开获取（OFL 条件 2 要求随附声明）。
 *
 *   ② **路径穿越面不存在**：字体是第一个真正服务"目录里的静态文件"的路由（此前控制台只有一根
 *      内联 HTML 壳）。静态文件服务最容易出的事就是把请求路径拼进文件路径。font-assets.js 的做法是
 *      启动时扫成白名单、请求只做 Map.get()——本用例既在源码级断言"没有拼接"，也真发原始报文
 *      （`..` 与 `%2e%2e` 两种编码，绕过客户端归一化）断言一律 404。
 *
 *   ③ **少一个字节就回落系统字体**：入口 CSS 里 266 条 @font-face 与目录里的 woff2 必须一一对上，
 *      Dockerfile 也必须真把 assets/fonts 拷进镜像——否则页面不报错，只是字变了（最难发现的坏法）。
 *
 *   ④ **不再向第三方要字体**：CSP 的 font-src/style-src 收回 'self'，控制台里不许再出现
 *      font.sec.miui.com / cdn-file.hyperos.mi.com。这顺带关掉渗透发现的 N-04
 *      （「CSP 引外部字体 CDN（供应链/隐私面）」，此前登记为"维持"）。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/font-assets-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const MOD = fs.readFileSync(path.join(ROOT, 'font-assets.js'), 'utf8');
const HEAD = fs.readFileSync(path.join(ROOT, 'build', 'head.html'), 'utf8');
const CONSOLE = fs.readFileSync(path.join(ROOT, 'console.html'), 'utf8');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const FONT_DIR = path.join(ROOT, 'assets', 'fonts', 'chillround');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-font-'));
const GW_KEY = 'e2e-gw-font', AD_KEY = 'e2e-admin-font';

/* 上游保留字体名：任何一个出现在发出去的字里都是许可违约，不是风格问题 */
const RFN = ['ChillRoundF', 'ChillRoundM'];
/* 已经不许可再出现的第三方字体主机（N-04 的外发面） */
const THIRD_PARTY = ['font.sec.miui.com', 'cdn-file.hyperos.mi.com'];

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

/* 用裸 http.get 而不是 fetch：fetch(undici) 会**自动解压**并吃掉 content-encoding，
   那就测不出"到底发的是 br / gzip / 原样"——而这正是本用例要断言的。 */
function get(port, p, headers) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    req.on('error', () => resolve({ status: 0, headers: {}, buf: Buffer.alloc(0) }));
  });
}

/* 原始报文：path 原样发出，不做任何客户端归一化——Path traversal 只能这样测出来 */
function rawGet(port, rawPath, headers) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const lines = [`GET ${rawPath} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close'];
      for (const [k, v] of Object.entries(headers || {})) lines.push(`${k}: ${v}`);
      s.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let buf = '';
    s.on('data', (d) => { buf += d.toString('latin1'); });
    s.on('end', () => { const m = buf.match(/^HTTP\/1\.1 (\d{3})/); resolve({ status: m ? +m[1] : 0, raw: buf }); });
    s.on('error', () => resolve({ status: 0, raw: '' }));
  });
}

/* ── 极简 woff2 读取器：只为把分片**内部**的 name 表挖出来核名字 ──────────────────
   为什么必须真解压：woff2 的表数据是一整条 Brotli 流，在压缩字节上直接搜 `ChillRoundF`
   **永远搜不到**——那种检查是"假通过"，它连一个名字都没看过。这里按 woff2 规范做最小解码：
   目录里给了每张表的（变换后）长度，所以第 i 张表在解压结果里的偏移 = 前面各表长度之和
   （有变换的用 transformLength，无变换的用 origLength）。name 表永远不做变换，取出来直接解析。 */
const KNOWN_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
  'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE',
  'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx',
  'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];
const u255 = (b, p) => {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    const c = b[p + i];
    v = ((v << 7) | (c & 0x7f)) >>> 0;
    if (!(c & 0x80)) return { v, p: p + i + 1 };
  }
  throw new Error('Base128 越界');
};

function nameRecordsOfWoff2(file) {
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'wOF2') throw new Error('不是 woff2：' + file);
  const n = b.readUInt16BE(12);
  const compressedSize = b.readUInt32BE(20);
  let p = 48;                                     // woff2 头固定 48 字节
  const dir = [];
  for (let i = 0; i < n; i++) {
    const flags = b[p++];
    const tagIdx = flags & 0x3f;
    const tv = (flags >> 6) & 3;
    const tag = tagIdx === 0x3f ? b.toString('latin1', p, p + 4) : KNOWN_TAGS[tagIdx];
    if (tagIdx === 0x3f) p += 4;
    const o = u255(b, p); p = o.p;
    let len = o.v;
    // 变换长度只对 glyf/loca 存在（loca 的变换长度实测为 0——它由 glyf 反推，不需要自己存字节）
    if (tv !== 3 && (tag === 'glyf' || tag === 'loca')) { const t = u255(b, p); len = t.v; p = t.p; }
    dir.push({ tag, len });
  }
  // 压缩流紧接目录之后（文件尾可能有一小段对齐补位，所以不能拿"文件尾 − 压缩长度"当起点）
  const raw = zlib.brotliDecompressSync(b.slice(p, p + compressedSize));
  const want = dir.reduce((a, t) => a + t.len, 0);
  if (raw.length !== want) throw new Error(`woff2 解码自检失败：解压 ${raw.length} ≠ Σ表长 ${want}（${file}）`);
  let off = 0, range = null;
  for (const t of dir) { if (t.tag === 'name') range = { off, len: t.len }; off += t.len; }
  if (!range) throw new Error('没有 name 表：' + file);
  const nt = raw.slice(range.off, range.off + range.len);
  const count = nt.readUInt16BE(2), strOff = nt.readUInt16BE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const plat = nt.readUInt16BE(r), id = nt.readUInt16BE(r + 6), len = nt.readUInt16BE(r + 8), so = nt.readUInt16BE(r + 10);
    const s = Buffer.from(nt.slice(strOff + so, strOff + so + len));
    out.push({ id, plat, text: plat === 3 || plat === 0 ? (s.swap16(), s.toString('utf16le')) : s.toString('latin1') });
  }
  return out;
}

(async () => {
  /* ─────────────────── 0. 装配守卫（源码级，不需要起进程） ─────────────────── */
  console.log('\n0. 装配守卫：白名单查表 / 缓存策略 / CSP 收回 self');

  check('font-assets.js 用「启动时扫成白名单 + 请求只查表」，不做路径拼接',
    /FILES\.get\(pathname\)/.test(MOD) && /const FILES = \(\(\) => \{/.test(MOD) &&
    !/path\.(join|resolve)\([^)]*pathname/.test(MOD),
    MOD.match(/path\.(join|resolve)\([^)]*pathname[^)]*\)/) || null);

  check('字体路由定义在 createServer 之后、且在 try 块内（与 /console 壳同级，不被客户端面封禁闸门挡）',
    SRC.indexOf('fontAssets.serveFont(req, res, url.pathname)') > SRC.indexOf('const server = http.createServer(') &&
    SRC.indexOf('fontAssets.serveFont(req, res, url.pathname)') > SRC.indexOf('// 控制台 HTML 壳'));

  check('扩展名白名单只放 woff2/css/txt —— 目录里将来多出任何中间产物（.bin/.js/.json）都不会被发出去',
    /MIME = \{[\s\S]{0,200}?\}/.test(MOD) &&
    /'\.woff2': 'font\/woff2'/.test(MOD) && /'\.css': 'text\/css/.test(MOD) &&
    !/\.(js|json|bin|html|map)'/.test(MOD.match(/MIME = \{[\s\S]{0,200}?\}/)[0]));

  check('分片长缓存 immutable、入口 CSS 只短缓存（分片名是内容哈希；CSS 名固定，缓存久了换字体必 404）',
    /max-age=31536000, immutable/.test(MOD) && /max-age=300/.test(MOD) &&
    /ext === '\.woff2' \? 'public, max-age=31536000, immutable'/.test(MOD));

  check('woff2 不做二次压缩（它本身就是 Brotli，再压是白烧 CPU）',
    /COMPRESSIBLE = new Set\(\['\.css', '\.txt'\]\)/.test(MOD));

  check('Dockerfile 把字体目录拷进镜像（漏了这行容器里就没有字体，页面不报错只是字变了）',
    /COPY assets\/fonts \.\/assets\/fonts/.test(DOCKERFILE) && /COPY font-assets\.js \.\//.test(DOCKERFILE));

  check('build/head.html 仍是 21 行（build/build.js 的构建期守卫），且换成同源字体入口',
    HEAD.replace(/\n$/, '').split('\n').length === 21 && /<link href="\/console\/fonts\/font\.css" rel="stylesheet">/.test(HEAD) &&
    !/preconnect/.test(HEAD));

  const csp = (SRC.match(/\['Content-Security-Policy',\s*"([^"]*)"\]/) || [])[1] || '';
  check("CSP 的 font-src / style-src 已收回 'self'，两个小米 CDN 主机全部移除",
    /font-src 'self'/.test(csp) && /style-src 'self' 'unsafe-inline';/.test(csp) &&
    THIRD_PARTY.every((h) => !csp.includes(h)) && !csp.includes('hyperos'), csp);

  check('全仓源码与构建产物里不再出现第三方字体主机（N-04 关闭的物证）',
    THIRD_PARTY.every((h) => !SRC.includes(h) && !CONSOLE.includes(h) && !HEAD.includes(h)));

  check('console.html（构建产物）已带同源字体入口与 HCRound 字体栈',
    /<link href="\/console\/fonts\/font\.css" rel="stylesheet">/.test(CONSOLE) &&
    /--f-ui:"HCRound"/.test(CONSOLE) && !/MiSans/.test(CONSOLE));

  check('字重只剩两档：源文件里 500/600 已清零（只有 400/700 是真实存在的字重）',
    !/font-weight:\s*(500|600)\b/.test(HEAD) &&
    !/font-weight:\s*(500|600)\b/.test(fs.readFileSync(path.join(ROOT, 'build', 'extra.css'), 'utf8')) &&
    !/font-weight:\s*(500|600)\b/.test(fs.readFileSync(path.join(ROOT, 'build', 'app.js'), 'utf8')));

  /* ─────────────────── 1. 资产自洽（合不合规、对不对得上） ─────────────────── */
  console.log('\n1. 资产自洽：分片齐、名字已改、许可证随附');

  const shards = { regular: [], bold: [] };
  for (const w of ['regular', 'bold']) {
    shards[w] = fs.readdirSync(path.join(FONT_DIR, w)).filter((f) => f.endsWith('.woff2')).sort();
  }
  check(`两个字重的分片都在（regular ${shards.regular.length} / bold ${shards.bold.length}）`,
    shards.regular.length > 100 && shards.bold.length > 100);

  const css = fs.readFileSync(path.join(FONT_DIR, 'font.css'), 'utf8');
  const faces = (css.match(/@font-face/g) || []).length;
  check(`入口 CSS 的 @font-face 数 = 目录里的 woff2 数（${faces} = ${shards.regular.length + shards.bold.length}）——` +
    '少一片就是"某些字回落系统字体"，页面不会报错',
    faces === shards.regular.length + shards.bold.length);

  const urls = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1]);
  const missing = urls.filter((u) => !fs.existsSync(path.join(FONT_DIR, u.replace(/^\.\//, ''))));
  check('CSS 里引用的分片逐一存在（0 个缺件）', urls.length === faces && missing.length === 0, missing.slice(0, 3));

  check('两个字重都真的声明了 400 / 700（不是全都 400，那样粗体就要靠浏览器伪加粗）',
    /font-weight:\s*400/.test(css) && /font-weight:\s*700/.test(css) &&
    css.includes('./regular/') && css.includes('./bold/'));

  /* 合规硬断言：发出去的 CSS 里不许有上游保留字体名 */
  const cssRfn = RFN.filter((r) => css.includes(r));
  check('★ 入口 CSS 里没有上游保留字体名（ChillRoundF/ChillRoundM）——子集化属修改版，OFL 禁用 RFN',
    cssRfn.length === 0, cssRfn);
  check('CSS 里声明的是改后的族名 HCRound',
    /font-family:\s*['"]?HCRound['"]?/.test(css) && !/font-family:\s*['"]?(?!HCRound)/.test(''));

  const lic = fs.readFileSync(path.join(FONT_DIR, 'LICENSE.txt'), 'utf8');
  check('LICENSE.txt 随字体在仓库里，且是 SIL OFL 1.1 原文（OFL 条件 2：修改版必须随附声明）',
    /SIL OPEN FONT LICENSE/i.test(lic) && /Version 1\.1/i.test(lic) && /Reserved Font Name/i.test(lic));

  /* 分片**内部**的 name 表：合规的最终落点。改名做在切分之前，才会传导进每一个分片。
     先来一条正对照——证明这个读取器真能挖出名字（否则"没有 RFN"就是空话）。 */
  const probe = nameRecordsOfWoff2(path.join(FONT_DIR, 'regular', shards.regular[0]));
  check('woff2 读取器自证有效：能从分片内部解出 name 表，且族名已是 HCRound（正对照）',
    probe.some((r) => r.text === 'HCRound' && r.id === 1), probe.slice(0, 4));

  const badName = [];
  let copySeen = 0, licInShard = 0;
  const total = shards.regular.length + shards.bold.length;
  for (const w of ['regular', 'bold']) {
    for (const f of shards[w]) {
      const recs = nameRecordsOfWoff2(path.join(FONT_DIR, w, f));
      if (recs.some((r) => RFN.some((x) => r.text.includes(x)))) badName.push(w + '/' + f);
      // 条件 2：版权声明必须"随每一份副本"——分片里 nameID 0 带着原始权利人
      if (recs.some((r) => r.id === 0 && /MOTOYA|ChillType|Maoken/.test(r.text))) copySeen++;
      if (recs.some((r) => r.id === 13)) licInShard++;
    }
  }
  check(`★ 全部 ${total} 个 woff2 分片**解压后的 name 表**都不含保留字体名（ChillRoundF/ChillRoundM）——` +
    '子集化属修改版，OFL 禁用 RFN；改名做在切分之前才传导得进来', badName.length === 0, badName.slice(0, 3));
  check(`每个分片的 name 表都带着原始版权声明（${copySeen}/${total}，nameID 0：MOTOYA/ChillType/Maoken）`,
    copySeen === total, { copySeen, total });

  /* 实测发现（记在 docs/fonts.md）：cn-font-split **不把 nameID 13/14（许可描述/许可 URL）写进输出分片**
     ——分片里只剩 7 条记录（版权/族名/子族名/UniqueID/全名/版本/PostScript）。它自己的 result.css 元数据头
     读的是**输入字体**，所以那一行"LicenseDescription …"不能当作分片里真有许可的证据（本用例的解码器就是为了
     不让自己被骗才写的）。
     这**不违反** OFL：条件 2 明文允许"either as stand-alone text files … or in the appropriate machine-readable
     metadata fields"，版权已随分片、许可正文以独立文件随附即可 —— 但反过来意味着 LICENSE.txt 是**承重件**：
     没有它才是真违约。所以这里断言两件事同时成立。 */
  const servedLic = fs.existsSync(path.join(FONT_DIR, 'LICENSE.txt'));
  check(`许可正文本就要求以独立文件随附（分片内 nameID 13 实测 ${licInShard}/${total} 条，cn-font-split 会丢掉它）` +
    '——所以 LICENSE.txt 是承重的，不是摆设', servedLic);

  /* ─────────────────── 2. 真链路：静态服务的行为 ─────────────────── */
  console.log('\n2. 真链路：同源发得出去、穿越进不来、缓存分层正确');

  const GW = await freePort();
  const cfgPath = path.join(TMP, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 1 }, channels: [],
  }));
  const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
    stdio: 'ignore',
  });
  let up = false;
  for (let t = Date.now(); Date.now() - t < 20000;) {
    try { if ((await get(GW, '/healthz')).status === 200) { up = true; break; } } catch { }
    await sleep(200);
  }
  check('临时网关起来了', up);

  try {
    /* ① 入口 CSS：br / gzip / 原样 三条线都要对 */
    const br = await get(GW, '/console/fonts/font.css', { 'Accept-Encoding': 'br' });
    check('font.css → 200 text/css，brotli 压缩（Content-Encoding: br + Vary）',
      br.status === 200 && br.headers['content-type'] === 'text/css; charset=utf-8' &&
      br.headers['content-encoding'] === 'br' && /Accept-Encoding/.test(br.headers['vary'] || ''),
      { status: br.status, ce: br.headers['content-encoding'], ct: br.headers['content-type'] });
    let cssOut = '';
    try { cssOut = zlib.brotliDecompressSync(br.buf).toString('utf8'); } catch { }
    check(`brotli 解出来就是完整的入口 CSS（${(br.buf.length / 1024).toFixed(1)} KB 压缩态 / ${(cssOut.length / 1024).toFixed(0)} KB 原文）`,
      cssOut === css);

    const gz = await get(GW, '/console/fonts/font.css', { 'Accept-Encoding': 'gzip' });
    check('font.css 对只认 gzip 的客户端退回 gzip（不是原样吐 200KB）',
      gz.status === 200 && gz.headers['content-encoding'] === 'gzip' &&
      zlib.gunzipSync(gz.buf).toString('utf8') === css);

    const raw = await get(GW, '/console/fonts/font.css', {});
    check('不声明 Accept-Encoding 就发原文（字节数 = 文件大小）',
      raw.status === 200 && !raw.headers['content-encoding'] &&
      raw.buf.length === fs.statSync(path.join(FONT_DIR, 'font.css')).size);

    check('入口 CSS 短缓存（max-age=300）——名字固定，缓存久了换字体新旧混用会 404',
      raw.headers['cache-control'] === 'public, max-age=300', raw.headers['cache-control']);

    /* ② 分片：真 woff2 字节 + immutable 长缓存 + 绝不二次压缩 */
    const oneReg = shards.regular.find((f) => f.startsWith('0')) || shards.regular[0];
    const oneBold = shards.bold.find((f) => f.startsWith('0')) || shards.bold[0];
    for (const [w, f] of [['regular', oneReg], ['bold', oneBold]]) {
      const r = await get(GW, `/console/fonts/${w}/${f}`, { 'Accept-Encoding': 'br, gzip' });
      const sig = r.buf.slice(0, 4).toString('latin1');
      check(`${w}/${f} → 200 font/woff2，字节是 wOF2 签名（${(r.buf.length / 1024).toFixed(1)} KB）`,
        r.status === 200 && r.headers['content-type'] === 'font/woff2' && sig === 'wOF2',
        { status: r.status, ct: r.headers['content-type'], sig });
      check(`${w} 分片 immutable 长缓存且不做二次压缩`,
        /immutable/.test(r.headers['cache-control'] || '') && !r.headers['content-encoding'],
        { cc: r.headers['cache-control'], ce: r.headers['content-encoding'] });
    }

    /* ③ 许可证可公开获取（OFL 条件 2 的"随附"在 Web 投递下的落地方式） */
    const lr = await get(GW, '/console/fonts/LICENSE.txt', {});
    check('LICENSE.txt → 200 text/plain 且是 OFL 原文（任何人可核对授权）',
      lr.status === 200 && /text\/plain/.test(lr.headers['content-type'] || '') &&
      /SIL OPEN FONT LICENSE/i.test(lr.buf.toString('utf8')));

    /* ④ 路径穿越：`..` 与 `%2e%2e` 两种编码、原始报文直发，一律 404 */
    const trav = [
      '/console/fonts/../server.js',
      '/console/fonts/../../server.js',
      '/console/fonts/regular/../../server.js',
      '/console/fonts/%2e%2e/server.js',
      '/console/fonts/%2e%2e%2fserver.js',
      '/console/fonts/..%2fserver.js',
      '/console/fonts/....//server.js',
      '/console/fonts//etc/passwd',
    ];
    const leaked = [];
    for (const p of trav) {
      const r = await rawGet(GW, p, {});
      if (r.status !== 404) leaked.push(p + ' → ' + r.status);
    }
    check('★ 八种路径穿越写法全部 404（白名单查表：请求路径根本没机会变成文件路径）',
      leaked.length === 0, leaked);

    /* ⑤ 不存在的文件 / 目录本身 / 非白名单扩展名 */
    for (const [p, why] of [
      ['/console/fonts/regular/deadbeef.woff2', '不存在的分片'],
      ['/console/fonts/font.css', '存在的入口 CSS（对照：它必须 200）'],
    ]) {
      const r = await get(GW, p, {});
      if (why.includes('对照')) check(`${why} → ${r.status}（200）`, r.status === 200);
      else check(`${why}（${p}）→ 404`, r.status === 404, r.status);
    }
    for (const p of ['/console/fonts', '/console/fonts/', '/console/fonts/regular/', '/console/fonts/LICENSE']) {
      const r = await get(GW, p, {});
      check(`目录与无扩展名路径不被当文件发（${p}）→ 404`, r.status === 404, r.status);
    }

    /* ⑥ 方法约束 */
    const post = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: GW, path: '/console/fonts/font.css', method: 'POST' },
        (res) => { res.resume(); resolve({ status: res.statusCode, allow: res.headers.allow }); });
      req.on('error', () => resolve({ status: 0 }));
      req.end();
    });
    check('POST 字体路径 → 405 且带 Allow（只读资源不接受写方法）',
      post.status === 405 && /GET/.test(post.allow || ''), post);

    /* ⑦ 字体响应同样带齐安全头与收回后的 CSP */
    const hd = await get(GW, '/console/fonts/font.css', {});
    check('字体响应带 nosniff 且 CSP 里 font-src 已是 self（不再白名单任何外部主机）',
      hd.headers['x-content-type-options'] === 'nosniff' &&
      /font-src 'self'/.test(hd.headers['content-security-policy'] || '') &&
      THIRD_PARTY.every((h) => !(hd.headers['content-security-policy'] || '').includes(h)),
      (hd.headers['content-security-policy'] || '').slice(0, 80));

    /* ⑧ 控制台壳本身：真发出去的 HTML 里就该是 HCRound（而不是"源文件改了但没重建"） */
    const shell = await get(GW, '/console', {});
    const shellHtml = shell.buf.toString('utf8');
    check('★ /console 真发出来的 HTML：字体入口是同源的、字体栈是 HCRound、无 MiSans 无小米 CDN',
      shell.status === 200 && shellHtml.includes('/console/fonts/font.css') &&
      shellHtml.includes('"HCRound"') && !/MiSans/.test(shellHtml) && THIRD_PARTY.every((h) => !shellHtml.includes(h)));

    /* ⑨ 公开面与不透明面不混：字体不需要鉴权（它不是机密），但管理面依旧要 */
    const anon = await get(GW, '/admin/api/status', {});
    check('拿下字体不意味着拿下管理面：/admin/api/status 匿名仍 401',
      anon.status === 401, anon.status);
  } finally {
    try { gw.kill(); } catch { }
    await sleep(300);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (!fail) console.log(`✓ 全部通过（${pass} 项断言）`);
  const hang = setTimeout(() => { console.log('（提示：句柄未完全释放，强制结束）'); process.exit(fail ? 1 : 0); }, 3000);
  hang.unref();
  if (fail) process.exitCode = 1;
})().catch((e) => { console.log('✗ 用例自身抛错：' + e.stack); process.exitCode = 1; });
