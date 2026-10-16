/* 全量回归：逐个跑 test/*.test.js，汇总文件数与断言数。零依赖。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const DIR = path.join(__dirname, 'test');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.test.js')).sort();
let filesOk = 0, filesBad = 0, asserts = 0;
const bad = [];
/* v1.18.67：两个诊断盲区，都是"红了却查不出为什么"的成因。
   ① **必须显式设 `maxBuffer`**：`spawnSync` 默认只有 1MB，子进程输出超了会用 `ENOBUFS`
      把它杀掉、`stdout` 直接空掉 —— 现象与"用例自己崩了"一模一样（都表现为
      `0 通过 / 0 失败`），而真因在签名里、不在用例里。（实测过有 e2e 在全量负载下
      多打日志就撞这个，于是报成"整份崩了、断言数凭空少掉几十项"。）
   ② **失败时把输出尾巴打出来**：原来失败只打一行汇总，`r.stdout` 直接丢掉，
      于是每次抖动都无法定性，只能靠重跑猜。现在打最后 25 行（顺带暴露 `r.error`，
      超时 / ENOBUFS / 起不来都在那里，而它们全都不在用例的 stdout 里）。 */
const MAXBUF = 64 * 1024 * 1024;
const TAP = path.join(__dirname, 'test', 'gateway-output-tap.js');
let seq = 0;
for (const f of files) {
  /* v1.18.75：每个用例给一个干净的"网关遗言"目录。用例里的临时网关 41/57 是
     `stdio:'ignore'`，它没起来时真因会被丢掉、只剩一句「网关未启动」。注入一个 tap
     把网关**自己**的 stdout/stderr 旁路到这里，失败时原样打出来（见下面的失败分支）。
     ⚠️ tap 只对 server.js 生效且任何异常都吞掉；`--require` 的路径不能含空格。 */
  const tapDir = path.join(os.tmpdir(), 'zzgw-' + process.pid + '-' + (++seq));
  try { fs.rmSync(tapDir, { recursive: true, force: true }); fs.mkdirSync(tapDir, { recursive: true }); } catch { }
  const env = Object.assign({}, process.env, {
    ZZ_GW_TAP_DIR: tapDir,
    NODE_OPTIONS: (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : '') + '--require ' + TAP,
  });
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { encoding: 'utf8', timeout: 600000, windowsHide: true, maxBuffer: MAXBUF, env });
  const out = (r.stdout || '') + (r.stderr || '');
  // 各用例的收尾格式不统一，按常见几种依次尝试
  // v1.18.55：补一条 `通过 N · 失败 M`（中点分隔，hark-channel.test.js 的收尾格式）——
  //   此前它一条正则都不命中，被记成「?? 收尾格式没认出来」且**断言数按 0 计入合计**，
  //   于是 README/docs 里的总数少算了整整一个文件（97 项），却看不出哪里漏了。
  let n = 0, bad2 = 0, matched = false;
  let m = out.match(/通过\s*(\d+)\s*·\s*失败\s*(\d+)/);
  if (m) { n = Number(m[1]); bad2 = Number(m[2]); matched = true; }
  if (!matched) { m = out.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/); if (m) { n = Number(m[1]); bad2 = Number(m[2]); matched = true; } }
  if (!matched) { m = out.match(/[（(](\d+)\s*项，通过\s*(\d+)，失败\s*(\d+)[）)]/); if (m) { n = Number(m[2]); bad2 = Number(m[3]); matched = true; } }
  if (!matched) { m = out.match(/全部通过[（(](\d+)\s*项/); if (m) { n = Number(m[1]); matched = true; } }
  if (!matched) { m = out.match(/(\d+)\/(\d+)\s*通过/); if (m) { n = Number(m[1]); bad2 = Number(m[2]); matched = true; } }
  if (!matched) { m = out.match(/(\d+)\s*项断言/); if (m) { n = Number(m[1]); matched = true; } }
  if (!matched) { console.log('  ??   ' + f + ' —— 收尾格式没认出来，请人工看'); }
  asserts += n;
  if (r.status === 0 && bad2 === 0) { filesOk++; console.log('  ok   ' + f.padEnd(52) + n + ' 项'); }
  else {
    filesBad++; bad.push(f);
    console.log('  FAIL ' + f.padEnd(52) + n + ' 通过 / ' + bad2 + ' 失败 (exit ' + r.status + ')');
    /* v1.18.75：**先打网关遗言**。真因常常在网关自己的输出里——端口被抢是 EADDRINUSE、
       配置非法是 ERR_SOCKET_BAD_PORT、文件没进镜像/没 require 到是 MODULE_NOT_FOUND——
       而 41/57 个用例把它的 stdio 设成了 'ignore'，不打出来就只能看到「网关未启动」
       这种**不带原因**的红字（v1.18.67/68 那两轮偶发红字查不出为什么，就是栽在这里）。
       只打"可疑的"：带启动类错误、或压根没打出 `listening` 的那些。 */
    try {
      const taps = fs.readdirSync(tapDir).filter((x) => x.startsWith('gw-'));
      const odd = [];
      for (const t of taps) {
        let txt = '';
        try { txt = fs.readFileSync(path.join(tapDir, t), 'utf8'); } catch { }
        if (/EADDRINUSE|ERR_SOCKET_BAD_PORT|EACCES|EADDRNOTAVAIL|MODULE_NOT_FOUND|Error:/.test(txt) || !/listening on/.test(txt)) odd.push({ t, txt });
      }
      if (odd.length) {
        console.log('        ↓ 网关遗言：' + taps.length + ' 个网关里有 ' + odd.length + ' 个没正常起来 / 带错误（其余正常）');
        for (const o of odd) {
          console.log('        --- ' + o.t);
          o.txt.split('\n').filter((l) => l.trim()).slice(-20).forEach((l) => console.log('        |   ' + l.slice(0, 160)));
        }
      }
    } catch { }
    /* 失败时给出可定性的证据：spawnSync 自身的 error（超时/ENOBUFS 都在这里，
       不在子进程 stdout 里）+ 输出尾巴。没有这一段，抖动只能靠重跑猜。 */
    if (!matched && r.status !== 0) {
      /* 没有可解析的收尾行 + 非零退出 = **文件崩了**，不是"断言失败"。这两者必须分开说：
         前者意味着断言数凭空少掉一整个文件，而红字却长得像用例坏了（v1.18.67 定性）。 */
      console.log('        ↑ 该文件崩了（没有可解析的收尾行），断言数按 0 计入 —— 这不是断言失败，去读下面的输出尾巴');
    }
    if (r.error) console.log('        spawnSync error: ' + (r.error.code || '') + ' ' + String(r.error.message || '').slice(0, 160));
    const tail = out.split('\n').filter((l) => l.trim()).slice(-25);
    tail.forEach((l) => console.log('        | ' + l.slice(0, 160)));
  }
  try { fs.rmSync(tapDir, { recursive: true, force: true }); } catch { }
}
console.log('\n合计: ' + files.length + ' 个文件 · ' + filesOk + ' 通过 / ' + filesBad + ' 失败 · ' + asserts + ' 项断言');
if (bad.length) console.log('失败文件: ' + bad.join(', '));
process.exitCode = filesBad ? 1 : 0;
