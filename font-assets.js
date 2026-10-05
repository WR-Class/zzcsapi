// ZZCSAPI · 自托管字体资产（v1.18.37）
//
// 为什么有这个东西：全站字体从「小米 MiSans 官方 CDN」换成「寒蝉全圆体（OFL-1.1）自托管分片」。
// 换的不只是字体——N-04「CSP 引外部字体 CDN（供应链/隐私面）」这条渗透测试发现就此关掉：
// 控制台的字体不再向任何第三方域名发起请求，`font-src 'self'` 名副其实。
//
// 三个设计点：
//   ① **白名单查表，不做路径拼接**：启动时把 assets/fonts/chillround/ 扫成一个 Map，
//      请求路径只做一次 Map.get()。静态文件服务最容易出事的 `..` 穿越面因此**不存在**
//      （不是"过滤了 .."，而是根本没有把用户输入拼进文件路径的机会）。扩展名也走白名单，
//      目录里将来多出任何中间产物（.br/.gz/.map…）都不会被意外发出去。
//   ② **分片长缓存、入口 CSS 短缓存**：分片文件名是内容哈希（换字体就换名），可以 immutable；
//      入口 CSS 名字固定，只能短缓存，否则换字体后新旧混用会 404。
//   ③ **惰性压缩**：入口 CSS 有 26 万字符（266 条 @font-face 的 unicode-range 列表），
//      brotli q9 后 49.9 KB / gzip 75.2 KB。压一次约 48ms，放在**首次请求**时做并缓存，
//      网关启动与测试起实例都不必付这笔钱。woff2 分片本身已是 Brotli，绝不二次压缩。
//
// 许可证：本目录字体为寒蝉全圆体 ChillRoundF v3.200 的**子集化改名版**（SIL OFL 1.1）。
// 依 OFL 保留字体名条款，子集化属修改版、不得沿用上游保留名，故改名为 HCRound（见 build/fonts.js）。
// LICENSE.txt 随字体一并分发（OFL 条件 2 要求），本模块也把它列为可公开获取的文件。

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FONT_DIR = path.join(__dirname, 'assets', 'fonts', 'chillround');
const URL_PREFIX = '/console/fonts/';
const MIME = {
  '.woff2': 'font/woff2',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.css', '.txt']);

const FILES = (() => {
  const map = new Map();
  const walk = (dir, prefix) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;                                   // 字体目录缺失不该拦住网关启动（绿场/裁剪部署）
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), prefix + e.name + '/');
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      const type = MIME[ext];
      if (!type) continue;                      // 扩展名白名单
      map.set(URL_PREFIX + prefix + e.name, {
        abs: path.join(dir, e.name),
        type,
        compressible: COMPRESSIBLE.has(ext),
        cache: ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
        z: {},                                    // 惰性压缩缓存：{ br|gzip: Buffer }
      });
    }
  };
  walk(FONT_DIR, '');
  return map;
})();

function encoded(entry, acceptEncoding) {
  if (!entry.compressible) return { buf: fs.readFileSync(entry.abs), enc: null };  // 分片本身即 Brotli：原样发，不二次压缩
  const ae = String(acceptEncoding || '');
  const enc = /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
  if (!enc) return { buf: fs.readFileSync(entry.abs), enc: null };
  if (!entry.z[enc]) {
    const raw = fs.readFileSync(entry.abs);
    entry.z[enc] = enc === 'br'
      ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } })
      : zlib.gzipSync(raw, { level: 9 });
  }
  return { buf: entry.z[enc], enc };
}

/* 命中返回 true（已由本模块响应），未命中返回 false（交给后面的路由分支）。 */
function serveFont(req, res, pathname) {
  const entry = FILES.get(pathname);
  if (!entry) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return true;
  }
  const headers = { 'Content-Type': entry.type, 'Cache-Control': entry.cache };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end(), true;
  }
  const { buf, enc } = encoded(entry, req.headers['accept-encoding']);
  if (enc) {
    headers['Content-Encoding'] = enc;
    headers['Vary'] = 'Accept-Encoding';
  }
  res.writeHead(200, headers);
  res.end(buf);
  return true;
}

module.exports = { serveFont, FILES, FONT_DIR, URL_PREFIX };
