// 构建脚本：把设计稿骨架 + 生产适配层组装成仓库根目录的 console.html
//
//   node build/build.js
//
// 视觉唯一真源 = console-redesign.html 的 <style> 原文，逐字节复制，不重写、不改写；
// 生产独有组件补在 build/extra.css，全部复用设计令牌。改视觉请先改设计稿。
//
// 产物 console.html 是提交进仓库的，server.js 直接读它；改完必须重新构建。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const design = R('console-redesign.html');
const cssStart = design.indexOf('<style>') + '<style>'.length;
const cssEnd = design.indexOf('</style>');
if (cssStart < 7 || cssEnd < 0) throw new Error('设计稿 <style> 未找到');
const designCss = design.slice(cssStart, cssEnd);

const head = R('build/head.html');     // 到 <style> 为止
const shell = R('build/shell.html');   // body 骨架
const app = R('build/app.js');         // 数据层 + 动作层 + 渲染
const extra = R('build/extra.css');

// ⚠ 这段注释里绝对不能出现结束标签的字面量：HTML 解析 <style> 是裸文本模式，
// 一遇到结束标签（即使在 CSS 注释里）就立刻闭合元素，后面的 CSS 会整段变成正文文本。
const BANNER = '/* ── 以下为设计稿 console-redesign.html 的 style 原文，逐字节复制，勿手改 ── */\n';

const out =
  head + '\n' +
  BANNER +
  designCss.replace(/^\s*\n/, '') +
  '\n\n' + extra + '\n' +
  '</style>\n</head>\n<body>\n' +
  shell + '\n' +
  '<script>\n' + app + '\n</script>\n' +
  '</body>\n</html>\n';

// 构建期自检：产物里结束标签只能出现一次。
// 注意 <style> 出现在 HTML 注释里是无害的（注释以 --> 结束），所以只查结束标签。
const nEnd = out.split('</style>').length - 1;
if (nEnd !== 1) throw new Error('产物中 </style> 出现 ' + nEnd + ' 次，应为 1 次（多半是 CSS 注释里混入了结束标签字面量，会让 <style> 提前闭合）');

fs.writeFileSync(path.join(ROOT, 'console.html'), out, 'utf8');
console.log('console.html 已生成 · ' + out.length + ' 字符（设计 CSS ' + designCss.length + ' · 补充 CSS ' + extra.length + ' · JS ' + app.length + '）');
