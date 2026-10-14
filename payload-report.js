#!/usr/bin/env node
/* 请求体构成审计（只读，零依赖）—— 回答「这坨 token 到底花在哪、哪些能删而不丢信息」。
 *
 * 为什么需要它：真实调用动辄 400KB~1MB，上游首字节要 30~90 秒。要谈优化，
 * 先得知道钱花在哪：是 system 提示？工具目录？历史工具流量？还是重复上传的图片？
 * 猜没用——本脚本把每一份落盘报文拆开统计，并对 >400 字符的内容块做哈希去重。
 *
 * 「可证明的重复」= 同一段字节在同一轮里出现多次。删掉后面那份，模型仍有第一份，
 * 零信息损失。反过来，只出现一次的内容一旦删掉就是真丢信息——这两类必须分开算。
 *
 * 用法：node payload-report.js [dump 目录，默认 ./dump]
 * 只打印尺寸、条数、哈希与类型，**绝不打印对话内容本身**。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.argv[2] || path.join(__dirname, 'dump');
const MIN_BLOCK = 400;                      // 小于这个长度的内容块不参与去重（噪音）

if (!fs.existsSync(DIR)) {
  console.error(`没有这个目录：${DIR}`);
  console.error('（请求体落盘诊断默认关闭，靠 ZZCSAPI_DUMP_BODIES 打开）');
  process.exit(1);
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const T = { system: 0, userText: 0, asstText: 0, asstToolArgs: 0, toolResult: 0, image: 0, toolsDef: 0 };
const blocks = new Map();                   // hash -> { n, len, kind }
let reqs = 0, skipped = 0, bodyBytes = 0;
const perReq = [];

for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { skipped++; continue; }
  let b = j.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { skipped++; continue; } }
  if (!b || !Array.isArray(b.messages)) { skipped++; continue; }
  reqs++;
  bodyBytes += j.bytes || 0;
  T.toolsDef += b.tools ? JSON.stringify(b.tools).length : 0;

  let imgKB = 0;
  const add = (text, kind, bucket) => {
    if (!text) return;
    if (bucket !== null) T[bucket] += text.length;
    if (text.length < MIN_BLOCK) return;
    const h = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
    const e = blocks.get(h) || { n: 0, len: text.length, kind };
    e.n++; blocks.set(h, e);
  };

  for (const m of b.messages) {
    const role = m && m.role;
    if (role === 'system') { T.system += JSON.stringify(m).length; continue; }
    const c = m && m.content;
    if (Array.isArray(c)) {
      for (const part of c) {
        if (!part) continue;
        if (part.type === 'image_url') {
          const u = String((part.image_url || {}).url || '');
          T.image += u.length; imgKB += u.length / 1024;
          continue;
        }
        const t = typeof part.text === 'string' ? part.text : '';
        add(t, 'text/' + role, role === 'assistant' ? 'asstText' : role === 'user' ? 'userText' : role === 'tool' ? 'toolResult' : null);
      }
    } else if (typeof c === 'string') {
      add(c, role, role === 'assistant' ? 'asstText' : role === 'user' ? 'userText' : role === 'tool' ? 'toolResult' : null);
    }
    for (const tc of m && m.tool_calls || []) {
      const a = tc && tc.function && tc.function.arguments ? String(tc.function.arguments) : '';
      add(a, 'toolargs/' + ((tc.function || {}).name || '?'), 'asstToolArgs');
    }
  }
  perReq.push({ f, kb: Math.round((j.bytes || 0) / 1024), msgs: b.messages.length, imgKB: Math.round(imgKB) });
}

const total = Object.values(T).reduce((a, x) => a + x, 0);
const B = (v) => (v / 1024).toFixed(0).padStart(7) + ' KB';
const P = (v) => String(Math.round((100 * v) / total)).padStart(3) + '%';

console.log(`\n分析 ${reqs} 份真实报文（跳过 ${skipped} 份），落盘合计 ${(bodyBytes / 1024 / 1024).toFixed(1)} MB`);
console.log('\n■ 按内容类型');
for (const [k, v] of Object.entries(T).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(14)}${B(v)}  ${P(v)}`);
}
console.log(`  ${'合计'.padEnd(12)}${B(total)}`);

const all = [...blocks.values()];
const dup = all.filter((x) => x.n > 1);
const dupBytes = dup.reduce((s, x) => s + x.len * (x.n - 1), 0);
const allBytes = all.reduce((s, x) => s + x.len * x.n, 0);
console.log(`\n■ 内容块去重（只算 >${MIN_BLOCK} 字符的块）`);
console.log(`  块出现总次数      ${all.reduce((s, x) => s + x.n, 0)}`);
console.log(`  不同块            ${blocks.size}`);
console.log(`  重复出现的块      ${dup.length}`);
console.log(`  可证明的重复      ${(dupBytes / 1024).toFixed(0)} KB  占这些块 ${Math.round((100 * dupBytes) / allBytes)}%`);
console.log(`  只出现一次        ${(allBytes - dupBytes < 0 ? 0 : (allBytes - dupBytes) / 1024).toFixed(0)} KB  ← 删这些就是真丢信息`);

if (dup.length) {
  console.log('\n■ 浪费最多的 10 块（哈希 / 类型 / 单块大小 / 出现次数 / 净浪费）');
  dup.sort((a, b) => b.len * (b.n - 1) - a.len * (a.n - 1)).slice(0, 10).forEach((x) => {
    console.log(`  ${x.kind.padEnd(22)} 单块${(x.len / 1024).toFixed(0).padStart(5)}KB ×${String(x.n).padStart(3)}  净浪费${((x.len * (x.n - 1)) / 1024).toFixed(0).padStart(5)}KB`);
  });
}

console.log('\n■ 最大 5 份报文');
perReq.sort((a, b) => b.kb - a.kb).slice(0, 5).forEach((r) => {
  console.log(`  ${r.f.slice(0, 26).padEnd(28)}${String(r.kb).padStart(5)}KB  消息 ${String(r.msgs).padStart(4)} 条  图片 ${String(r.imgKB).padStart(4)}KB`);
});

/* ── 被取代的旧工具流量：旧工具结果对当前轮还有多少意义 ────────────────────────
   判据（可判定，不是猜测）：把每个工具调用与它对应的工具结果按 tool_call_id 配对，
   抽出「主题」——read/write/edit 取文件路径，pwsh/bash 取命令前 80 字符。
   若同一主题出现在**不止一次**结果里，那么早先那几次已被后一次取代：
   模型手上真正有效的是最后一次。这部分是**可证明可压缩**的。
   反之只出现一次的工具结果是「当前唯一的一份」，删它就是真丢信息。 */
const sha12 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
/* ★ 配对键必须取**整条**参数，不能取前缀。
   踩过的坑：按「命令前 80 字符」当主题时，DSH 每条 PowerShell 命令都带同一段公共前缀
   （`[Console]::OutputEncoding = ...`），于是 20 条**不同**命令被误判成同一主题，
   把「被取代的字节」算得虚高。前缀只能当显示标签，不能当身份。 */
const subjectOf = (fn, argsJson) => {
  let a = {};
  try { a = JSON.parse(argsJson || '{}'); } catch { /* 参数不是合法 JSON：退化成整串哈希 */ }
  const p = a.file_path || a.path || a.notebook_path;
  if (p) return { k: `${fn}:${p}`, label: `${fn} ${p}` };
  const c = a.command || a.cmd || a.script;
  if (c) return { k: 'shell:' + sha12(c), label: 'shell ' + String(c).replace(/\s+/g, ' ').slice(0, 70) };
  return { k: `${fn}:` + sha12(argsJson), label: `${fn} ${String(argsJson || '').replace(/\s+/g, ' ').slice(0, 60)}` };
};

const callKey = new Map();               // tool_call_id -> {k,label}
const bySubject = new Map();             // 主题键 -> { label, lens: [] }
const labels = new Map();
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  let b = j.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { continue; } }
  if (!b || !Array.isArray(b.messages)) continue;
  for (const m of b.messages) {
    for (const tc of (m && m.tool_calls) || []) {
      if (tc && tc.id) {
        const s = subjectOf((tc.function || {}).name || '?', (tc.function || {}).arguments);
        callKey.set(tc.id, s);
        labels.set(s.k, s.label);
      }
    }
    if (m && m.role === 'tool') {
      const s = callKey.get(m.tool_call_id);
      if (!s) continue;
      const len = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
      if (!bySubject.has(s.k)) bySubject.set(s.k, []);
      bySubject.get(s.k).push(len);
    }
  }
}

const repeated = [...bySubject.entries()].filter(([, v]) => v.length > 1);
const supersededBytes = repeated.reduce((s, [, v]) => s + v.slice(0, -1).reduce((a, x) => a + x, 0), 0);
const uniqueOnly = [...bySubject.values()].filter((v) => v.length === 1).reduce((s, v) => s + v[0], 0);
console.log('\n■ 工具结果：被取代的部分 vs 只此一份的部分');
console.log(`  配对成功的工具结果          ${[...bySubject.values()].reduce((s, v) => s + v.length, 0)} 次，覆盖 ${bySubject.size} 个主题`);
console.log(`  同一主题被反复读取的主题数   ${repeated.length}`);
console.log(`  ★ 已被后续取代的字节        ${(supersededBytes / 1024).toFixed(0)} KB  ← 模型手上有效的是最后一次，这些是旧副本`);
console.log(`  ★ 只出现一次的字节          ${(uniqueOnly / 1024).toFixed(0)} KB  ← 删这些就是真丢信息`);
if (repeated.length) {
  console.log('\n  被读取次数最多的 8 个主题（主题 / 读取次数 / 已被取代的字节）');
  repeated.sort((a, b) => b[1].slice(0, -1).reduce((s, x) => s + x, 0) - a[1].slice(0, -1).reduce((s, x) => s + x, 0)).slice(0, 8)
    .forEach(([k, v]) => {
      const sup = v.slice(0, -1).reduce((a, x) => a + x, 0);
      console.log(`    ${String(labels.get(k) || k).slice(0, 58).padEnd(60)} ×${String(v.length).padStart(3)}  取代 ${(sup / 1024).toFixed(0).padStart(5)}KB`);
    });
}
console.log('');
