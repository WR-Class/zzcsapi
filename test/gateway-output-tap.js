/* 网关遗言捕手（v1.18.75）—— 由 `_run_all_tests.js` 用
   `NODE_OPTIONS="--require <本文件>"` + `ZZ_GW_TAP_DIR=<目录>` 注入到每个 node 子进程里。

   存在的理由：临时网关在 57 个用例里被 spawn（其中 **41 个** 用 `stdio:'ignore'`），
   输出直接进黑洞。它一旦没起来（端口被抢、配置非法、模块加载失败），用例只能报
   「网关未启动」这种**不带原因**的红字，而真因已经丢掉了 —— v1.18.67/68 那两轮
   "偶发红字、单跑又全绿、查不出为什么"就是同一个窟窿。
   本模块在**网关进程内部**把 stdout/stderr 旁路一份到 `ZZ_GW_TAP_DIR/gw-<pid>.log`，
   运行器在该用例失败时把可疑的那些原样打出来（见 `_run_all_tests.js` 的失败分支）。

   三条纪律，破坏任一条都可能反过来污染被测行为：
   ① **绝不改变被测进程**：任何异常一律吞掉；写不进去就静默降级成"不捕获"。
   ② 只对 `server.js` 生效——用例进程自己也被注入，但直接 no-op。
   ③ 有大小上限（256 KB）：正常网关只打 5 行，异常时也不会把盘写满。 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.ZZ_GW_TAP_DIR;
const entry = String(process.argv[1] || '').replace(/\\/g, '/').toLowerCase();
const CAP = 256 * 1024;

if (DIR && entry.endsWith('/server.js')) {
  let fd = null;
  let written = 0;
  try { fd = fs.openSync(path.join(DIR, 'gw-' + process.pid + '.log'), 'a'); } catch { }
  if (fd !== null) {
    try {
      const cfg = String(process.env.ZZCSAPI_CONFIG || '');
      let port = '?';
      try { port = String(JSON.parse(fs.readFileSync(cfg, 'utf8')).port); } catch { }
      const head = '===== 网关 pid=' + process.pid + ' port=' + port + ' cfg=' + path.basename(cfg) + ' =====\n';
      fs.writeSync(fd, head);
      written += head.length;
    } catch { }
    const tap = (orig, tag) => function (chunk, enc, cb) {
      try {
        if (written < CAP) {
          const s = '[' + tag + '] ' + String(chunk);
          fs.writeSync(fd, s);
          written += s.length;
        }
      } catch { }
      return orig.call(this, chunk, enc, cb);
    };
    const origOut = process.stdout.write;
    const origErr = process.stderr.write;
    try {
      process.stdout.write = tap(origOut, 'out');
      process.stderr.write = tap(origErr, 'err');
    } catch { }

    /* ⚠️ 光包 write **抓不到崩溃栈**：Node 打印未捕获异常的栈走的是 `_rawDebug`，
       不经过 `process.stderr.write`（实测：撞端口时只捞到 [firstbyte] 一行，
       真正的 EADDRINUSE 一个字没有 —— 而它才是真因）。所以这里自己接管一次：
       把错误与栈写进遗言，**同时按原样重发到真正的 stderr**（有 5 个用例把网关
       stdio 设成了 pipe 并收集 lines，别把它们的既有诊断弄丢），再按 Node 的默认
       语义以 1 退出。仅在本模块被注入时生效，正常跑网关没有这个分支。 */
    const record = (tag, e) => {
      try {
        if (written < CAP) {
          const s = '[' + tag + '] ' + (e && e.stack ? e.stack : String(e)) + '\n';
          fs.writeSync(fd, s);
          written += s.length;
        }
      } catch { }
    };
    const die = (tag) => (e) => {
      record(tag, e);
      try { origErr.call(process.stderr, (e && e.stack ? e.stack : String(e)) + '\n'); } catch { }
      try { process.exit(1); } catch { }
    };
    try {
      process.on('uncaughtException', die('uncaught'));
      process.on('unhandledRejection', die('rejection'));
    } catch { }
  }
}
