#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * hark-probe.js — hark.com 网页会话渠道的**活体探针**（仓库根，非 test/）
 *
 * 为什么需要它：hark 渠道的失败形态互相长得很像，光看控制台那句"渠道故障"分不清是哪一层：
 *   ① 凭据失效（cookie 过期/被登出）        → get-session 401/403
 *   ② 出口被 CF 拦（本机没配代理）           → 403 或 HTML 挑战页
 *   ③ 上游额度耗尽（harkTokens 日额度）      → send 402/429
 *   ④ 对话这条路本身坏了（建会话/发消息/收流）→ 探针的 --turn 才能看见
 * 所以它按层分开打，并且**默认只读**（不消耗 harkTokens）：只有显式加 `--turn` 才真发一条。
 *
 * 用法：
 *   node hark-probe.js                      # 找 config.json 里第一条 hark 渠道，只读体检
 *   node hark-probe.js <渠道id>             # 指定渠道
 *   node hark-probe.js <渠道id> --turn      # 额外真发一条（消耗少量额度）并验工具仿真
 *   node hark-probe.js --all                # 体检所有 hark 渠道（只读）
 *   ZZCSAPI_CONFIG=/path/config.json node hark-probe.js
 *
 * 纪律：**报告绝不回显凭据**（cookie 只出长度），也绝不打印 config.json 的其它字段值。
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const hark = require('./hark.js');

const args = process.argv.slice(2);
const wantTurn = args.includes('--turn');
const wantAll = args.includes('--all');
const wantId = args.find((a) => !a.startsWith('--'));

const CFG = process.env.ZZCSAPI_CONFIG || path.join(__dirname, 'config.json');
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); }
catch (e) { console.log('读不到配置（' + CFG + '）：' + (e && e.message)); process.exit(2); }

const chans = (cfg.channels || []).filter((c) => (c.protocol || 'openai') === 'hark');
const picked = wantId ? chans.filter((c) => c.id === wantId) : (wantAll ? chans : chans.slice(0, 1));
if (!picked.length) { console.log('配置里没有 hark 渠道' + (wantId ? `（id=${wantId}）` : '') + '。先在控制台加一条，或检查 --id 拼写。'); process.exit(2); }

const mask = (s) => {
  const t = String(s || '');
  return t.replace(/((?:token|key|secret|signature|cookie)[^=;\s]*=)([^;\s]+)/gi, '$1***');
};

(async () => {
  let bad = 0;
  for (const def of picked) {
    console.log('\n══ 渠道 ' + def.id + '（' + (def.name || '') + '） ══');
    console.log('  baseUrl      : ' + (def.baseUrl || hark.DEFAULT_BASE));
    console.log('  代理         : ' + (def.proxy || '（未配）') + (def.proxy ? '' : '   ← 本机直连会被 CF 403（Node/curl 不读系统代理）'));
    console.log('  凭据         : ' + (def.apiKey ? `已配置（长度 ${String(def.apiKey).length}，不回显）` : '**未配置**'));
    console.log('  模型别名     : ' + JSON.stringify(def.models || {}));

    // ① 凭据 + 出口（免费）
    const t0 = Date.now();
    const probe = await hark.harkProbe(def, 15000);
    console.log('\n  ① get-session : ' + (probe.ok ? `✓ 凭据有效（${Date.now() - t0}ms）` : `✗ ${mask(probe.error)}`));
    if (!probe.ok) { bad++; console.log('     → 到此为止：凭据/出口这一层没过，后面都不用测。'); continue; }

    // ② 会话清单（只读）——顺便看有没有残留的网关会话（成功即删，理论上不该有）
    const base = String(def.baseUrl || hark.DEFAULT_BASE).replace(/\/+$/, '');
    const list = await hark.harkCurl('GET', base + '/api/conversations', hark.harkHeaders(def), null, 15000, def.proxy);
    let convs = [];
    try { convs = JSON.parse(list.body).conversations || []; } catch {}
    const mine = convs.filter((c) => c.title === 'ZZCSAPI 网关通道');
    console.log('  ② 会话        : 共 ' + convs.length + ' 条，其中网关会话 ' + mine.length + ' 条' + (mine.length ? '（成功即删；残留说明有失败轮，可去 hark 里查证）' : ''));
    if (convs.length) console.log('     （只报数量与标题，不列 id/内容）');

    // ③ 额度（只读）：harkTokens 日/池额度（在 meters.harkTokens 里，不在顶层）
    const bill = await hark.harkCurl('GET', base + '/api/billing/summary', hark.harkHeaders(def), null, 15000, def.proxy);
    try {
      const b = JSON.parse(bill.body);
      const m = (b.meters && b.meters.harkTokens) || null;
      const plan = (b.plan && b.plan.id) || '?';
      if (m) {
        const pct = m.dailyLimit ? Math.round((m.dailyUsed / m.dailyLimit) * 100) : 0;
        console.log('  ③ 额度        : 计划 ' + plan + ' · harkTokens 日 ' + m.dailyUsed + '/' + m.dailyLimit + '（' + pct + '%）· 池 ' + m.poolUsed + '/' + m.poolLimit + ' · 日重置 ' + (m.dailyResetsAt || '?'));
        console.log('                 每轮实测约 11.5 万（含上游自己 agent 的开销，与提示长短几乎无关）→ 免费日额度约 69 轮，别拿它当主力渠道');
      } else {
        console.log('  ③ 额度        : 取到了 billing/summary 但没有 meters.harkTokens（上游改版？）');
      }
    } catch { console.log('  ③ 额度        : 取不到（HTTP ' + bill.status + '）'); }

    // ④ 真对话（只在 --turn 时；消耗额度）
    if (!wantTurn) { console.log('\n  （只读模式。加 --turn 才真发一条并验工具仿真）'); continue; }
    console.log('\n  ④ 真对话（--turn，消耗少量额度）');
    const conv = await hark.harkCreateConversation(def, 20000);
    if (!conv.ok) { bad++; console.log('     ✗ 建会话失败：' + mask(conv.error)); continue; }
    const sent = await hark.harkSend(def, conv.cid, '只回两个字：收到', 60000);
    if (!sent.ok) { bad++; console.log('     ✗ 发消息失败：' + mask(sent.error)); continue; }
    const rep = await hark.harkAwaitReply(def, conv.cid, sent.messageId, 90000, (n) => console.log('     · narration: ' + n));
    console.log('     ' + (rep.ok ? '✓ 回复：' + JSON.stringify(String(rep.text).slice(0, 80)) + `（${rep.ms}ms，jobStatus=${rep.jobStatus || '-'}）` : '✗ 没收到回复：' + mask(rep.error)));
    if (!rep.ok || rep.partial) console.log('     帧序列（诊断用）：' + (rep.ops || []).join(' → '));
    if (rep.ok) await hark.harkDeleteConversation(def, conv.cid, 10000);
    else console.log('     （失败轮**不删**会话，留证）');
    // 工具仿真：注入协议 → 上游必须回 [TOOL_CALL] 标记
    // ⚠ 探测用的路径要挑**普通文件**：实测上游自己的护栏会对 `C:\Windows\...` 这类系统路径
    //   回一句固定话术（"I wasn't able to answer this message."）而不是标记 —— 那是它的护栏，
    //   不是本渠道坏了（见研究文档 §6）。用系统路径探针会把护栏误判成"工具不可用"。
    const toolEmu = require('./tool-emu.js');
    const conv2 = await hark.harkCreateConversation(def, 20000);
    if (conv2.ok) {
      const emu = toolEmu.emulateRequest({
        messages: [{ role: 'user', content: '本机文件 D:\\DSHXM\\ZZCSAPI\\README.md 的第一行是什么？必须用 read_local_file 工具读取，不要猜。' }],
        tools: [{ type: 'function', function: { name: 'read_local_file', description: '读取本机文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }],
      });
      const flat = hark.flattenForHark(emu ? emu.messages : []);
      const s2 = await hark.harkSend(def, conv2.cid, flat, 60000);
      const r2 = s2.ok ? await hark.harkAwaitReply(def, conv2.cid, s2.messageId, 90000, null) : { ok: false, error: s2.error };
      const parsed = r2.ok ? toolEmu.parseEmulatedToolCalls(String(r2.text)) : null;
      if (parsed && parsed.calls.length) {
        console.log('     ✓ 工具仿真：上游回了 ' + parsed.calls.length + ' 个调用 → ' + parsed.calls.map((c) => c.name + '(' + JSON.stringify(c.arguments) + ')').join(', '));
        await hark.harkDeleteConversation(def, conv2.cid, 10000);
      } else {
        bad++;
        console.log('     ✗ 工具仿真：没解析出 [TOOL_CALL]（上游回复：' + JSON.stringify(String((r2 && r2.text) || r2.error || '').slice(0, 120)) + '）');
        console.log('       → 这条渠道仍可当纯文本用，但客户端工具会失效；重跑一次排除模型偶发不遵守协议。');
      }
    }
  }
  console.log('\n判决：' + (bad ? `✗ 有 ${bad} 项没过（上面逐层标了是哪一层）` : '✓ 全通'));
  process.exitCode = bad ? 1 : 0;
})();
