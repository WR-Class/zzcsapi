#!/usr/bin/env node
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * codebuff-probe.js  ─  Codebuff/Freebuff 渠道的活体探针（v1.18.58，默认只读，可选真聊）
 *
 * 存在的理由（与 hark-probe.js 同款动机）：codebuff 失败形态互相长得很像——token 过期 / 凭据
 * 失效 / 账号没 credits / 模型名错——光看控制台那句"渠道故障"分不清是哪一层。所以**按层分开打**：
 *   ① agent-runs：建 run 拿 runId（凭据有效 / 401=凭据失效或没额度 / 网络问题）
 *   ② chat/completions：带 codebuff_metadata.run_id 真聊一发（默认 ping，max_tokens=8）
 *      · 200 = 协议通了，正常拿到回复
 *      · 402 = 账号 Out of credits（提示去 codebuff.com/usage 充值）
 *      · 400/4xx = 模型名 / 报文形状错（按错误文案定位）
 *      · 401/403 = 凭据失效
 *   ③ 列模型建议（探测分支给的默认值 codebuff/base@latest）—— 上游没有 /v1/models 端点，
 *      autoAlias 也会 404，别名只能手配。
 *
 * 用法：
 *   node codebuff-probe.js                          # 探默认 codebuff 渠道（按需真聊 1 发）
 *   node codebuff-probe.js <渠道id>                 # 探指定渠道
 *   node codebuff-probe.js --no-chat                # 只验 agent-runs，不真聊
 *   node codebuff-probe.js --chat-only              # 跳过 agent-runs 检查、直接真聊
 *   node codebuff-probe.js --proxy http://127.0.0.1:7897
 *
 * 报告绝不回显凭据：apiKey 只出长度，错误文案过 mask。
 * 改 codebuff 出站报文或怀疑"渠道不通"时先跑它，别先改报文形状。
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
'use strict';
const http = require('http');

function mask(s) {
  if (s == null) return s;
  if (typeof s === 'object') {
    if (Array.isArray(s)) return s.map(mask);
    const o = {};
    for (const k of Object.keys(s)) o[k] = /key|token|signature|secret|password/i.test(k) ? (typeof s[k] === 'string' ? `<${s[k].length}ch masked>` : mask(s[k])) : mask(s[k]);
    return o;
  }
  return s;
}
function readJsonFile(p) {
  try { return JSON.parse(require('fs').readFileSync(p, 'utf8')); } catch { return null; }
}
function pickChannel(arg) {
  const cfg = readJsonFile('config.json');
  if (!cfg) throw new Error('找不到 config.json（请在仓库根目录运行本脚本）');
  const all = cfg.channels || [];
  if (arg) {
    const c = all.find((x) => x.id === arg);
    if (!c) throw new Error(`config.json 里没有渠道 id=${arg}`);
    return c;
  }
  const c = all.find((x) => x.protocol === 'codebuff') || all.find((x) => /codebuff|freebuff/i.test(x.id));
  if (!c) throw new Error('config.json 里没有 codebuff 渠道（请先在管理面添加，protocol=codebuff）');
  return c;
}
function adminReq(path, key) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 8787, path, headers: { Authorization: `Bearer ${key}` }, timeout: 10000 }, (r) => {
      const chunks = []; r.on('data', (c) => chunks.push(c));
      r.on('end', () => { try { resolve({ status: r.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (e) { resolve({ status: r.statusCode, body: { raw: Buffer.concat(chunks).toString('utf8') } }); } });
    }).on('error', reject);
  });
}
function upstreamReq(method, baseUrl, body, proxyArg, apiKey) {
  // 出网走 curl（与 workbuddy/codex 探测同款；本机 127.0.0.1 不需代理，容器内可能需要）。
  // ⚠️ apiKey 必传：本脚本第一版漏了 Authorization 头 → 上游回 401 "Missing or invalid
  //    Authorization header"，极易被误读成"凭据过期"（真因是探针自己没带钥匙）。
  const { spawn } = require('child_process');
  const args = ['-sS', '-N', '-X', method, '--max-time', '25', '-w', '\\n__ZZ__%{http_code}'];
  if (proxyArg) args.push('-x', proxyArg);
  args.push('-H', 'Content-Type: application/json');
  if (apiKey) args.push('-H', 'Authorization: Bearer ' + apiKey);
  if (body) {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const tmp = path.join(os.tmpdir(), `zz-cb-probe-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
    args.push('--data', '@' + tmp);
  }
  args.push(baseUrl);
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = ''; let err = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    child.on('close', (code) => {
      const m = out.match(/__ZZ__(\d+)\s*$/);
      const status = m ? Number(m[1]) : 0;
      const bodyStr = m ? out.slice(0, out.lastIndexOf('__ZZ__')).replace(/\n$/, '') : out;
      resolve({ status, body: bodyStr, error: code !== 0 && !bodyStr ? `curl exit ${code}: ${err.slice(0, 200)}` : null });
    });
  });
}
async function main() {
  const args = process.argv.slice(2);
  const chatOnly = args.includes('--chat-only');
  const noChat = args.includes('--no-chat');
  const proxyIdx = args.indexOf('--proxy'); const proxyArg = proxyIdx >= 0 ? args[proxyIdx + 1] : null;
  const channelArg = args.find((a) => !a.startsWith('--') && a !== proxyArg);

  const ch = pickChannel(channelArg);
  console.log(`\ncodebuff 探针 · 渠道 ${ch.id}  (name="${ch.name}", proto=${ch.protocol})`);
  console.log(`  baseUrl: ${ch.baseUrl}`);
  console.log(`  apiKey 长度: ${(ch.apiKey || '').length}`);
  if (!ch.apiKey) throw new Error('渠道 apiKey 为空');
  if (!ch.baseUrl) throw new Error('渠道 baseUrl 为空');

  const baseUrl = ch.baseUrl.replace(/\/+$/, '');
  const apiKey = ch.apiKey;
  const models = Object.entries(ch.models || {});
  console.log(`  aliases: ${models.length ? models.map(([k, v]) => `${k}→${v}`).join('; ') : '（无 → 探测会给默认建议）'}`);

  // ① agent-runs
  let runId;
  if (!chatOnly) {
    console.log('\n[1/2] agent-runs  →  验凭据 + 拿 runId');
    const r = await upstreamReq('POST', `${baseUrl}/agent-runs`,
      { action: 'START', agentId: 'base', ancestorRunIds: [] }, proxyArg, apiKey);
    if (r.error) { console.log('  ✗ 网络层失败：' + r.error); }
    else if (r.status === 401 || r.status === 403) { console.log(`  ✗ HTTP ${r.status}：凭据失效或被拒（去 codebuff.com 重新登录 Freebuff、复制新 token 填回渠道）`); console.log('  body 摘要:', mask(JSON.parse(r.body || '{}'))); }
    else if (r.status === 200) {
      try { runId = JSON.parse(r.body).runId; } catch { }
      if (runId) console.log(`  ✓ HTTP 200  runId 长度=${runId.length}（协议层通了）`);
      else { console.log('  ✗ HTTP 200 但响应里没有 runId：', mask(r.body.slice(0, 200))); }
    }
    else { console.log(`  ✗ HTTP ${r.status}`); console.log('  body 摘要:', mask(r.body.slice(0, 200))); }
  }

  // ② chat/completions
  if (!noChat) {
    console.log('\n[2/2] chat/completions  →  验协议 + 探额度');
    if (!runId) {
      const r0 = await upstreamReq('POST', `${baseUrl}/agent-runs`,
        { action: 'START', agentId: 'base', ancestorRunIds: [] }, proxyArg, apiKey);
      try { runId = JSON.parse(r0.body || '{}').runId; } catch { }
    }
    if (!runId) { console.log('  跳过（拿不到 runId）'); }
    else {
      const model = (models[0] && models[0][1]) || 'codebuff/base@latest';
      const clientId = `zz-probe-${Date.now().toString(36)}`;
      const r = await upstreamReq('POST', `${baseUrl}/chat/completions`, {
        model, max_tokens: 8, stream: false,
        messages: [{ role: 'user', content: 'ping' }],
        codebuff_metadata: { run_id: runId, client_id: clientId },
      }, proxyArg, apiKey);
      if (r.error) { console.log('  ✗ 网络层失败：' + r.error); }
      else if (r.status === 200) {
        // 抓首段 delta.content
        let reply = '';
        for (const ln of r.body.split('\n')) {
          const s = ln.trim(); if (!s.startsWith('data:')) continue;
          const d = s.slice(5).trim(); if (d === '[DONE]') continue;
          try { const j = JSON.parse(d); reply += (j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || ''); } catch { }
        }
        if (reply.trim()) console.log(`  ✓ HTTP 200  reply="${reply.replace(/\n/g, '\\n').slice(0, 80)}"  协议 + 额度都通了`);
        else console.log('  ✓ HTTP 200  但 reply 为空（上游可能回 0 字节的 delta，看 usage 帧）');
      }
      else if (r.status === 402) { console.log('  ✗ HTTP 402 Out of credits：账号没 API 额度——去 https://www.codebuff.com/usage 充值（Freebuff 客户端内 15h/天的 freebucks 是另一条路径，裸调 API 不会自动用）'); }
      else if (r.status === 400) { console.log('  ✗ HTTP 400：报文形状/模型名被拒，按错误文案定位（model 是否要换成 SDK 里实际用的 openrouter_claude_sonnet_4_5 形式）'); console.log('  body 摘要:', mask(r.body.slice(0, 200))); }
      else if (r.status === 401 || r.status === 403) { console.log(`  ✗ HTTP ${r.status}：凭据失效`); }
      else { console.log(`  ✗ HTTP ${r.status}`); console.log('  body 摘要:', mask(r.body.slice(0, 200))); }
    }
  }

  // ③ 模型建议
  console.log('\n[3/3] 模型建议（上游无 /v1/models 端点、autoAlias 也不通，只能手配）');
  if (models.length) {
    console.log('  当前别名：');
    for (const [k, v] of models) console.log(`    ${k} → ${v}`);
  } else {
    console.log('  别名表空——探测分支会建议加：{ "codebuff-base": "codebuff/base@latest" }');
  }
  console.log('  SDK 里模型名形如 `codebuff/<agent>@<version>`，实际生效 model 字段是 OpenRouter 风格');
  console.log('  字符串（如 anthropic/claude-sonnet-4.5），真聊时若 400 看错误文案换名即可。');

  console.log('\n=== 探针结束 ===\n');
}
main().catch((e) => { console.error('探针异常：' + (e && e.message || e)); process.exit(1); });
