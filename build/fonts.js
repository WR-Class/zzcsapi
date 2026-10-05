#!/usr/bin/env node
/* 字体资产工具（零依赖）—— 寒蝉全圆体 → 本站自托管 webfont 的两个不可省步骤。

  ① rename：按 OFL-1.1 的**保留字体名（RFN）**条款给"子集化产物"改名。
     依据（SIL 官方口径，不是我们的解读）：
       · OFL-FAQ §2.6：「给 webfont 做子集化算修改吗？——算。为投递到浏览器而移除字体
         任何部分（未用字形、智能排版代码）都算修改。OFL 允许这么做，但通常不允许再用 RFN。」
       · 《Webfonts and Reserved Font Names》：「Pre-subsetting …… 无法保留功能等价（FE），
         因此必须视为修改版，RFN 限制适用。」
       · OFL-FAQ §2.2.1：只有"除 WOFF 压缩外原始字体数据完全未变、且元数据原样保留"的
         纯格式转换才可以不改名 —— cn-font-split 是子集化，不属于此列。
     所以：**分片前先把源 TTF 的 name 表改成本站自有名字**，再交给 cn-font-split。
     同时**原样保留**版权声明 / 许可描述 / 许可 URL / 设计者等字段（OFL 条件 2 要求随附声明），
     只在 description 里追加一句"本站改了什么"（OFL-FAQ §5.3 允许在 description 里注明出处）。

  ② merge：把两个字重的 result.css 合成单一入口 font.css（URL 前缀改写 + 逐文件校验 +
     扫 RFN 残留）。校验失败就直接退出非零，不给"悄悄发布一个不合规字体"的机会。

  用法：
    node build/fonts.js dump   <font.ttf>
    node build/fonts.js rename <in.ttf> <out.ttf> <Family> <Style> <Weight>
    node build/fonts.js merge
*/
'use strict';
const fs = require('fs');
const path = require('path');

// 上游保留字体名（LICENSE.txt 原文：with Reserved Font Name 'ChillRoundF' 'ChillRoundM'）。
// 修改版一律不许出现它们 —— 包括 name 表与 CSS 里的 family 名（OFL-FAQ §5.3）。
const RFN = ['ChillRoundF', 'ChillRoundM'];
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts', 'chillround');
// 允许保留的"出处引用"字段：description（nameID 10）按 FAQ §5.3 可以注明来源
const REF_OK_IDS = new Set([10]);

/* ───────────────────────── sfnt 读写 ───────────────────────── */

function parseSfnt(buf) {
  const numTables = buf.readUInt16BE(4);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const r = 12 + i * 16;
    tables.push({
      tag: buf.toString('latin1', r, r + 4),
      sum: buf.readUInt32BE(r + 4),
      off: buf.readUInt32BE(r + 8),
      len: buf.readUInt32BE(r + 12),
    });
  }
  return { sfntVersion: buf.readUInt32BE(0), numTables, tables };
}

function sum32(buf) {                       // 表校验和：uint32 大端累加
  let s = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const v = (buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | (buf[i + 3] || 0);
    s = (s + (v >>> 0)) >>> 0;
  }
  return s >>> 0;
}

/* ───────────────────────── name 表 ───────────────────────── */

function parseName(data) {
  const format = data.readUInt16BE(0);
  const count = data.readUInt16BE(2);
  const stringOffset = data.readUInt16BE(4);
  const records = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    records.push({
      platformID: data.readUInt16BE(r),
      encodingID: data.readUInt16BE(r + 2),
      languageID: data.readUInt16BE(r + 4),
      nameID: data.readUInt16BE(r + 6),
      length: data.readUInt16BE(r + 8),
      offset: data.readUInt16BE(r + 10),
    });
  }
  const tail = 6 + count * 12;
  return {
    format,
    records,
    storage: data.slice(stringOffset),
    // format 1 的语言标签块：原样搬运，不解读
    langTagBlock: format === 1 ? Buffer.from(data.slice(tail, stringOffset)) : Buffer.alloc(0),
  };
}

function decodeString(rec, storage) {
  const raw = Buffer.from(storage.slice(rec.offset, rec.offset + rec.length));
  if (rec.platformID === 0 || rec.platformID === 3) { raw.swap16(); return raw.toString('utf16le'); }
  return raw.toString('latin1');            // platform 1（Mac）：我们的新名字全是 ASCII，够用
}

function encodeString(text, platformID) {
  if (platformID === 0 || platformID === 3) {
    const b = Buffer.from(text, 'utf16le');
    b.swap16();
    return b;
  }
  const b = Buffer.from(text, 'latin1');
  for (const byte of b) if (byte > 0x7f) throw new Error(`platform ${platformID} 只能写 ASCII，收到非 ASCII 文本：${text}`);
  return b;
}

function buildName(nt) {
  const pool = [];
  const index = new Map();
  const records = nt.records.map((rec) => {
    const key = rec.platformID + '|' + rec.text;
    let off = index.get(key);
    if (off === undefined) {
      const bytes = encodeString(rec.text, rec.platformID);
      off = pool.reduce((a, b) => a + b.length, 0);
      index.set(key, off);
      pool.push(bytes);
    }
    return { ...rec, offset: off, length: encodeString(rec.text, rec.platformID).length };
  });
  const storage = Buffer.concat(pool);
  const head = Buffer.alloc(6 + records.length * 12);
  head.writeUInt16BE(nt.format, 0);
  head.writeUInt16BE(records.length, 2);
  // stringOffset = 6 + count*12 + langTagBlock 长度
  head.writeUInt16BE(6 + records.length * 12 + nt.langTagBlock.length, 4);
  records.forEach((rec, i) => {
    const r = 6 + i * 12;
    head.writeUInt16BE(rec.platformID, r);
    head.writeUInt16BE(rec.encodingID, r + 2);
    head.writeUInt16BE(rec.languageID, r + 4);
    head.writeUInt16BE(rec.nameID, r + 6);
    head.writeUInt16BE(rec.length, r + 8);
    head.writeUInt16BE(rec.offset, r + 10);
  });
  return Buffer.concat([head, nt.langTagBlock, storage]);
}

/* ───────────────────────── 整体重组 ───────────────────────── */

function assemble(sfnt, tables) {
  // 规范要求表目录按 tag 升序
  tables = tables.slice().sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const n = tables.length;
  const p2 = Math.floor(Math.log2(n));
  const searchRange = Math.pow(2, p2) * 16;
  let off = 12 + n * 16;
  const placed = tables.map((t) => {
    const padded = Math.ceil(t.data.length / 4) * 4;
    const rec = { tag: t.tag, data: t.data, off, len: t.data.length };
    off += padded;
    return rec;
  });
  const out = Buffer.alloc(off);
  out.writeUInt32BE(sfnt.sfntVersion, 0);
  out.writeUInt16BE(n, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(p2, 8);
  out.writeUInt16BE(n * 16 - searchRange, 10);
  placed.forEach((rec, i) => {
    const r = 12 + i * 16;
    out.write(rec.tag, r, 'latin1');
    out.writeUInt32BE(sum32(rec.data), r + 4);
    out.writeUInt32BE(rec.off, r + 8);
    out.writeUInt32BE(rec.len, r + 12);
    rec.data.copy(out, rec.off);
  });
  // head.checkSumAdjustment：先归零算全文件校验和，再回填
  const headRec = placed.find((r) => r.tag === 'head');
  if (headRec) {
    out.writeUInt32BE(0, headRec.off + 8);
    const adj = (0xB1B0AFBA - sum32(out)) >>> 0;
    out.writeUInt32BE(adj, headRec.off + 8);
  }
  return out;
}

function loadTables(buf, sfnt) {
  return sfnt.tables.map((t) => ({ tag: t.tag, data: Buffer.from(buf.slice(t.off, t.off + t.len)) }));
}

/* ───────────────────────── 子命令 ───────────────────────── */

function dump(file) {
  const buf = fs.readFileSync(file);
  const sfnt = parseSfnt(buf);
  const nameTable = sfnt.tables.find((t) => t.tag === 'name');
  const nt = parseName(buf.slice(nameTable.off, nameTable.off + nameTable.len));
  const IDNAME = { 0: 'Copyright', 1: 'Family', 2: 'Subfamily', 3: 'UniqueID', 4: 'FullName', 5: 'Version', 6: 'PostScript', 7: 'Trademark', 8: 'Manufacturer', 9: 'Designer', 10: 'Description', 11: 'VendorURL', 12: 'DesignerURL', 13: 'LicenseDesc', 14: 'LicenseURL', 16: 'TypoFamily', 17: 'TypoSubfamily', 18: 'CompatFull', 20: 'CIDFindfont', 21: 'WWSFamily', 22: 'WWSSubfamily', 25: 'VarPSPrefix' };
  console.log(`${path.basename(file)}  name 表：format=${nt.format} 记录 ${nt.records.length} 条\n`);
  const seen = new Map();
  for (const rec of nt.records) {
    const text = decodeString(rec, nt.storage);
    const key = rec.nameID + '|' + text;
    if (seen.has(key)) continue;
    seen.set(key, 1);
    const hit = RFN.some((r) => text.includes(r));
    const label = (IDNAME[rec.nameID] || ('nameID' + rec.nameID)).padEnd(13);
    const one = text.replace(/\s+/g, ' ').slice(0, 96);
    console.log(`  ${hit ? '⛔RFN' : '    '} ${String(rec.nameID).padStart(2)} ${label} p${rec.platformID}  ${one}`);
  }
  const hits = [...seen.keys()].filter((k) => RFN.some((r) => k.split('|')[1].includes(r)));
  console.log(`\n含保留字体名的不同取值：${hits.length} 条`);
  return hits.length;
}

function rename(inFile, outFile, family, style, weight) {
  const buf = fs.readFileSync(inFile);
  const sfnt = parseSfnt(buf);
  const tables = loadTables(buf, sfnt);
  const nameTable = tables.find((t) => t.tag === 'name');
  const nt = parseName(nameTable.data);

  const ps = `${family}-${style}`;                       // PostScript 名不许带空格
  const patch = {
    1: family, 2: style, 4: `${family} ${style}`, 6: ps,
    16: family, 17: style, 18: `${family} ${style}`,
    21: family, 22: style,
    3: `${family};${style};subset`,                      // UniqueID 必须不再含 RFN
  };
  const note = `【本站改作】为 Web 投递按 unicode-range 预切分并改名为 ${family}（OFL-1.1 保留字体名条款：子集化属修改版，不得沿用 RFN）。原始字体及完整字符集见 https://github.com/Warren2060/ChillRound 。`;

  let renamed = 0;
  nt.records = nt.records.map((rec) => {
    const text = decodeString(rec, nt.storage);
    if (patch[rec.nameID] !== undefined) { renamed++; return { ...rec, text: patch[rec.nameID] }; }
    if (rec.nameID === 10) return { ...rec, text: text + (text.includes('本站改作') ? '' : note) };
    return { ...rec, text };
  });
  nameTable.data = buildName(nt);

  const out = assemble(sfnt, tables);
  fs.writeFileSync(outFile, out);
  console.log(`改名完成：${path.basename(inFile)} → ${path.basename(outFile)}`);
  console.log(`  family=${family}  style=${style}  weight=${weight}  PostScript=${ps}`);
  console.log(`  改写 name 记录 ${renamed} 条（版权/许可/设计者字段原样保留），输出 ${(out.length / 1048576).toFixed(2)} MB`);
}

function merge() {
  const parts = ['regular', 'bold'];
  const expected = { regular: '400', bold: '700' };
  let banner = '';
  const blocks = [];
  let faceCount = 0;
  const problems = [];

  for (const p of parts) {
    const cssPath = path.join(FONT_DIR, p, 'result.css');
    if (!fs.existsSync(cssPath)) { problems.push(`缺 ${p}/result.css`); continue; }
    let css = fs.readFileSync(cssPath, 'utf8');
    const head = css.match(/^\/\*[\s\S]*?\*\//);          // cn-font-split 的元数据头（含 name 表转储）
    if (!banner && head) banner = head[0];
    css = css.replace(/^\/\*[\s\S]*?\*\//, '').trim();
    // URL 前缀：result.css 里的 ./x.woff2 要指向 ./<weight>/x.woff2
    css = css.replace(/url\((["']?)\.\//g, (_m, q) => `url(${q}./${p}/`);
    // 逐条校验引用的分片真的存在
    const urls = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1]);
    for (const u of urls) {
      const f = path.join(FONT_DIR, u.replace(/^\.\//, ''));
      if (!fs.existsSync(f)) problems.push(`${p}: 引用了不存在的分片 ${u}`);
    }
    const weights = new Set([...css.matchAll(/font-weight:\s*([^;}\s]+)/g)].map((m) => m[1]));
    if (!weights.has(expected[p])) problems.push(`${p}: font-weight 期望 ${expected[p]}，实际 ${[...weights].join(',')}`);
    faceCount += (css.match(/@font-face/g) || []).length;
    blocks.push(css);
    console.log(`  ${p.padEnd(8)} @font-face ${(css.match(/@font-face/g) || []).length} 个  引用分片 ${urls.length} 个  font-weight ${[...weights].join(',')}`);
  }

  // RFN 残留扫描：CSS 里除了注释头（出处引用）以外不该出现保留字体名
  const merged = `${banner}\n/* 本站入口：由 build/fonts.js merge 生成，勿手改。两个字重合并自 regular/result.css 与 bold/result.css。 */\n${blocks.join('\n')}\n`;
  const body = merged.replace(/^\/\*[\s\S]*?\*\//, '');
  for (const r of RFN) if (body.includes(r)) problems.push(`合并后的 CSS 正文出现保留字体名 ${r}`);

  if (problems.length) {
    console.error('\n✗ 校验未通过：');
    problems.slice(0, 20).forEach((p) => console.error('   ' + p));
    process.exit(1);
  }
  const outPath = path.join(FONT_DIR, 'font.css');
  fs.writeFileSync(outPath, merged);
  console.log(`\n✓ font.css 生成：${(merged.length / 1024).toFixed(1)} KB，@font-face 共 ${faceCount} 个，引用的分片全部存在，正文无 RFN 残留`);
}

/* ───────────────────────── 入口 ───────────────────────── */

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'dump') { process.exit(dump(args[0]) ? 1 : 0); }
else if (cmd === 'rename') { rename(args[0], args[1], args[2], args[3], args[4]); }
else if (cmd === 'merge') { merge(); }
else {
  console.log('用法：\n  node build/fonts.js dump   <font.ttf>\n  node build/fonts.js rename <in.ttf> <out.ttf> <Family> <Style> <Weight>\n  node build/fonts.js merge');
  process.exit(2);
}
