#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/docker-image-files.test.js — 镜像清单守卫（v1.18.48，零依赖）
 *
 * 现场（2026-10-08，v1.18.47 上线当场）：`Dockerfile` 是**显式 COPY 白名单**，加了 hark.js
 * 却没加 `COPY hark.js ./` → `docker compose build && up -d` 之后容器**启动即 crash-loop**：
 *     Error: Cannot find module '/app/hark.js'   requireStack: [ '/app/server.js' ]
 * 而**本机 `node server.js` 一切正常**——工作目录里那个文件在，require 当然找得到。
 * 这就是这类漏项最坏的形态：本机/测试全绿，只有真部署会炸；而且它炸在**启动**，
 * 不是某个功能，症状（容器反复重启、healthz 连不上）离原因（少一行 COPY）很远。
 *
 * 判据两条，都要机械核对（本测试就是那次事故的守卫）：
 *   ① **正向**：从镜像入口 `server.js` 出发跟**本地 require 传递闭包**，每一个被 require 的文件
 *      都必须在 Dockerfile 里被 COPY 进去（漏一个 = 镜像里 require 不到）。
 *   ② **反向**：Dockerfile 每一条 `COPY *.js` 的源文件都必须真实存在（删了文件忘删行同样会烂）。
 * 另加 §4「镜像必备件」（console.html / config.example.json → ./config.json / assets/fonts）
 * 与 §5 **阴性对照**：把清单退回"没有 hark.js"的旧文本，守卫必须报出来
 * （否则这条守卫只是"刚好现在通过"，拦不住回潮）。
 *
 * 跑法：node test/docker-image-files.test.js   （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
};

// ─────────────────────────── 清单解析 ───────────────────────────
function parseCopies(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();          // 行尾注释不算
    const m = line.match(/^COPY\s+(\S+)(?:\s+(\S+))?\s*$/);  // 只认简单形态（单源 + 可选目标）
    if (m) out.push({ src: m[1], dest: m[2] || '' });
  }
  return out;
}

// 把 `require('./x')` 解析成镜像里的相对路径（按 Node 的解析顺序试后缀）
function resolveLocal(fromFile, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  for (const cand of [base, base + '.js', base + '.json', path.posix.join(base, 'index.js')]) {
    if (fs.existsSync(path.join(ROOT, cand))) return cand;
  }
  return null;
}

// 从入口出发的本地 require 传递闭包
function localRequireClosure(entry, maxFiles = 40) {
  const seen = new Set(), unresolvable = [], queue = [entry];
  while (queue.length && seen.size < maxFiles) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try { src = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const target = resolveLocal(file, m[1]);
      if (!target) { unresolvable.push({ from: file, spec: m[1] }); continue; }
      if (target.endsWith('.js') && !seen.has(target)) queue.push(target);
    }
  }
  return { files: [...seen], unresolvable };
}

function analyze(text) {
  const copies = parseCopies(text);
  const srcs = copies.map((c) => c.src);
  const copied = (rel) => srcs.some((s) => s === rel || (s.endsWith('/') ? rel.startsWith(s) : rel.startsWith(s + '/')));
  const { files, unresolvable } = localRequireClosure('server.js');
  const required = files.filter((f) => f !== 'server.js');
  return { copies, srcs, copied, required, unresolvable };
}

console.log('══ §1 正向：server.js 的本地 require 传递闭包必须在镜像里 ══');
const A = analyze(DOCKERFILE);
console.log('   闭包：', A.required.join(' → '), '· Dockerfile COPY 源：', A.srcs.join(' '));
check('本地 require 全部能在镜像里解析到（本机找不到的 require 也算问题）', A.unresolvable.length === 0, A.unresolvable);
check('闭包非空（至少覆盖 notion / notion-agent / hark / tool-emu / font-assets 这 5 个）', A.required.length >= 5, A.required);
const missing = A.required.filter((f) => !A.copied(f));
check('★ 每一个被 require 的本机文件都在 Dockerfile 的 COPY 清单里（漏一个 = 容器启动 crash-loop）', missing.length === 0, missing);
for (const f of A.required) check(`  COPY 清单含 ${f}`, A.copied(f));

console.log('\n══ §2 反向：COPY 的源文件必须真实存在 ══');
const jsCopies = A.copies.filter((c) => c.src.endsWith('.js'));
const gone = jsCopies.filter((c) => !fs.existsSync(path.join(ROOT, c.src)));
check('每条 COPY *.js 的源文件都在仓库里（删文件忘删行也会在这里露）', gone.length === 0, gone.map((c) => c.src));
check('确实解析到了 COPY 行（解析器没写空）', A.copies.length >= 5, A.copies.length);

console.log('\n══ §3 镜像入口与自检 ══');
check('入口是 server.js（CMD ["node","server.js"]）', /CMD\s*\[\s*"node"\s*,\s*"server\.js"\s*\]/.test(DOCKERFILE));
check('健康检查指向 /healthz（容器 healthy 才有意义）', /HEALTHCHECK[\s\S]*?\/healthz/.test(DOCKERFILE));

console.log('\n══ §4 镜像必备件（不是 require，但缺了就是功能静默降级）══');
check('COPY console.html（控制台静态壳；缺了控制台 404）', A.copied('console.html'));
check('COPY assets/fonts（自托管字体分片；缺了页面不报错，只是字变了 —— v1.18.37 现场）', A.copied('assets/fonts'));
const cfgCopy = A.copies.find((c) => c.src === 'config.example.json');
check('COPY config.example.json → ./config.json（首启配置模板）', !!cfgCopy && cfgCopy.dest === './config.json', cfgCopy);

console.log('\n══ §5 阴性对照：把清单退回 v1.18.47 事故当时的文本，守卫必须报出来 ══');
const before = DOCKERFILE.replace(/^# hark 网页会话渠道[\s\S]*?^COPY hark\.js \.\/\n/m, '');
check('对照文本确实少了 hark.js（否则这组对照是假的）', !analyze(before).copied('hark.js'));
const beforeMissing = analyze(before).required.filter((f) => !analyze(before).copied(f));
check('★ 对照文本下守卫报出 hark.js 缺失（＝这条守卫真能抓住那次事故）', beforeMissing.includes('hark.js'), beforeMissing);
check('对照文本下真实的 Dockerfile 仍然通过（说明只是清单少行，不是守卫过严）', missing.length === 0);

console.log(`\n══════ 通过 ${pass} · 失败 ${fail} ══════`);
process.exit(fail ? 1 : 0);
