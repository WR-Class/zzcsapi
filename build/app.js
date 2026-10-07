
/* ═══════════════════════════ 图标 ═══════════════════════════ */
const IC = {
  gauge:'<path d="M12 14 18 8"/><circle cx="12" cy="14" r="8"/><path d="M12 2v2M4.9 6.3 6.4 7.8M2 14h2M20 14h2M17.6 7.8l1.5-1.5"/>',
  list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  plug:'<path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0V9zM12 18v3"/>',
  layers:'<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
  terminal:'<path d="m5 8 4 4-4 4M13 16h6"/>',
  book:'<path d="M4 5a2 2 0 0 1 2-2h11v18H6a2 2 0 0 1-2-2V5z"/><path d="M9 3v18"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon:'<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  copy:'<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  x:'<path d="M18 6 6 18M6 6l12 12"/>',
  test:'<path d="M9 3h6M10 3v6.5L5.6 17A2 2 0 0 0 7.3 20h9.4a2 2 0 0 0 1.7-3L14 9.5V3"/><path d="M7.5 14h9"/>',
  eye:'<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  download:'<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  send:'<path d="M4 12 20 4l-7 16-2.5-6.5L4 12z"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  warn:'<path d="M12 3 2 20h20L12 3z"/><path d="M12 9v5M12 17h.01"/>',
  check:'<path d="m4 12 5 5L20 6"/>',
  arrowUp:'<path d="M12 19V5M5 12l7-7 7 7"/>',
  filter:'<path d="M3 5h18l-7 8v6l-4-2v-4L3 5z"/>',
  key:'<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 2 2-1.5 1.5L21 9l-2 2-1.5-1.5L15 12"/>',
  eyeOff:'<path d="M3 3l18 18"/><path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17.3 17.3 0 0 1-2.9 3.7"/><path d="M6.3 7.6A16.6 16.6 0 0 0 2 12s3.6 6 10 6a9.8 9.8 0 0 0 4.1-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  zap:'<path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z"/>',
  file:'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/>',
  cookie:'<path d="M12 3a9 9 0 1 0 9 9 4 4 0 0 1-5-5 4 4 0 0 1-4-4z"/><path d="M8.5 10h.01M11 15h.01M15 13.5h.01"/>',
  edit:'<path d="M4 20h4L20 8l-4-4L4 16v4z"/><path d="m14 6 4 4"/>',
  trash:'<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  chev:'<path d="m6 9 6 6 6-6"/>',
  upload:'<path d="M12 17V5M7 10l5-5 5 5M4 21h16"/>',
  scale:'<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
  sliders:'<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2.2"/><circle cx="9" cy="16" r="2.2"/>'
};
const svg=(n,s=15)=>`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${IC[n]||''}</svg>`;

/* ═══════════════════════════ 数据层：真实接口 → 设计稿 DATA 形状 ═══════════════════════════
   设计稿所有渲染函数都是按下面这一个 DATA 形状写的。生产端不重写渲染逻辑，只做一次适配：
     /admin/api/status  渠道（别名、状态、延迟、有效优先级、自定义请求头）
     /admin/api/usage   总量 / 按天 / 按模型 / 按渠道 / 24h / 各渠道平均延迟 / 最近 200 条
     /admin/api/config  网关地址与密钥（接入信息页）
   刷新节奏 8 秒；页面不可见时不打接口，避免后台标签页空转。 */
let DATA = {
  meta:{ total:0, errors:0, inTok:0, outTok:0, channels:0, enabled:0, models:0, at:0 },
  trend:[], days:[], channels:[], models:[], logs:[], donut:[]
};
let RAW = { channels:[], usage:null, config:null, settings:null };
let loaded = false;

const protoOfChannel = (id) => {
  const c = RAW.channels.find((x) => x.id === id);
  return (c && c.protocol) || 'openai';
};
/* 后端 usage 记录不带请求 ID，用时间戳 base36 派生一个稳定短 ID：
   同一秒的请求会撞号，但日志表按时间排序，撞号只影响展示不影响定位。 */
const reqIdOf = (ts) => 'req_' + Number(ts || 0).toString(36);

function adapt() {
  const st = RAW.channels, us = RAW.usage;
  const byCh = new Map(((us && us.byChannel) || []).map((x) => [x.key, x]));
  const byModel = new Map(((us && us.byModel) || []).map((x) => [x.key, x]));
  const lat = (us && us.latency) || {};
  const chans = st.map((c) => {
    const u = byCh.get(c.id) || {};
    return {
      id:c.id, name:c.name || c.id, proto:c.protocol || 'openai', on:c.enabled !== false,
      status:c.status || 'unknown',
      /* 延迟优先用最近成功请求的均值；status 里的 latencyMs 是探测值，可能很久没更新 */
      ms:lat[c.id] != null ? lat[c.id] : (c.latencyMs == null ? -1 : c.latencyMs),
      models:(c.aliases || []).length, pri:c.priority == null ? 0 : c.priority,
      eff:c.effectivePriority, fail:c.rollFailRate || 0,
      /* 加权轮询：w = 配置权重（0 = 不参与）；wHits / wShare = 被选中次数与占全部轮询命中的比例 */
      w:c.weight == null ? 0 : Number(c.weight) || 0,
      wHits:Number(c.weightedHits) || 0,
      wShare:Number(c.weightedShare) || 0,
      /* 渠道级超时字段（v1.18.46）：没配就不下发该键 → 表单留空（空 = 用默认）。原样带过来，
         表单要回填它——**不回填的输入框就是保存按钮旁边那把删除键**（v1.18.44 自定义请求头的现场） */
      fcMs:c.firstChunkTimeoutMs==null?'':c.firstChunkTimeoutMs,
      toMs:c.timeoutMs==null?'':c.timeoutMs,
      /* 渠道级「不发这些参数」（v1.18.33）：没配的渠道后端不下发该字段 → 统一成数组，模板可直接 join */
      dp:Array.isArray(c.dropParams)?c.dropParams.map(String):[],
      /* 自动权重观测（v1.6 静默版，**只算不生效**）：ah = 健康系数 0~1；
         aFail/aN/aLat/aSpd = 这个系数是凭什么算出来的（失败率 / 样本数 / 延迟 / 相对最快者的倍数） */
      ah:c.autoH == null ? null : Number(c.autoH),
      aFail:c.autoFailRate == null ? null : Number(c.autoFailRate),
      aN:Number(c.autoSamples) || 0,
      aLat:c.autoLatMs == null ? null : Number(c.autoLatMs),
      aSpd:c.autoSpeedRatio == null ? null : Number(c.autoSpeedRatio),
      req:u.requests || 0, err:u.errors || 0,
      aliases:c.aliases || [], upstreamModels:c.upstreamModels || [],
      baseUrl:c.baseUrl || '', apiKey:c.apiKey || '',
      proxy:c.proxy || '', headers:c.headers || '',
      autoAlias:c.autoAlias !== false,
      lastError:c.lastError || '', lastCheck:c.lastCheck || 0,
    };
  });
  /* 模型：别名 → 提供方集合（同一 alias 可被多个渠道提供，按渠道顺序即调度候选顺序） */
  const mm = new Map();
  for (const c of chans) for (const a of c.aliases) {
    if (!mm.has(a.alias)) mm.set(a.alias, { name:a.alias, chans:[], req:0, err:0, up:{} });
    const m = mm.get(a.alias);
    m.chans.push(c.id); m.up[c.id] = a.upstream;
  }
  for (const m of mm.values()) {
    const u = byModel.get(m.name);
    if (u) { m.req = u.requests || 0; m.err = u.errors || 0; }
  }
  const models = [...mm.values()].sort((a, b) => (b.req - a.req) || a.name.localeCompare(b.name));
  const days = ((us && us.byDay) || []);
  const trend = days.map((d) => [String(d.day).slice(5), d.requests || 0]);
  const logs = ((us && us.recent) || []).map((r) => ({
    t:fmtTs(r.ts), ts:r.ts, id:reqIdOf(r.ts),
    m:r.model || '—', c:r.channelId || '—', n:(chans.find(c=>c.id===r.channelId)||{}).name || r.channelId || '—', p:protoOfChannel(r.channelId),
    kind:r.kind || 'chat', ok:r.ok !== false, ms:r.ms || 0,
    i:r.in || 0, o:r.out || 0, note:r.note || '', cl:r.client || '',
  }));
  const tot = (us && us.total) || {};
  const cnt = { ok:0, degraded:0, down:0, unknown:0 };
  for (const c of chans) cnt[c.status] = (cnt[c.status] || 0) + 1;
  DATA = {
    meta:{
      total:tot.requests || 0, errors:tot.errors || 0,
      inTok:tot.inputTokens || 0, outTok:tot.outputTokens || 0,
      channels:chans.length, enabled:chans.filter((c) => c.on).length,
      models:models.length, at:Date.now(),
    },
    trend, days, channels:chans, models, logs,
    /* 来源 IP 态势统计（v1.18.11）：内存态，重启清零——零数据时给空态而不是抛错 */
    stats: RAW.stats || null,
    /* 自动权重观测（v1.6 静默版）：后端算好的"若启用会怎么分"，只用于展示 */
    auto: RAW.auto ? {
      enabled: RAW.auto.enabled === true,
      effective: RAW.auto.effective === true,
      knobs: RAW.auto.knobs || {},
      at: RAW.auto.at || 0,
      models: RAW.auto.models || [],
    } : null,
    donut:[
      { k:'正常', v:cnt.ok, c:'var(--ok)' },
      { k:'降级', v:cnt.degraded, c:'var(--warn)' },
      { k:'不可用', v:cnt.down + (cnt.unknown || 0), c:'var(--err)' },
    ],
  };
}

async function loadAll() {
  const [st, us, cfg, settings, keys, ipst, chdefs] = await Promise.all([
    api('/admin/api/status'),
    api('/admin/api/usage').catch(() => null),
    api('/admin/api/config').catch(() => null),
    /* 运行期设置单独兜底：这个端点挂了也不能把整页拉取拖垮（其余三份照常刷新） */
    api('/admin/api/settings').catch(() => null),
    /* 密钥管理页同理单独兜底 */
    api('/admin/api/keys').catch(() => null),
    /* 来源 IP 态势统计同理单独兜底（v1.18.11） */
    api('/admin/api/stats').catch(() => null),
    /* 渠道定义（v1.18.33）：渠道级「不发这些参数」**只在 GET /admin/api/channels 上**——
       /admin/api/status 的渠道投影里没有它，而表单回填与详情抽屉都要同步拿到（抽屉渲染是同步的，
       没法 await 一次请求），故在这里并一份进来。同样单独兜底：它挂了只是那个字段看不到，
       整页照常刷新（其余六份不受影响）。 */
    api('/admin/api/channels').catch(() => null),
  ]);
  const stChans = (st && st.channels) || [];
  /* **只按 id 补表单专用字段**（dropParams / firstChunkTimeoutMs / timeoutMs）：其余一律以 status
     （带实时状态）为准，别让这份"渠道定义快照"把 status 的实时字段覆盖回去。空值/缺省 = 没配，不覆盖。
     v1.18.46：两个超时字段此前**不在这一份里、也不在 GET 里**，于是控制台看不见它们的存在，
     而配了的渠道一保存就被抹掉——加渠道字段时这个 id 合并也要一起加。 */
  const defs = (chdefs && chdefs.channels) || null;
  if (defs) {
    const byId = new Map(defs.map((d) => [d && d.id, d]));
    for (const c of stChans) {
      const d = byId.get(c.id);
      if (!d) continue;
      if (Array.isArray(d.dropParams) && d.dropParams.length) c.dropParams = d.dropParams;
      if (d.firstChunkTimeoutMs != null) c.firstChunkTimeoutMs = d.firstChunkTimeoutMs;
      if (d.timeoutMs != null) c.timeoutMs = d.timeoutMs;
    }
  }
  RAW = { channels:stChans, usage:us, config:cfg, auto:(st && st.autoWeight) || null,
          settings:settings || RAW.settings, keys:keys || RAW.keys, stats:ipst || RAW.stats };
  CFG = cfg || CFG;
  adapt();
  loaded = true;
  /* 侧栏底部的网关地址取自真实配置，不写死 */
  if (CFG && CFG.port) $('#gwHost').textContent = '127.0.0.1:' + CFG.port;
  render();
}

/* 重渲染当前页。8 秒一次的轮询不能把滚动位置和输入框里的字冲掉，
   所以进页面之前先记下来，出页面之后再还原。 */
function render() {
  const v = $('#viewport'); if (!v) return;
  const fn = { overview:vOverview, channels:vChannels, models:vModels, autoweight:vAutoWeight, logs:vLogs, stats:vStats, playground:vPlayground, access:vAccess, settings:vSettings, keys:vKeys }[page];
  if (!fn) return;
  const top = v.scrollTop;
  const act = document.activeElement;
  const focusId = act && v.contains(act) && act.id ? act.id : null;
  const caret = focusId && act.selectionStart != null ? act.selectionStart : null;
  fn(v);
  v.scrollTop = top;
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (caret != null && el.setSelectionRange) { try { el.setSelectionRange(caret, caret); } catch (e) {} }
    }
  }
}

/* 渠道动作之后不重拉全量数据，只把这一行改掉，避免整页闪一下 */
async function reload() { try { await loadAll(); } catch (e) {} }

/* 顶栏与各页的「重新探测」共用一个实现 */
async function recheckAll(btn) {
  const old = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = svg('test',14) + '探测中…'; }
  try {
    const r = await api('/admin/api/recheck', { method:'POST' });
    const s = r.summary || { ok:0, fail:0, total:0 };
    if (!s.fail) toast(`✓ 全部 ${s.total} 个渠道正常`, 'ok');
    else toast(`⚠ ${s.ok} 正常 / ${s.fail} 失败`);
    await reload();
  } catch (e) {
    toast('探测失败：' + (e.message || e), 'bad');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = old || svg('test',14) + '重新探测'; }
  }
}

/* ═══════════════════════════ 工具 ═══════════════════════════ */
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nf=n=>Number(n||0).toLocaleString('en-US');
const pct=(a,b)=>b?((a/b)*100):0;
const fTok=n=>n>=1e8?(n/1e8).toFixed(2)+' 亿':n>=1e4?(n/1e4).toFixed(1)+' 万':nf(n);
const fMs=ms=>ms<0?'—':ms<1000?ms+' ms':(ms/1000).toFixed(ms<10000?2:1)+' s';
const stTxt={ok:'正常',degraded:'降级',down:'不可用',unknown:'未探测'};
const protoLabel={openai:'OpenAI',anthropic:'Anthropic',gemini:'Gemini',notion:'Notion 逆向','notion-agent':'Notion Agent',workbuddy:'WorkBuddy',codex:'Codex',genspark:'Genspark',hark:'hark 网页会话'};

/* ═══════════════════════════ 生产：API 客户端 ═══════════════════════════
   控制台唯一网络出口。鉴权走会话 cookie（v1.18.6：登录门把管理密钥交给 /admin/api/session 一次，
   换回 HttpOnly cookie；管理密钥本身不进 localStorage，JS 永远摸不到它）。
   GATEWAY_KEY 由 /admin/api/config 下发掩码，Playground 直连 /v1 时走按需揭示现取。 */
const errMsgOf=(j,fb)=>{const e=j&&j.error;return (typeof e==='string'?e:(e&&e.message))||(j&&j.message)||fb;}; /* 2026-10-04 现场教训（公网部署实测）：网关错误体是 {error:{message,type}}——直接把 j.error 拼进字符串会显示 [object Object]、吞掉真实原因 */
async function api(path,opts={}){
  const headers={'Content-Type':'application/json'};
  const r=await fetch(path,{...opts,headers:{...headers,...(opts.headers||{})}});
  if(r.status===401){showKeyGate();throw new Error('401')}
  const j=await r.json().catch(()=>null);
  if(!r.ok){toast(errMsgOf(j,'HTTP '+r.status),'bad');const err=new Error('http '+r.status);err.status=r.status;err.body=j;throw err}
  return j;
}
let CFG=null;
const csvCell=v=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"';
function downloadCsv(name,rows){
  const csv='\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
const fmtTs=ts=>{const d=new Date(ts),p=n=>String(n).padStart(2,'0');return `${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`};

function toast(msg,kind){
  const el=document.createElement('div');
  el.className='toast '+(kind||'');
  el.innerHTML=svg(kind==='ok'?'check':'warn',14)+'<span>'+esc(msg)+'</span>';
  $('#toasts').appendChild(el);
  setTimeout(()=>{el.style.transition='opacity .3s,transform .3s';el.style.opacity=0;el.style.transform='translateY(8px)';setTimeout(()=>el.remove(),320)},2200);
}
/* 复制：优先用异步剪贴板 API。它只在安全上下文（https / localhost）可用，
   用局域网 IP 走 http 打开控制台时 navigator.clipboard 是 undefined，
   可选链会把整条链短路成 undefined —— 既不复制也不报错，所以必须有 execCommand 兜底。 */
function copyText(t,btn){
  const s=String(t==null?'':t);
  const done=()=>{toast('已复制到剪贴板','ok');if(btn){const o=btn.innerHTML;btn.innerHTML=svg('check',13);setTimeout(()=>btn.innerHTML=o,1200)}};
  const fallback=()=>{
    const ta=document.createElement('textarea');
    ta.value=s; ta.setAttribute('readonly',''); ta.style.position='fixed'; ta.style.top='-1000px';
    document.body.appendChild(ta); ta.select();
    let ok=false; try{ok=document.execCommand('copy')}catch(e){ok=false}
    ta.remove();
    ok?done():toast('复制失败，请手动选择文本');
  };
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(s).then(done).catch(fallback);
  else fallback();
}

/* ═══════════════════════════ 图表 ═══════════════════════════ */
function areaChart(data,w,h,opts){
  const o=Object.assign({pad:[14,10,22,34],stroke:'var(--accent)'},opts||{});
  const [pt,pr,pb,pl]=o.pad, iw=w-pl-pr, ih=h-pt-pb;
  /* 空数据保护（v1.18.1，用户报「渠道管理点详情无反应」）：
     全新部署时 /admin/api/usage 还没有任何记录 → adapt() 算出 trend=[] →
     下面 `pts[0][0]` 直接抛 TypeError，而详情抽屉是在 drawer(...) **之前**调本函数的，
     于是整个 openChannel() 中断：界面毫无反应，只有浏览器控制台里一行红字。
     这里给一个占位图（保留宽高与网格基线），绝不抛。 */
  if(!Array.isArray(data)||data.length===0){
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" style="overflow:visible">
      <line x1="${pl}" y1="${pt+ih/2}" x2="${w-pr}" y2="${pt+ih/2}" stroke="var(--line)" stroke-dasharray="3 6" opacity=".7"/>
      <text x="${(pl+w-pr)/2}" y="${pt+ih/2-6}" text-anchor="middle" fill="var(--tx-3)" font-size="11">暂无数据（还没有调用记录）</text>
    </svg>`;
  }
  const vals=data.map(d=>d[1]), max=Math.max(...vals)*1.12||1, n=vals.length;
  const X=i=>pl+(n<=1?iw/2:i*iw/(n-1)), Y=v=>pt+ih-(v/max)*ih;
  const pts=vals.map((v,i)=>[X(i),Y(v)]);
  let d='M'+pts[0][0]+','+pts[0][1];
  for(let i=0;i<pts.length-1;i++){
    const [x0,y0]=pts[i],[x1,y1]=pts[i+1],cx=(x0+x1)/2;
    d+=' C'+cx+','+y0+' '+cx+','+y1+' '+x1+','+y1;
  }
  const area=d+' L'+X(n-1)+','+(pt+ih)+' L'+X(0)+','+(pt+ih)+' Z';
  const grid=[0,.25,.5,.75,1].map(f=>{
    const y=pt+ih*f, v=Math.round(max*(1-f));
    return `<line x1="${pl}" y1="${y}" x2="${w-pr}" y2="${y}" stroke="var(--line)" stroke-dasharray="2 5" opacity=".55"/>
            <text x="${pl-8}" y="${y+3.5}" text-anchor="end" fill="var(--tx-3)" font-size="9.5" font-family="var(--f-mono)">${v>=1000?(v/1000).toFixed(1)+'k':v}</text>`;
  }).join('');
  const step=Math.ceil(n/7);
  const xlab=data.map((dt,i)=>i%step===0||i===n-1?`<text x="${X(i)}" y="${h-5}" text-anchor="middle" fill="var(--tx-3)" font-size="9.5" font-family="var(--f-mono)">${Array.isArray(dt)?dt[0]:dt}</text>`:'').join(''); // data 的元素是 [标签,数值] 二元组，横轴只取标签：直接写 ${dt} 会把整对拼成 "09-24,1888"
  const dots=pts.map(([x,y],i)=>`<circle cx="${x}" cy="${y}" r="${i===n-1?3.6:2.2}" fill="${i===n-1?'var(--accent)':'var(--panel)'}" stroke="${o.stroke}" stroke-width="1.6"/>`).join('');
  const gid='g'+Math.random().toString(36).slice(2,7);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" style="overflow:visible">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="${o.stroke}" stroke-width="2" stroke-linecap="round" pathLength="1"/>
    ${dots}${xlab}
  </svg>`;
}
function sparkline(vals,w=72,h=22,c,stretch){
  /* 空数据保护（v1.18.1，与 areaChart 同一处根因）：vals 为空时下面算 i*(w/(0-1)) 会得到
     -0/NaN，末尾 `pts[pts.length-1][0]` 还会直接抛。空数组识别得早，这里给条基线占位。 */
  if(!Array.isArray(vals)||vals.length===0){
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"${stretch?' preserveAspectRatio="none"':''}><line x1="0" y1="${h/2}" x2="${w}" y2="${h/2}" stroke="var(--line)" stroke-dasharray="2 4"/></svg>`;
  }
  const max=Math.max(...vals)||1,min=Math.min(...vals);
  const rng=(max-min)||1;
  const pts=vals.map((v,i)=>[i*(vals.length>1?w/(vals.length-1):w/2),h-3-((v-min)/rng)*(h-9)]);
  const line='M'+pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L');
  const stroke=c||'var(--accent)';
  const gid='sp'+Math.random().toString(36).slice(2,7);
  const area=stretch?`<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${stroke}" stop-opacity=".2"/><stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${line} L${pts[pts.length-1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z" fill="url(#${gid})"/>`:'';
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"${stretch?' preserveAspectRatio="none"':''}>${area}<path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"${stretch?' vector-effect="non-scaling-stroke"':''}/></svg>`;
}
function donut(parts,size=142,thick=13){
  const total=parts.reduce((s,p)=>s+p.v,0)||1, r=(size-thick)/2, C=2*Math.PI*r;
  let off=0;
  const arcs=parts.map(p=>{
    const len=(p.v/total)*C;
    const seg=`<circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${p.c}" stroke-width="${thick}"
      stroke-dasharray="${len-3} ${C-len+3}" stroke-dashoffset="${-off}" stroke-linecap="round"
      transform="rotate(-90 ${size/2} ${size/2})" style="transition:stroke-dasharray .9s var(--ease)"/>`;
    off+=len; return seg;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--panel-3)" stroke-width="${thick}"/>
    ${arcs}
    <text x="${size/2}" y="${size/2-3}" text-anchor="middle" fill="var(--tx)" font-size="26" font-weight="700" font-family="var(--f-serif)">${total}</text>
    <text x="${size/2}" y="${size/2+15}" text-anchor="middle" fill="var(--tx-3)" font-size="9.5" font-family="var(--f-mono)" letter-spacing=".5">渠道总数</text>
  </svg>`;
}

/* ═══════════════════════════ 导航 ═══════════════════════════ */
const NAV=[
  {sec:'监控'},
  {id:'overview',label:'总览',icon:'gauge'},
  {id:'logs',label:'调用日志',icon:'list',cnt:()=>nf(DATA.meta.total)},
  {id:'stats',label:'数据统计',icon:'zap'},
  {sec:'资源'},
  {id:'channels',label:'渠道管理',icon:'plug',cnt:()=>DATA.meta.channels},
  {id:'models',label:'聚合模型',icon:'layers',cnt:()=>DATA.meta.models},
  {id:'autoweight',label:'自动权重',icon:'scale'},
  {sec:'工具'},
  {id:'playground',label:'Playground',icon:'terminal'},
  {id:'settings',label:'运行期设置',icon:'sliders'},
  {id:'keys',label:'密钥管理',icon:'key'},
  {id:'access',label:'接入信息',icon:'book'}
];
let page='overview';
function renderRail(){
  $('#railNav').innerHTML=NAV.map(it=>{
    if(it.sec) return `<div class="rail-sec micro">${it.sec}</div>`;
    const on=page===it.id;
    return `<button class="rail-item${on?' on':''}" data-nav="${esc(it.id)}">${svg(it.icon,16)}<span>${esc(it.label)}</span>${it.cnt?`<span class="cnt">${it.cnt()}</span>`:''}</button>`;
  }).join('');
  $$('#railNav [data-nav]').forEach(b=>b.onclick=()=>go(b.dataset.nav));
}
function go(p){
  page=p;
  $('#crumbCur').textContent=(NAV.find(n=>n.id===p)||{}).label||'';
  renderRail();
  const v=$('#viewport');
  v.innerHTML='';
  ({overview:vOverview,channels:vChannels,models:vModels,autoweight:vAutoWeight,logs:vLogs,stats:vStats,playground:vPlayground,access:vAccess,settings:vSettings,keys:vKeys}[p]||vOverview)(v);
  v.firstElementChild?.classList.add('page');
  // 现在滚动容器是 .viewport 自己，scrollIntoView 不会生效，必须直接归零
  v.scrollTop=0;
}

/* ═══════════════════════════ 页面：总览 ═══════════════════════════ */
function kpiCard(o){
  /* 迷你曲线跟随总览的时间范围（o.spark 传 ovSeries()），没传就退回按天的 DATA.trend */
  const vals=(o.spark||DATA.trend).map(t=>t[1]);
  /* 迷你曲线直接画真实的最近 12 天请求量，不做任何抖动伪造 */
  const tail=vals.slice(-12);
  const up=(o.dir||'up')==='down'?'down':'up';
  return `<div class="card kpi">
    <div class="kpi-lbl">${svg(o.icon,12)}${o.lbl}</div>
    <div class="kpi-val">${o.val}${o.unit?`<span class="unit">${o.unit}</span>`:''}</div>
    <div class="kpi-foot">
      <!-- 方向已由 +/- 与红涨绿跌双重点明，再放箭头是三重冗余 -->
      ${o.delta?`<span class="delta ${up}">${o.delta}</span>`:''}
      <span>${esc(o.note)}</span>
    </div>
    <div class="kpi-spark">${sparkline(tail.length>1?tail:[0,0],300,46,up==='down'?'var(--ok)':'var(--err)',true)}</div>
  </div>`;
}

/* 近 N 天 / 前 N 天汇总，用于 KPI 环比。后端 byDay 只按天聚合，所以口径就是
   「最近 7 天 vs 之前 7 天」；不足 2N 天时前段为空，环比按 0 处理并在文案里说明。 */
function winStats(n){
  const d=DATA.days||[];
  const cur=d.slice(-n), prev=d.slice(-2*n,-n);
  const sum=(a,k)=>a.reduce((s,x)=>s+(x[k]||0),0);
  const req=sum(cur,'requests'), preq=sum(prev,'requests');
  const err=sum(cur,'errors'), perr=sum(prev,'errors');
  const tok=sum(cur,'inputTokens')+sum(cur,'outputTokens');
  const ptok=sum(prev,'inputTokens')+sum(prev,'outputTokens');
  return {
    req, preq, tok, ptok, err,
    okRate:req?((req-err)/req*100):0,
    prevOkRate:preq?((preq-perr)/preq*100):0,
    span:cur.length?`${cur[0].day} → ${cur[cur.length-1].day}`:'—',
  };
}
/* 平均延迟取最近 200 条日志里成功请求的均值（后端 latency 是渠道维度，这里是全局口径） */
function avgLatency(){
  const ok=DATA.logs.filter(l=>l.ok&&l.ms>0);
  return ok.length?ok.reduce((a,l)=>a+l.ms,0)/ok.length:0;
}
/* 延迟环比：日志是新→旧，前一半当「本期」、后一半当「上期」。样本太少时不给数，
   宁可不显示也不编一个假百分比。 */
function avgLatencyDelta(){
  const ok=DATA.logs.filter(l=>l.ok&&l.ms>0);
  if(ok.length<40)return null;
  const half=Math.floor(ok.length/2);
  const avg=a=>a.reduce((s,l)=>s+l.ms,0)/a.length;
  const p=avg(ok.slice(half,half*2));
  return p?((avg(ok.slice(0,half))-p)/p*100):null;
}
const dPct=(a,b)=>b?((a-b)/b*100):null;
const dChip=(v,unit,suffix)=>v==null?'':`${v>=0?'+':''}${v.toFixed(1)}${unit||'%'}${suffix||''}`;

/* 总览时间范围：24 小时走后端 hourly（24 桶），7/30 天走 byDay；KPI 环比窗口跟着天数走 */
const OV_RANGE={ '24h':{days:1,label:'近 24 小时',tab:'24 小时',hourly:true}, '7d':{days:7,label:'近 7 天',tab:'7 天'}, '30d':{days:30,label:'近 30 天',tab:'30 天'} };
let ovRange='7d';
const ovRangeCfg=()=>OV_RANGE[ovRange]||OV_RANGE['7d'];
function ovSeries(){
  const r=ovRangeCfg(), H=r.hourly&&RAW.usage&&RAW.usage.hourly;
  if(Array.isArray(H)&&H.length)return H.map(x=>[String(x.h).padStart(2,'0')+':00',x.requests||0]);
  return DATA.trend.slice(-r.days);
}

/* 渠道趋势：把最近 200 条日志按时间分 12 桶，统计该渠道每桶命中次数。
   日志是新→旧，所以 i=0 落在最右桶。近期没有请求的渠道会是一条贴底直线，这是真实情况。 */
function chSpark(id){
  const L=DATA.logs, N=12;
  if(!L.length)return [0,0];
  const b=new Array(N).fill(0);
  for(let i=0;i<L.length;i++){
    if(L[i].c!==id)continue;
    b[N-1-Math.min(N-1,Math.floor(i/L.length*N))]++;
  }
  return b;
}
/* 导出：总计 + 按天 + 按渠道 + 按模型拼一个 CSV，口径与页面一致 */
function exportUsage(){
  const t=DATA.meta;
  const rows=[['类型','键','请求','错误','输入Token','输出Token']];
  rows.push(['总计','全部',t.total,t.errors,t.inTok,t.outTok]);
  for(const d of DATA.days)rows.push(['按天',d.day,d.requests||0,d.errors||0,d.inputTokens||0,d.outputTokens||0]);
  const byCh=new Map(((RAW.usage&&RAW.usage.byChannel)||[]).map(x=>[x.key,x]));
  for(const c of DATA.channels){const u=byCh.get(c.id)||{};rows.push(['按渠道',c.id,u.requests||0,u.errors||0,u.inputTokens||0,u.outputTokens||0])}
  for(const m of DATA.models)rows.push(['按模型',m.name,m.req,m.err,'','']);
  downloadCsv('zzcsapi-usage-'+new Date().toISOString().slice(0,10)+'.csv',rows);
  toast('✓ 已导出用量 CSV','ok');
}
/* 导出最近 200 条调用明细 */
function exportLogs(){
  const rows=[['时间','请求ID','模型','渠道','协议','状态','耗时ms','输入Token','输出Token','备注']];
  for(const l of DATA.logs)rows.push([l.t,l.id,l.m,l.n,l.p,l.ok?'成功':'失败',l.ms,l.i,l.o,l.note]);
  downloadCsv('zzcsapi-logs-'+new Date().toISOString().slice(0,10)+'.csv',rows);
  toast('✓ 已导出日志 CSV','ok');
}
/* 模型清单：别名 + 来源渠道 + 请求/错误 */
function exportModels(){
  const rows=[['模型别名','来源渠道数','来源渠道','请求','错误']];
  for(const m of DATA.models)rows.push([m.name,m.chans.length,m.chans.join(' '),m.req,m.err]);
  downloadCsv('zzcsapi-models-'+new Date().toISOString().slice(0,10)+'.csv',rows);
  toast('✓ 已导出模型清单','ok');
}
/* 复制网关真实的 /v1/models 响应，而不是前端自己拼的清单 */
async function copyModels(){
  const base=(CFG&&CFG.urls&&CFG.urls.openai)||(location.origin+'/v1');
  try{
    const r=await fetch(base+'/models',{headers:{'Authorization':'Bearer '+(await gwKeyLive())}});
    const j=await r.json();
    await navigator.clipboard.writeText(JSON.stringify(j,null,2));
    toast('✓ 已复制 /v1/models（'+((j&&j.data||[]).length)+' 个）','ok');
  }catch(e){toast('复制失败：'+(e&&e.message||e),'bad')}
}
function vOverview(v){
  /* 首屏是无数据先渲染骨架，donut 可能还是空数组，这里不能直接取 [0] */
  const ok=(DATA.donut[0]||{}).v||0, total=DATA.meta.channels;
  const rc=ovRangeCfg(), series=ovSeries();
  const s=winStats(rc.days);
  /* 24 小时走小时桶，没有「日期 → 日期」区间可讲，用范围名代替 */
  const chartSpan=rc.hourly?rc.label:s.span, subRange=rc.hourly?rc.label:`${rc.label} ${s.span}`;
  const dReq=dPct(s.req,s.preq), dTok=dPct(s.tok,s.ptok);
  const lat=avgLatency(), dLat=avgLatencyDelta();
  const peak=series.reduce((a,t)=>Math.max(a,t[1]),0);
  const avgDay=series.length?Math.round(series.reduce((a,t)=>a+t[1],0)/series.length):0;
  v.innerHTML=`
  <div class="page-hd">
    <div>
      <h1 class="page-title">总览</h1>
      <div class="page-sub">网关运行概览 · 每 8 秒自动刷新 · ${subRange}</div>
    </div>
    <div class="page-actions">
      <div class="tabs" id="rangeTabs">
        ${Object.keys(OV_RANGE).map(r=>`<button class="tab${ovRange===r?' on':''}" data-r="${r}">${OV_RANGE[r].tab}</button>`).join('')}
      </div>
      <button class="btn" data-act="export-usage">${svg('download',14)}导出</button>
      <button class="btn primary" data-act="recheck-all">${svg('test',14)}重新探测</button>
    </div>
  </div>

  <div class="grid g4 stagger" style="margin-bottom:16px">
    ${kpiCard({lbl:'累计请求',icon:'gauge',val:nf(s.req),dir:(dReq||0)>=0?'up':'down',delta:dChip(dReq),note:`${rc.label}环比`,spark:series})}
    ${kpiCard({lbl:'成功率',icon:'check',val:s.okRate.toFixed(1),unit:'%',dir:s.okRate>=s.prevOkRate?'up':'down',delta:dChip(s.prevOkRate?s.okRate-s.prevOkRate:null,'pt'),note:`失败 ${nf(s.err)} 次`,spark:series})}
    ${kpiCard({lbl:'平均延迟',icon:'clock',val:lat?(lat/1000).toFixed(2):'—',unit:lat?'s':'',dir:(dLat||0)<=0?'down':'up',delta:dChip(dLat),note:'最近 200 条成功请求均值',spark:series})}
    ${kpiCard({lbl:'Token 消耗',icon:'layers',val:fTok(s.tok),dir:(dTok||0)>=0?'up':'down',delta:dChip(dTok),note:`输出 ${fTok(s.outTok)}`,spark:series})}
  </div>

  <div class="grid g12" style="margin-bottom:16px">
    <div class="card c8">
      <div class="card-hd">
        <h3>请求趋势</h3><span class="sub">${chartSpan}</span>
        <div class="r"><span class="chip accent">峰值 ${nf(peak)}</span><span class="chip">日均 ${nf(avgDay)}</span></div>
      </div>
      <div class="card-bd" style="padding:18px 20px 10px">${series.length?areaChart(series,760,238):'<div class="empty">暂无用量数据</div>'}</div>
    </div>
    <div class="card c4">
      <div class="card-hd"><h3>渠道健康</h3><span class="sub">${ok}/${total} 正常</span></div>
      <div class="card-bd" style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
        ${donut(DATA.donut)}
        <div class="legend" style="flex:1;min-width:120px">
          ${DATA.donut.map(d=>`<div class="legend-row"><span class="dot ${d.k==='正常'?'ok':d.k==='降级'?'degraded':'down'}"></span><span>${d.k}</span><span class="v">${d.v}</span></div>`).join('')}
          <div class="divider" style="margin:6px 0"></div>
          <div class="legend-row"><span class="muted">已启用</span><span class="v">${DATA.meta.enabled}</span></div>
          <div class="legend-row"><span class="muted">已停用</span><span class="v">${total-DATA.meta.enabled}</span></div>
        </div>
      </div>
    </div>
  </div>

  <div class="grid g12">
    <div class="card c7">
      <div class="card-hd"><h3>渠道流量与健康</h3><span class="sub">按请求量排序</span>
        <div class="r"><button class="btn ghost sm" data-act="go" data-page="channels">全部渠道 ${svg('arrowUp',12)}</button></div>
      </div>
      <div class="card-bd tight tbl-wrap">
        <table class="tbl">
          <thead><tr><th>渠道</th><th>状态</th><th class="t-r">延迟</th><th class="t-r">请求</th><th>成功率</th><th class="t-r">趋势</th></tr></thead>
          <tbody>${DATA.channels.slice(0,7).map(c=>{
            const rate=pct(c.req-c.err,c.req);
            return `<tr class="clickable" data-act="open-channel" data-id="${esc(c.id)}">
              <td><div class="cell-main"><span class="avatar">${esc(c.name.slice(0,2))}</span>
                <div style="min-width:0"><div class="cell-name">${esc(c.name)}</div><div class="cell-sub">${esc(c.id)} · ${esc(protoLabel[c.proto])}</div></div></div></td>
              <td><span class="pill ${c.status}"><span class="dot ${c.status}"></span>${stTxt[c.status]}</span></td>
              <td class="t-r mono">${fMs(c.ms)}</td>
              <td class="t-r mono">${nf(c.req)}</td>
              <td><div class="row" style="gap:8px"><div class="proto-bar" style="flex:1"><i style="width:${rate}%;background:${rate>90?'var(--ok)':rate>70?'var(--warn)':'var(--err)'}"></i></div><span class="mono" style="font-size:11px">${rate.toFixed(0)}%</span></div></td>
              <td class="t-r">${sparkline(chSpark(c.id),72,20)}</td>
            </tr>`}).join('')}</tbody>
        </table>
      </div>
    </div>
    <div class="card c5">
      <div class="card-hd"><h3>热门模型</h3><span class="sub">按请求量</span>
        <div class="r"><button class="btn ghost sm" data-act="go" data-page="models">全部模型 ${svg('arrowUp',12)}</button></div>
      </div>
      <div class="card-bd">
        <div class="bars">${DATA.models.slice(0,8).map(m=>{
          const max=DATA.models[0].req||1;
          return `<div class="bar-row" data-m="${esc(m.name)}" data-act="open-model" style="cursor:pointer">
            <span class="bar-name">${esc(m.name)}</span><span class="bar-val">${nf(m.req)}</span>
            <span class="bar-track"><i style="width:${(m.req/max*100).toFixed(1)}%"></i></span>
          </div>`}).join('')}</div>
      </div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="card-hd"><h3>近期调用</h3><span class="sub">最近 8 条</span>
      <div class="r"><button class="btn ghost sm" data-act="go" data-page="logs">查看全部 ${svg('arrowUp',12)}</button></div>
    </div>
    <div class="card-bd tight tbl-wrap">
      <table class="tbl">
        <thead><tr><th>时间</th><th>模型</th><th>渠道</th><th>协议</th><th>状态</th><th class="t-r">耗时</th><th class="t-r">输入</th><th class="t-r">输出</th></tr></thead>
        <tbody>${DATA.logs.slice(0,8).map(l=>`<tr class="clickable" data-act="open-log" data-id="${esc(l.id)}">
          <td class="mono" style="font-size:12px">${l.t}</td>
          <td class="cell-name">${esc(l.m)}</td>
          <td><span class="mono" style="font-size:12px">${l.c}</span></td>
          <td><span class="chip ${esc(l.p)}">${esc(protoLabel[l.p]||l.p)}</span></td>
          <td><span class="pill ${l.ok?'ok':'down'}"><span class="dot ${l.ok?'ok':'down'}"></span>${l.ok?'成功':'失败'}</span></td>
          <td class="t-r mono">${fMs(l.ms)}</td>
          <td class="t-r mono">${nf(l.i)}</td>
          <td class="t-r mono">${nf(l.o)}</td>
        </tr>`).join('')||'<tr><td colspan="8"><div class="empty">暂无调用记录</div></td></tr>'}</tbody>
      </table>
    </div>
  </div>`;
  /* 切换时间范围只重渲染总览；render() 会保留滚动位置与焦点，不会跳顶 */
  $$('#rangeTabs .tab',v).forEach(t=>t.onclick=()=>{ovRange=t.dataset.r;render()});
}

/* ═══════════════════════════ 页面：渠道 ═══════════════════════════ */
let chTab='all', chQ='';
function vChannels(v){
  v.innerHTML=`
  <div class="page-hd">
    <div><h1 class="page-title">渠道管理</h1>
      <div class="page-sub">${DATA.channels.length} 个渠道 · 已启用 ${DATA.channels.filter(c=>c.on).length} · 支持 ${PROTO_ORDER.length} 种协议</div></div>
    <div class="page-actions">
      <div class="menu-wrap">
        <button class="btn" data-act="toggle-imp-menu">${svg('zap',14)}导入${svg('chev',12)}</button>
        <div class="menu" id="impMenu">
          <div class="hd">Codex</div>
          <button data-act="open-import" data-kind="codex-rt">${svg('zap',14)}Codex RT<span class="d">粘贴</span></button>
          <button data-act="open-import" data-kind="codex-json">${svg('file',14)}Codex JSON<span class="d">文件</span></button>
          <div class="sep"></div>
          <div class="hd">Genspark</div>
          <button data-act="open-import" data-kind="gs-session">${svg('cookie',14)}Genspark 会话<span class="d">粘贴</span></button>
          <button data-act="open-import" data-kind="gs-json">${svg('file',14)}Genspark JSON<span class="d">文件</span></button>
        </div>
      </div>
      <button class="btn" data-act="open-test-models">${svg('test',14)}测试模型</button>
      <button class="btn primary" data-act="open-channel-form">${svg('plus',14)}添加渠道</button>
    </div>
  </div>

  <div class="row wrap" style="margin-bottom:14px;gap:10px">
    <div class="tabs" id="chTabs">
      <button class="tab on" data-t="all">全部 <span class="n">${DATA.channels.length}</span></button>
      <button class="tab" data-t="on">已启用 <span class="n">${DATA.channels.filter(c=>c.on).length}</span></button>
      <button class="tab" data-t="off">已停用 <span class="n">${DATA.channels.filter(c=>!c.on).length}</span></button>
    </div>
    <div class="search" style="min-width:230px;margin-left:0">
      ${svg('filter',14)}<input id="chQ" placeholder="按名称 / ID / 协议过滤…" value="${chQ}">
    </div>
    <button class="btn ml-auto" data-act="recheck-all">${svg('test',14)}全部重探测</button>
  </div>

  <div class="card"><div class="card-bd tight tbl-wrap" id="chTable"></div></div>`;
  $$('#chTabs .tab',v).forEach(t=>t.onclick=()=>{chTab=t.dataset.t;$$('#chTabs .tab',v).forEach(x=>x.classList.remove('on'));t.classList.add('on');drawChTable()});
  $('#chQ',v).oninput=e=>{chQ=e.target.value;drawChTable()};
  drawChTable();
}
/* 自动权重页（v1.9）：回答"如果开了自动权重，同一个模型的候选会怎么分"。
   独立页（资源 → 自动权重），不再挤在渠道管理顶部——那里是本页的入口，不是它的家。
   只读展示——后端这一版也只算不生效，所以页面上用 .aw-note 自证"没生效"，不靠用户猜。
   标记只产结构，样式全在 build/extra.css 的 .aw-*（生产独有组件，设计稿不含）；
   本函数只允许依赖 DATA / esc / nf——回归测试按这个签名注入（test/console-state.test.js §4）。 */
function vAutoWeight(v){
  v.innerHTML=`
  <div class="page-hd">
    <div><h1 class="page-title">自动权重</h1>
      <div class="page-sub">按失败率 / 延迟 / 样本量预测各候选的分流份额 · 只算不生效，真实路由仍按手工权重与优先级</div></div>
  </div>
  ${autoWeightCard()}`;
}
function autoWeightCard(){
  const a=DATA.auto; if(!a) return '';
  const nm=(id)=>{const c=DATA.channels.find(x=>x.id===id);return c?c.name:id;};
  const k=a.knobs||{};
  const hcol=(h)=>h>=0.9?'var(--ok)':h>=0.6?'var(--warn)':'var(--err)';
  const ms=(a.models||[]).filter(m=>(m.candidates||[]).length>1);
  const allOff=ms.length>0&&ms.every(m=>m.manualOff);
  // 旋钮文字必须是**纯文本**：回归测试按整串断言（如"速度权重 0.5"），中间插标签会把串断开
  const knobs=[
    k.latencyPenalty!=null?`速度权重 ${k.latencyPenalty}`:'',
    k.floor!=null?`地板 ${k.floor}`:'',
    k.maxShare!=null?`单渠道上限 ${k.maxShare}%`:'',
    k.minSamples!=null?`失败率样本 <${k.minSamples} 条不扣分`:'',
    k.updateMs!=null?`每 ${Math.round(k.updateMs/1000)}s 重算`:'',
  ].filter(Boolean).map(t=>`<span class="tag">${t}</span>`).join('');
  const hd=`<div class="card-hd">
    <h3>分流预测</h3>
    <span class="chip${a.effective?' accent':''}">${a.effective?'已生效':'只算不生效'}</span>
    <span class="sub r">${ms.length} 个多候选模型</span>
  </div>`;
  if(!ms.length) return `<div class="card aw-card">${hd}
    <div class="card-bd tight"><div class="empty">当前没有「同一个模型被多个渠道提供」的情况，暂无可观测的分流</div></div></div>`;
  const rows=ms.map(m=>{
    const list=(m.candidates||[]).map(c=>{
      const why=[c.failRate!=null?`失败率 ${Math.round(c.failRate*100)}%`:`失败率样本只有 ${c.samples} 条（不足 ${k.minSamples}，这一项不扣分）`,
        c.speedRatio!=null?`延迟 ${c.latMs}ms（最快的 ${c.speedRatio} 倍）`:'无延迟数据（不按速度扣分）'].join(' · ');
      const sub=[c.h<1?`健康 ${c.h.toFixed(2)}`:'', c.nowShare!=null?`当前 ${c.nowShare}%`:''].filter(Boolean).join(' · ');
      const kind=c.kind==='blind'?'<span class="k">盲试</span>':c.kind==='auto'?'<span class="k">自动匹配</span>':'';
      return {c, col:hcol(c.h), why, sub, kind};
    });
    // 一个候选一列，列宽 = 份额（flex-grow，见 extra.css .aw-split），渠道名与百分比就挂在
    // 自己那一段色带的正下方 —— 读"这段是谁的"不用去别处找（旧版两列网格图例与色带对不上）。
    const cols=list.filter(x=>x.c.share>0).map(x=>`<div class="aw-col" style="--w:${Math.min(100,x.c.share)};--c:${x.col}" title="${esc(nm(x.c.id))} · 预测 ${x.c.share}% · ${esc(x.why)}">
        <i class="aw-seg"></i>
        <div class="aw-cap">
          <span class="aw-nm">${esc(nm(x.c.id))}${x.kind}</span>
          <span class="aw-sh">${x.c.share}%</span>
        </div>
        ${x.sub?`<div class="aw-sub">${x.sub}</div>`:''}
      </div>`).join('');
    // 份额为 0 的候选列宽就是 0（画出来是看不见的），单独一行说清它为什么没分到
    const zero=list.filter(x=>!(x.c.share>0));
    const zrow=zero.length?`<div class="aw-zero">未参与分流：${zero.map(x=>`${esc(nm(x.c.id))}（${esc(x.why)}）`).join('、')}</div>`:'';
    // 全部模型都没手工权重时，卡头那句「没填就按优先级兜底」已说清，逐块再挂标签纯属噪音
    const flags=((m.manualOff&&!allOff)?'<span class="tag">当前未开加权轮询</span>':'')
      +((m.excluded||[]).length?`<span class="tag warn">已排除 ${(m.excluded||[]).map(nm).join('、')}</span>`:'');
    return `<div class="aw-model">
      <div class="aw-m-hd">
        <span class="aw-m-name">${esc(m.model)}</span>
        <span class="aw-m-meta">${list.length} 个候选 · ${nf(m.requests)} 次请求</span>
        ${flags}
      </div>
      <div class="aw-split">${cols}</div>
      ${zrow}
    </div>`;
  }).join('');
  return `<div class="card aw-card">${hd}
    <div class="aw-meta">
      <div class="aw-note">下面是「若启用自动权重会怎么分」的预测：<b>当前分流一字未动</b>——真实路由仍按你填的权重，没填就按优先级兜底。</div>
      ${knobs?`<div class="aw-knobs"><span class="lbl">旋钮</span>${knobs}</div>`:''}
    </div>
    ${rows}
  </div>`;
}

/* ═══════════════════════════ 页面：运行期设置（v1.18） ═══════════════════════════
   三组运行期开关：会话粘性 / 客户端限流 / 指标端点。以前只能改 config.json + 重启容器，
   现在在这里改完**立即生效、立即落库**（后端 GET/POST /admin/api/settings，PATCH 语义）。
   两个值都必须展示：config=用户填的原值（回填输入框）、effective=钳制后真正生效的值
   （ttlSec 填 5 → 生效 30）。只显示一个就会变成"我明明填了 5，怎么没生效"的悬案。
   草稿 setDraft 与 config 分离：没改动时跟随服务端刷新，一旦改动（setDirty）就不被 8 秒轮询覆盖。 */
let setDraft=null, setDirty=false, setSaving=false, setError='';
const SET_GROUPS=['sessionAffinity','rateLimit','metrics','thinkingReplay'];
const SET_META={
  sessionAffinity:{title:'会话粘性',icon:'cookie',
    desc:'同一会话尽量落到同一家渠道。只改「谁是第一位」——粘住的渠道不在候选 / 冷却 / 已 down 时一动不动；命中也不影响加权份额统计。'},
  rateLimit:{title:'客户端限流',icon:'zap',
    desc:'整机限流（不按 IP）。超限回 429 + Retry-After；闸门在鉴权之前，连刷鉴权的流量也挡；/healthz、管理面、/metrics 不受影响。'},
  metrics:{title:'指标端点',icon:'gauge',
    desc:'Prometheus 文本格式的 /metrics。默认开、需 admin key；public 打开后匿名可抓。'},
  thinkingReplay:{title:'thinking 回放',icon:'clock',
    desc:'Anthropic 同协议直通上，客户端把上一轮 thinking 块丢了 signature 再送回来时（部分框架重序列化会丢不认识的字段），按缓存补回上游自己签的那枚。只回放缓存里真有的签名——从不生成、从不跨渠道；取不到会话键就不回放；默认关。'},
};
const SET_FIELDS={
  sessionAffinity:[
    {k:'ttlSec',label:'记忆时长',unit:'秒',ph:'3600',range:'范围 30 – 604800 秒'},
    {k:'maxEntries',label:'最多记忆条数',unit:'条',ph:'2000',range:'范围 16 – 100000'},
    {k:'deriveFromBody',label:'从请求正文推断会话',bool:true,
      warn:'开启后，内容相同的不同请求会互相抢占同一家渠道 —— 默认关是有意的。'},
  ],
  rateLimit:[
    {k:'rpm',label:'每分钟请求数',unit:'rpm',ph:'0',range:'0 = 不限'},
    {k:'burst',label:'令牌桶容量',unit:'次',ph:'0',range:'0 = 等于 rpm'},
    {k:'maxConcurrent',label:'并发上限',unit:'个',ph:'0',range:'0 = 不限'},
  ],
  metrics:[
    {k:'public',label:'允许匿名抓取',bool:true,
      warn:'匿名可抓会把渠道 id 暴露给能访问该端口的人（正文不含任何密钥）。'},
  ],
  thinkingReplay:[
    {k:'ttlSec',label:'缓存时长',unit:'秒',ph:'3600',range:'范围 30 – 604800 秒'},
    {k:'maxEntries',label:'最多缓存条数',unit:'条',ph:'2048',range:'范围 16 – 100000'},
  ],
};
function setGroupCfg(g){const s=RAW.settings||{};return {cfg:((s.config||{})[g])||{},eff:((s.effective||{})[g])||{}};}
function metricsUrl(){return (typeof location!=='undefined'&&location.origin?location.origin:'')+'/metrics';}
function syncSettingsDraft(force){
  const s=RAW.settings; if(!s||!s.config) return;
  if(force||!setDraft||!setDirty) setDraft=JSON.parse(JSON.stringify(s.config));
}
/* 生效值提示：只在"已保存的值被钳制"时给出（未保存的编辑不预判，免得拿旧的 effective 吓人）。 */
function setHint(g,f){
  const c=setGroupCfg(g), d=(setDraft&&setDraft[g])||{};
  if(d[f.k]!==c.cfg[f.k]) return f.range||'';
  return c.cfg[f.k]!==c.eff[f.k]?`生效：${c.eff[f.k]}`:'';
}
/* 只提交有改动的组 / 字段（PATCH 语义）；留空的数字不下发（留空 ≠ 0）。 */
function setPayload(){
  const s=RAW.settings||{}, cfg=s.config||{}, out={};
  for(const g of SET_GROUPS){
    const c=cfg[g]||{}, grp={};
    if(setDraft[g].enabled!==c.enabled) grp.enabled=setDraft[g].enabled===true;
    for(const f of SET_FIELDS[g]){
      let v=setDraft[g][f.k];
      if(v===''||v==null) continue;
      if(!f.bool) v=Number(v);
      if(v!==c[f.k]) grp[f.k]=v;
    }
    if(Object.keys(grp).length) out[g]=grp;
  }
  return out;
}
function setStat(g,on,d,stt){
  if(!on) return '<span class="muted">未启用</span>';
  if(g==='sessionAffinity') return `记忆 <b>${nf(stt.entries||0)}</b> 条 · 命中 <b>${nf(stt.hits||0)}</b> · 未命中 <b>${nf(stt.misses||0)}</b> · 学习 <b>${nf(stt.learned||0)}</b>`;
  if(g==='rateLimit') return `在飞 <b>${nf(stt.inflight||0)}</b> · 峰值 <b>${nf(stt.peakInflight||0)}</b> · 限速拒绝 <b>${nf(stt.limitedRate||0)}</b> · 并发拒绝 <b>${nf(stt.limitedConcurrent||0)}</b>`;
  if(g==='thinkingReplay') return `缓存 <b>${nf(stt.entries||0)}</b> 条 · 学习 <b>${nf(stt.learned||0)}</b> · 修复命中 <b>${nf(stt.hits||0)}</b> · 未命中 <b>${nf(stt.misses||0)}</b> · 作废 <b>${nf(stt.stale||0)}</b>`;
  return `已启用（${d.public?'<b>匿名可抓</b>':'需 admin key'}）
    <button class="btn ghost sm" id="setCopyMetrics" data-t="${esc(metricsUrl())}">${svg('copy',12)}复制抓取地址</button>`;
}
function setCard(g){
  const M=SET_META[g], c=setGroupCfg(g), s=RAW.settings||{};
  const stt=((s.status||{})[g==='sessionAffinity'?'affinity':g])||{};
  const d=setDraft[g], on=d.enabled===true;
  const rows=SET_FIELDS[g].map(f=>{
    if(f.bool) return `<div class="set-row"><label>${f.label}</label>
      <button class="switch${d[f.k]?' on':''}" id="set_${g}_${f.k}" ${on?'':'disabled'} title="${d[f.k]?'关闭':'开启'}"></button>
      <span class="set-eff"></span></div>
      ${f.warn?`<div class="set-warn">${esc(f.warn)}</div>`:''}`;
    const val=d[f.k]==null||d[f.k]===''?'':String(d[f.k]);
    return `<div class="set-row"><label for="set_${g}_${f.k}">${f.label}</label>
      <input class="input" type="number" id="set_${g}_${f.k}" value="${esc(val)}" placeholder="${f.ph}" ${on?'':'disabled'}>
      <span class="set-unit">${f.unit||''}</span>
      <span class="set-eff" id="setEff_${g}_${f.k}">${esc(setHint(g,f))}</span></div>`;
  }).join('');
  return `<div class="card set-card${on?'':' muted'}">
    <div class="card-hd"><h3>${svg(M.icon,14)} ${M.title}</h3>
      <button class="switch ml-auto${on?' on':''}" id="setTg_${g}" title="${on?'关闭':'开启'}"></button></div>
    <div class="card-bd">
      <div class="set-desc">${M.desc}</div>
      ${rows}
      <div class="set-stat">${setStat(g,on,d,stt)}</div>
    </div></div>`;
}
function vSettings(v){
  if(!RAW.settings||!RAW.settings.config){
    v.innerHTML=`<div class="page-hd"><div><h1 class="page-title">运行期设置</h1>
      <div class="page-sub">会话粘性 / 客户端限流 / 指标端点 / thinking 回放 · 改完立即生效，无需重启</div></div></div>
      <div class="card"><div class="card-bd"><div class="empty">设置接口不可用（GET /admin/api/settings 没有返回数据）</div></div></div>`;
    return;
  }
  syncSettingsDraft(false);
  v.innerHTML=`
  <div class="page-hd">
    <div><h1 class="page-title">运行期设置</h1>
      <div class="page-sub">会话粘性 / 客户端限流 / 指标端点 / thinking 回放 · 改完立即生效、立即落库，无需重启容器</div></div>
    <div class="page-actions">
      <button class="btn" id="setReset">${svg('x',14)}还原</button>
      <button class="btn primary" id="setSave">${svg('check',14)}保存设置</button>
    </div>
  </div>
  <div class="set-err${setError?' on':''}" id="setErr">${esc(setError)}</div>
  <div class="grid set-cards">${SET_GROUPS.map(setCard).join('')}</div>`;
  $('#setReset',v).onclick=resetSettings;
  $('#setSave',v).onclick=saveSettings;
  const cp=$('#setCopyMetrics',v); if(cp) cp.onclick=function(){copyText(this.dataset.t,this)};
  for(const g of SET_GROUPS){
    const tg=$(`#setTg_${g}`,v); if(tg) tg.onclick=()=>setToggle(g);
    for(const f of SET_FIELDS[g]){
      const el=$(`#set_${g}_${f.k}`,v); if(!el) continue;
      if(f.bool) el.onclick=()=>{setDraft[g][f.k]=!setDraft[g][f.k];setDirty=true;render()};
      else el.oninput=e=>{const raw=e.target.value;setDraft[g][f.k]=raw===''?'':Number(raw);setDirty=true;
        const h=$(`#setEff_${g}_${f.k}`,v); if(h) h.textContent=setHint(g,f); updateSetSave(v)};
    }
  }
  updateSetSave(v);
}
function setToggle(g){ setDraft[g].enabled=!setDraft[g].enabled; setDirty=true; render(); }
function updateSetSave(v){
  const b=$('#setSave',v); if(!b||setSaving) return;
  b.disabled=!Object.keys(setPayload()).length;
}
function resetSettings(){
  setDraft=null; setDirty=false; setError=''; syncSettingsDraft(true);
  render(); toast('已还原为最近一次保存的值');
}
async function saveSettings(){
  if(setSaving) return;
  const payload=setPayload();
  if(!Object.keys(payload).length){ toast('没有需要保存的改动'); return; }
  const v=$('#viewport'), btn=$('#setSave');
  setSaving=true; setError='';
  const errEl=$('#setErr',v); if(errEl){errEl.className='set-err';errEl.textContent=''}
  if(btn){btn.disabled=true;btn.innerHTML=svg('check',14)+'保存中…'}
  try{
    const r=await api('/admin/api/settings',{method:'POST',body:JSON.stringify(payload)});
    if(r&&r.config) RAW.settings={config:r.config,effective:r.effective||RAW.settings.effective,status:r.status||RAW.settings.status};
    setDirty=false; setDraft=null; syncSettingsDraft(true);
    toast('✓ 设置已保存并立即生效','ok');
    render();
  }catch(e){
    /* 400 的 error 原文直接显示（后端已点名到字段，如 unknown field rateLimit.rpmm）——
       换成"保存失败"会让用户完全不知道该改哪个字段 */
    setError=String((e&&e.body&&e.body.error)||(e&&e.message)||e);
    const el=$('#setErr',v); if(el){el.className='set-err on';el.textContent=setError}
  }finally{
    setSaving=false;
    const b=$('#setSave',v); if(b){b.disabled=false;b.innerHTML=svg('check',14)+'保存设置'}
    updateSetSave(v);
  }
}
function drawChTable(){
  const box=$('#chTable'); if(!box) return;
  const q=chQ.trim().toLowerCase();
  let rows=DATA.channels.filter(c=>chTab==='all'||(chTab==='on'?c.on:!c.on));
  if(q) rows=rows.filter(c=>(c.name+c.id+c.proto).toLowerCase().includes(q));
  // 「全部」页签：已启用排前面，未启用的往后排；同组内按优先级、请求量降序
  if(chTab==='all')rows=[...rows].sort((a,b)=>(b.on?1:0)-(a.on?1:0)||(b.pri-a.pri)||(b.req-a.req));
  if(!rows.length){box.innerHTML='<div class="empty">没有匹配的渠道</div>';return}
  box.innerHTML=`<table class="tbl">
    <thead><tr>
      <th style="width:38px"></th><th>渠道</th><th>协议</th><th>状态</th><th class="t-r">延迟</th>
      <th class="t-r">模型</th><th class="t-r">优先级</th><th class="t-r">权重 / 分流</th><th class="t-r">请求 / 错误</th><th>成功率</th><th class="t-r">操作</th>
    </tr></thead>
    <tbody>${rows.map(c=>{
      // ponytail: 下面「→ 有效优先级」角标表达式与 openChannel 抽屉处内联重复——为保 code-map 行号锚点刻意不抽 helper，下次动这两处时再抽
      const rate=c.req?pct(c.req-c.err,c.req):null;
      return `<tr class="clickable">
        <td><button class="switch ${c.on?'on':''}" data-act="toggle-ch" data-id="${esc(c.id)}" title="${c.on?'停用':'启用'}"></button></td>
        <td><div class="cell-main"><span class="avatar">${esc(c.name.slice(0,2))}</span>
          <div style="min-width:0"><div class="cell-name">${esc(c.name)}</div><div class="cell-sub">${esc(c.id)}</div></div></div></td>
        <td><span class="chip ${esc(c.proto)}">${esc(protoLabel[c.proto]||c.proto)}</span></td>
        <td><span class="pill ${c.status}"><span class="dot ${c.status}"></span>${stTxt[c.status]}</span></td>
        <td class="t-r mono">${fMs(c.ms)}</td>
        <td class="t-r mono">${c.models}</td>
        <td class="t-r mono">${c.pri}${c.fail>0&&c.eff!=null&&c.eff!==c.pri?`<span style="margin-left:4px;font-size:10px;color:${c.fail>=.5?'var(--err)':'var(--warn)'}" title="近期失败率 ${Math.round(c.fail*100)}% → 自动降权中，恢复后自动回升">→ ${c.eff}</span>`:''}</td>
        <td class="t-r mono">${c.w>0?`<span title="权重 ${c.w}；加权轮询命中 ${c.wHits} 次，占全部轮询 ${c.wShare.toFixed(1)}%（重启后重新计数）">${c.w}<span class="muted" style="font-size:11px"> · ${c.wShare.toFixed(0)}%</span></span>`:'<span class="muted" title="未参与加权轮询（权重 0）：只按优先级做兜底">—</span>'}</td>
        <td class="t-r mono">${nf(c.req)} <span class="muted">/ ${c.err?`<span style="color:var(--err)">${nf(c.err)}</span>`:0}</span></td>
        <td>${rate===null?'<span class="muted mono">—</span>':`<div class="row" style="gap:8px"><div class="proto-bar" style="flex:1"><i style="width:${rate}%;background:${rate>90?'var(--ok)':rate>70?'var(--warn)':'var(--err)'}"></i></div><span class="mono" style="font-size:11px">${rate.toFixed(0)}%</span></div>`}</td>
        <td class="t-r"><div class="row" style="justify-content:flex-end;gap:6px">
          <button class="btn ghost sm" data-act="open-test-models" data-id="${esc(c.id)}">测试</button>
          <button class="btn ghost sm" data-act="open-channel-form" data-id="${esc(c.id)}">编辑</button>
          <button class="btn ghost sm" data-act="open-channel" data-id="${esc(c.id)}">详情</button>
        </div></td>
      </tr>`}).join('')}
    </tbody></table>`;
  $$('#chTable tbody tr',box).forEach((tr,i)=>tr.onclick=()=>openChannel(rows[i].id));
}
async function toggleCh(id){
  const c=DATA.channels.find(x=>x.id===id); if(!c)return;
  try{
    await api('/admin/api/channel',{method:'POST',body:JSON.stringify({id,enabled:!c.on})});
    c.on=!c.on;
    toast(`${c.name} 已${c.on?'启用':'停用'}`,c.on?'ok':'');
    drawChTable();
  }catch(e){}
}
/* ═══ 渠道级「不发这些参数」（v1.18.33）══════════════════════════════════════
   现场：某渠道对「tools + reasoning_effort」组合直接 400，而客户端不由我们控制，
   于是后端在**渠道**上给了一个「出站前删掉这几个参数」的开关。
   合法参数名清单**只从服务端下发取**（GET /admin/api/config 的 dropParamWhitelist）——
   前端绝不自己抄一份：抄了就会漂移，用户会撞上"表单里能填、保存却 400"。
   服务端没给这个字段时**优雅降级**：不显示清单，输入框照常可用（后端仍会 400 兜底，
   且 400 的 error 原文由 api() 直显，清单就写在文案里）。 */
function dropWhitelist(){
  const w=CFG&&CFG.dropParamWhitelist;
  return Array.isArray(w)?w.filter(x=>typeof x==='string'&&x):[];
}
/* 该渠道已配的清单 → 输入框里的 'a, b' 文本（没配 = 空框） */
function dropParamsOf(c){
  return (c&&Array.isArray(c.dp)&&c.dp.length)?c.dp.join(', '):'';
}
/* 渠道级超时字段 → 输入框文本（v1.18.46）：配了显示数字、没配显示空框。
   空框的语义是「回默认」而不是「没意见」——服务端对显式空串就是清空（见 POST 的三态语义）。 */
function msTextOf(c,k){
  return (c&&c[k]!=null&&c[k]!=='')?String(c[k]):'';
}
/* 合法参数名 chips：点一下把这个名字填进框（走 data-act 委托，不写内联属性）。
   名字与模板里的 data-act 双向一一对应，见 ACTS 与 test/console-state.test.js。 */
function dropChipsHtml(){
  const w=dropWhitelist(); if(!w.length)return '';
  return `<div class="row wrap" style="gap:6px;margin-top:6px"><span class="help">合法参数名（点一下填进框）：</span>`
    +w.map(k=>`<button type="button" class="chip" style="cursor:pointer" data-act="fill-drop-param" data-k="${esc(k)}">${esc(k)}</button>`).join('')
    +`</div>`;
}
function addDropParam(k){
  const inp=$('#f-drop'); if(!inp||typeof k!=='string')return;
  /* 名字先 trim 再用：chip 传进来的本来就干净（来自服务端下发的清单），但这条路径也可能被
     别的入口复用，留个脏值就会变成框里一个看不见的空项（保存时被后端 400 挡下，用户还看不出哪错了）。 */
  const name=(k||'').trim(); if(!name)return;
  const cur=((inp.value||'')+'').split(/[\s,]+/).map(s=>s.trim()).filter(Boolean);
  if(cur.includes(name))return;   /* 已经填过就不重复塞 */
  cur.push(name); inp.value=cur.join(', ');
}

function openChannel(id){
  const c=DATA.channels.find(x=>x.id===id); if(!c)return;
  const rate=c.req?pct(c.req-c.err,c.req):0;
  drawer(`
    <div class="drawer-hd">
      <span class="avatar" style="width:34px;height:34px;border-radius:9px;font-size:13px">${esc(c.name.slice(0,2))}</span>
      <div style="min-width:0">
        <h3 style="font-size:16px">${esc(c.name)}</h3>
        <div class="cell-sub">${esc(c.id)}</div>
      </div>
      <div class="ml-auto row" style="gap:8px">
        <span class="chip ${esc(c.proto)}">${esc(protoLabel[c.proto]||c.proto)}</span>
        <button class="icon-btn" data-act="close-drawer">${svg('x',15)}</button>
      </div>
    </div>
    <div class="drawer-bd">
      <div class="row wrap" style="gap:9px;margin-bottom:18px">
        <span class="pill ${c.status}"><span class="dot ${c.status}"></span>${stTxt[c.status]}</span>
        <span class="tag">延迟 ${fMs(c.ms)}</span>
        <span class="tag">优先级 ${c.pri}${c.fail>0&&c.eff!=null&&c.eff!==c.pri?`<span style="margin-left:4px;font-size:10px;color:${c.fail>=.5?'var(--err)':'var(--warn)'}" title="近期失败率 ${Math.round(c.fail*100)}%（滚动窗口）→ 自动降权中，恢复后自动回升">→ 有效 ${c.eff}（失败率 ${Math.round(c.fail*100)}%）</span>`:''}</span>
        <span class="tag">${c.on?'已启用':'已停用'}</span>
        ${c.w>0
          ? `<span class="tag" title="加权轮询：同一模型的候选里按权重比例分流；占比 = 命中次数 ÷ 全部加权轮询命中（重启后重新计数）">权重 ${c.w} · 分流 ${c.wShare.toFixed(0)}%<span class="muted" style="margin-left:4px">(${c.wHits} 次)</span></span>`
          : `<span class="tag muted" title="权重为 0（或不填）= 不参与加权轮询，只按优先级 / 健康度做兜底">未参与加权轮询<span class="muted" style="margin-left:4px">· 点「编辑」可设权重</span></span>`}
      </div>

      <div class="sec-title">自动权重（观测 · 只算不生效）</div>
      <div class="row wrap" style="gap:9px;margin-bottom:8px">
        <span class="tag" title="健康系数 0~1：若启用自动权重，这家会按它打折分流；现在只用于展示">健康系数 ${c.ah==null?'—':c.ah.toFixed(2)}</span>
        <span class="tag" title="滚动窗口里的请求数（成功 + 失败）">样本 ${c.aN}</span>
        <span class="tag" title="滚动窗口失败率：健康系数的主力信号；样本少于门槛时该项不参与，速度项仍独立生效">失败率 ${c.aFail==null?`<span class="muted">样本不足，不扣分</span>`:Math.round(c.aFail*100)+'%'}</span>
        <span class="tag" title="该渠道最近成功请求的延迟指数平均，与其相对最快渠道的倍数">延迟 ${c.aLat==null?`<span class="muted">没有数据</span>`:`${c.aLat}ms${c.aSpd?'（'+c.aSpd+'× 最快）':''}`}</span>
      </div>
      <div class="help" style="display:block;margin-bottom:16px">这一版只**计算并展示**：真实分流仍完全按你填的权重（没填就按优先级兜底），上面的系数不会被执行。信道页顶部的观测卡能看到「同一个模型的多个候选会怎么分」。</div>

      <div class="sec-title">接入配置</div>
      <dl class="kv">
        <dt>Base URL</dt><dd class="mono">${esc(chBaseUrl(c))}</dd>
        <dt>密钥</dt><dd class="mono row" style="gap:6px">
          <span id="chKeyTx" data-plain="0">${esc(chKey(c.id)||'—')}</span>
          <button class="icon-btn" id="chKeyBtn" style="width:22px;height:22px" title="明文显示" data-act="toggle-drawer-key" data-id="${esc(c.id)}">${svg('eye',12)}</button>
          <button class="icon-btn" style="width:22px;height:22px" title="复制密钥" data-act="copy-ch-key" data-id="${esc(c.id)}">${svg('copy',12)}</button>
        </dd>
        <dt>协议</dt><dd class="mono">${esc(c.proto)}</dd>
        ${c.dp&&c.dp.length?`<dt>不发这些参数</dt><dd class="mono">${esc(c.dp.join(', '))}</dd>`:''}
        <dt>模型数</dt><dd class="mono">${c.models} 个别名</dd>
      </dl>

      <div class="sec-title">近 7 天表现</div>
      <div class="grid" style="grid-template-columns:repeat(3,1fr);gap:10px">
        <div class="card" style="padding:12px"><div class="micro">请求</div><div class="serif" style="font-size:24px;margin-top:4px">${nf(c.req)}</div></div>
        <div class="card" style="padding:12px"><div class="micro">成功率</div><div class="serif" style="font-size:24px;margin-top:4px">${rate.toFixed(0)}%</div></div>
        <div class="card" style="padding:12px"><div class="micro">错误</div><div class="serif" style="font-size:24px;margin-top:4px;color:${c.err?'var(--err)':'inherit'}">${nf(c.err)}</div></div>
      </div>
      <div style="margin-top:12px">${areaChart(DATA.trend.slice(-12),520,150,{pad:[12,10,22,32]})}</div>

      <div class="sec-title">模型别名</div>
      <div class="row wrap" style="gap:7px">
        ${chAliases(c).map(r=>`<span class="chip">${esc(r.alias)}</span>`).join('')}
      </div>
    </div>
    <div class="drawer-ft">
      <button class="btn primary" data-act="open-test-models" data-id="${esc(c.id)}">${svg('test',14)}测试模型</button>
      <button class="btn" data-act="reprobe" data-id="${esc(c.id)}">${svg('test',14)}重探测</button>
      <button class="btn" data-act="drawer-edit-channel" data-id="${esc(c.id)}">${svg('edit',14)}编辑</button>
      <button class="btn ml-auto" data-act="drawer-toggle-open" data-id="${esc(c.id)}">${c.on?'停用':'启用'}</button>
      <button class="btn danger" data-act="del-channel" data-id="${esc(c.id)}">${svg('trash',14)}删除</button>
    </div>`);
}
async function toggleDrawerKey(id,btn){
  const tx=$('#chKeyTx'); if(!tx)return;
  if(tx.dataset.plain==='1'){   // 收起明文：回到掩码，不需要再问服务端
    tx.textContent=chKey(id)||'—'; tx.dataset.plain='0';
    btn.innerHTML=svg('eye',12); btn.title='明文显示'; return;
  }
  try{
    const k=await chKeyLive(id);
    tx.textContent=k||'（未配置）'; tx.dataset.plain='1';
    btn.innerHTML=svg('eyeOff',12); btn.title='隐藏';
  }catch(e){toast('取密钥原文失败：'+(e&&e.message||e),'bad')}
}
async function reprobe(id){
  const c=DATA.channels.find(x=>x.id===id); if(!c)return;
  toast('探测中…');
  try{
    const r=await api('/admin/api/recheck',{method:'POST',body:JSON.stringify({id})});
    const row=(r.results||[])[0]||{};
    if(row.status)c.status=row.status;
    if(row.latencyMs!=null)c.ms=row.latencyMs;
    c.lastError=row.error||null;
    toast(`✓ 已重探测 ${c.name} · ${stTxt[c.status]||c.status}`,'ok');
    closeDrawer(); drawChTable();
  }catch(e){}
}
async function delChannel(id){
  const c=DATA.channels.find(x=>x.id===id); if(!c)return;
  if(!confirm('确定要删除渠道「'+id+'」吗？会写入 config.json，不可撤销。'))return;
  try{
    await api('/admin/api/channels',{method:'DELETE',body:JSON.stringify({id})});
    DATA.channels.splice(DATA.channels.indexOf(c),1);
    DATA.meta.channels=DATA.channels.length;
    closeDrawer(); drawChTable(); renderRail();
    toast('✓ 已删除渠道 '+id,'ok');
  }catch(e){}
}

/* ═══════════════════════════ 页面：模型 ═══════════════════════════ */
/* 本页筛选状态必须存 JS：8 秒轮询会重绘整页 DOM，只靠 input 里的值会被重建冲掉
   （渠道页 chQ/chTab、日志页 lgQ 等都是这个规矩，模型页此前漏了） */
let mTab='all', mQ='';
function vModels(v){
  const rows=DATA.models;
  /* 多源冠军 / 单点依赖数都由别名表实时算出，不写死 */
  const multi=rows.length?[...rows].sort((a,b)=>b.chans.length-a.chans.length)[0]:null;
  const singleN=rows.filter(m=>m.chans.length===1).length;
  v.innerHTML=`
  <div class="page-hd">
    <div><h1 class="page-title">聚合模型</h1>
      <div class="page-sub">对外暴露 ${DATA.meta.models} 个模型 · OpenAI / Anthropic / Gemini 三套端点共用同一份别名表</div></div>
    <div class="page-actions">
      <button class="btn" data-act="export-models">${svg('download',14)}导出清单</button>
      <button class="btn primary" data-act="copy-models">${svg('copy',14)}复制 /v1/models</button>
    </div>
  </div>

  <div class="row wrap" style="margin-bottom:14px;gap:10px">
    <div class="tabs" id="mTabs">
      <button class="tab${mTab==='all'?' on':''}" data-p="all">全部 <span class="n">${rows.length}</span></button>
      <button class="tab${mTab==='openai'?' on':''}" data-p="openai">OpenAI</button>
      <button class="tab${mTab==='anthropic'?' on':''}" data-p="anthropic">Anthropic</button>
      <button class="tab${mTab==='gemini'?' on':''}" data-p="gemini">Gemini</button>
    </div>
    <div class="search" style="min-width:230px;margin-left:0">${svg('filter',14)}<input id="mQ" placeholder="搜索模型名…" value="${esc(mQ)}"></div>
  </div>

  <div class="grid g12" style="margin-bottom:16px">
    <div class="card c4"><div class="card-bd">
      <div class="micro">最多来源的模型</div>
      <div class="serif" style="font-size:22px;margin-top:6px">${multi?esc(multi.name):'—'}</div>
      <div class="muted" style="font-size:12px;margin-top:3px">${multi?`${multi.chans.length} 个渠道同时提供，故障切换余量最充足`:'暂无别名'}</div>
    </div></div>
    <div class="card c4"><div class="card-bd">
      <div class="micro">单点依赖</div>
      <div class="serif" style="font-size:22px;margin-top:6px">${singleN} 个</div>
      <div class="muted" style="font-size:12px;margin-top:3px">仅 1 个渠道提供的模型，存在单点风险</div>
    </div></div>
    <div class="card c4"><div class="card-bd">
      <div class="micro">别名近似纠错</div>
      <div class="serif" style="font-size:22px;margin-top:6px">已开启</div>
      <div class="muted" style="font-size:12px;margin-top:3px">模型名拼错时返回最接近的可用别名建议</div>
    </div></div>
  </div>

  <div class="card"><div class="card-bd tight tbl-wrap" id="mTable"></div></div>`;
  $('#mQ',v).oninput=e=>{mQ=e.target.value;drawMTable()};
  $$('#mTabs .tab',v).forEach(t=>t.onclick=()=>{mTab=t.dataset.p;$$('#mTabs .tab',v).forEach(x=>x.classList.remove('on'));t.classList.add('on');drawMTable()});
  drawMTable();
}
function drawMTable(){
  const box=$('#mTable'); if(!box)return;
  const q=mQ.trim().toLowerCase();
  const p=mTab||'all';
  let rows=DATA.models.filter(m=>m.name.toLowerCase().includes(q));
  if(p!=='all') rows=rows.filter(m=>m.chans.some(cid=>{const c=DATA.channels.find(x=>x.id===cid);return c&&(c.proto===p||(p==='openai'&&c.proto!=='notion'&&c.proto!=='workbuddy'&&c.proto!=='genspark'&&c.proto!=='notion-agent'))}));
  // 仍有启用渠道的模型排前面，仅剩停用渠道的往后排；同组内按错误数升序、请求量降序
  const live=m=>m.chans.some(cid=>{const c=DATA.channels.find(x=>x.id===cid);return c&&c.on});
  rows=[...rows].sort((a,b)=>(live(b)?1:0)-(live(a)?1:0)||(a.err-b.err)||(b.req-a.req));
  if(!rows.length){box.innerHTML='<div class="empty">没有匹配的模型</div>';return}
  box.innerHTML=`<table class="tbl">
    <thead><tr><th>模型别名</th><th class="t-r">来源渠道</th><th>提供方</th><th class="t-r">请求</th><th>错误</th><th>状态</th></tr></thead>
    <tbody>${rows.map(m=>{
      const single=m.chans.length===1;
      const isLive=live(m);
      return `<tr class="clickable"${isLive?'':' style="opacity:.62"'} data-m="${esc(m.name)}" data-act="open-model">
        <td><div class="cell-main"><span class="avatar">${svg('layers',13)}</span>
          <div style="min-width:0"><div class="cell-name mono" style="font-size:12.5px">${esc(m.name)}</div>
          <div class="cell-sub">${single?'单点依赖':'多源冗余'}</div></div></div></td>
        <td class="t-r"><span class="mono">${m.chans.length}</span></td>
        <td><div class="row wrap" style="gap:5px">${m.chans.slice(0,4).map(cid=>{
          const c=DATA.channels.find(x=>x.id===cid);
          return `<span class="chip ${esc(c?c.proto:'')}">${esc(cid)}</span>`}).join('')}${m.chans.length>4?`<span class="tag">+${m.chans.length-4}</span>`:''}</div></td>
        <td class="t-r mono">${nf(m.req)}</td>
        <td class="mono" style="color:${m.err?'var(--err)':'var(--tx-3)'}">${m.err}</td>
        <td>${!isLive?'<span class="pill unknown"><span class="dot unknown"></span>来源已停用</span>':m.err===0?'<span class="pill ok"><span class="dot ok"></span>稳定</span>':'<span class="pill degraded"><span class="dot degraded"></span>有失败</span>'}</td>
      </tr>`}).join('')}</tbody></table>`;
  $$('#mTable tbody tr',box).forEach((tr,i)=>tr.onclick=()=>openModel(rows[i].name));
}
function openModel(name){
  const m=DATA.models.find(x=>x.name===name); if(!m)return;
  drawer(`
    <div class="drawer-hd">
      <span class="avatar" style="width:34px;height:34px;border-radius:9px">${svg('layers',15)}</span>
      <div style="min-width:0"><h3 style="font-size:16px" class="mono">${esc(m.name)}</h3>
      <div class="cell-sub">${m.chans.length} 个来源渠道</div></div>
      <div class="ml-auto"><button class="icon-btn" data-act="close-drawer">${svg('x',15)}</button></div>
    </div>
    <div class="drawer-bd">
      <div class="grid" style="grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px">
        <div class="card" style="padding:12px"><div class="micro">请求</div><div class="serif" style="font-size:24px;margin-top:4px">${nf(m.req)}</div></div>
        <div class="card" style="padding:12px"><div class="micro">错误</div><div class="serif" style="font-size:24px;margin-top:4px">${m.err}</div></div>
        <div class="card" style="padding:12px"><div class="micro">来源</div><div class="serif" style="font-size:24px;margin-top:4px">${m.chans.length}</div></div>
      </div>
      <div class="sec-title">来源渠道（按 config 渠道序，非实时调度序）</div>
      <div class="card card-bd" style="padding:0">
        <table class="tbl"><thead><tr><th>#</th><th>渠道</th><th>协议</th><th class="t-r">延迟</th><th class="t-r">优先级</th><th>状态</th></tr></thead>
        <tbody>${m.chans.map((cid,i)=>{
          const c=DATA.channels.find(x=>x.id===cid)||{name:cid,proto:'openai',ms:-1,pri:0,status:'unknown'};
          return `<tr><td class="mono">${i+1}</td><td class="cell-name">${esc(c.name)}</td>
            <td><span class="chip ${esc(c.proto)}">${esc(protoLabel[c.proto]||c.proto)}</span></td>
            <td class="t-r mono">${fMs(c.ms)}</td><td class="t-r mono">${c.pri}</td>
            <td><span class="pill ${c.status}"><span class="dot ${c.status}"></span>${stTxt[c.status]}</span></td></tr>`}).join('')}</tbody></table>
      </div>
      <div class="sec-title">调用示例</div>
      <div class="code"><div class="code-hd"><span class="fname">curl</span>
        <button class="btn ghost sm copy" data-act="copy" data-t='curl http://127.0.0.1:8787/v1/chat/completions -H "Authorization: Bearer $GATEWAY_KEY" -H "Content-Type: application/json" -d "{\\"model\\":\\"${esc(m.name)}\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}"'>${svg('copy',13)}</button>
      </div><pre>curl http://127.0.0.1:8787/v1/chat/completions \
  -H <span class="s">"Authorization: Bearer $GATEWAY_KEY"</span> \
  -H <span class="s">"Content-Type: application/json"</span> \
  -d <span class="s">'{"model":"<span class="k">${esc(m.name)}</span>","messages":[{"role":"user","content":"hi"}]}'</span></pre></div>
    </div>`);
}

/* ═══════════════════════════ 页面：日志 ═══════════════════════════ */
let lgRange='7d', lgCh='', lgOk='all', lgQ='';
function vLogs(v){
  v.innerHTML=`
  <div class="page-hd">
    <div><h1 class="page-title">调用日志</h1>
      <div class="page-sub">保留最近 200 条明细 · 累计 ${nf(DATA.meta.total)} 次请求 / ${nf(DATA.meta.errors)} 次失败</div></div>
    <div class="page-actions">
      <button class="btn" data-act="clear-usage">清空</button>
      <button class="btn primary" data-act="export-logs">${svg('download',14)}导出 CSV</button>
    </div>
  </div>

  <div class="card" style="margin-bottom:14px"><div class="card-bd">
    <div class="row wrap" style="gap:12px">
      <div class="field" style="min-width:150px"><label>时间范围</label>
        <select class="select" id="lgRange">
          <option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option>
          <option value="30d">最近 30 天</option><option value="all">全部</option></select></div>
      <div class="field" style="min-width:150px"><label>渠道</label>
        <select class="select" id="lgCh"><option value="">全部渠道</option>${DATA.channels.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field" style="min-width:150px"><label>状态</label>
        <select class="select" id="lgOk"><option value="all">全部</option><option value="ok">仅成功</option><option value="bad">仅失败</option></select></div>
      <div class="field" style="flex:1;min-width:200px"><label>搜索</label>
        <input class="input" id="lgQ" placeholder="模型名 / 渠道名 / 渠道 ID / 请求 ID…"></div>
      <button class="btn" style="align-self:flex-end" data-act="apply-log-filter">${svg('filter',14)}应用筛选</button>
    </div>
  </div></div>

  <div class="card"><div class="card-bd tight tbl-wrap" id="lgTable"></div></div>`;
  const R=$('#lgRange',v), C=$('#lgCh',v), K=$('#lgOk',v), Q=$('#lgQ',v);
  R.value=lgRange; C.value=lgCh; K.value=lgOk; Q.value=lgQ;
  R.onchange=()=>{lgRange=R.value;drawLogTable()};
  C.onchange=()=>{lgCh=C.value;drawLogTable()};
  K.onchange=()=>{lgOk=K.value;drawLogTable()};
  Q.oninput=()=>{lgQ=Q.value;drawLogTable()};
  drawLogTable();
}
function logRows(){
  const span={'24h':864e5,'7d':7*864e5,'30d':30*864e5}[lgRange]||0;
  const now=Date.now(), q=lgQ.trim().toLowerCase();
  return DATA.logs.filter(l=>{
    if(span&&!(l.ts>=now-span))return false;
    if(lgCh&&l.c!==lgCh)return false;
    if(lgOk==='ok'&&!l.ok)return false;
    if(lgOk==='bad'&&l.ok)return false;
    if(q&&!((l.m+' '+l.n+' '+l.c+' '+l.id).toLowerCase().includes(q)))return false;
    return true;
  });
}
function drawLogTable(){
  const box=$('#lgTable'); if(!box)return;
  const rows=logRows();
  if(!rows.length){box.innerHTML='<div class="empty">没有匹配的调用记录</div>';return}
  box.innerHTML=`<table class="tbl">
    <thead><tr><th>时间</th><th>请求 ID</th><th>渠道</th><th>模型</th><th>客户端</th><th>协议</th><th>状态</th><th class="t-r">耗时</th><th class="t-r">输入</th><th class="t-r">输出</th><th></th></tr></thead>
    <tbody>${rows.map(l=>`<tr class="clickable">
      <td class="mono" style="font-size:12px;white-space:nowrap">${esc(l.t)}</td>
      <td class="mono muted" style="font-size:11.5px">${esc(l.id)}</td>
      <td class="cell-name">${esc(l.n)}</td>
      <td class="cell-name">${esc(l.m)}</td>
      <td>${l.cl?`<span class="chip clickable cell-client" data-cl="${esc(l.cl)}" title="查看该客户端的来源统计">${esc(l.cl)}</span>`:'<span class="muted">—</span>'}</td>
      <td><span class="chip ${esc(l.p)}">${esc(protoLabel[l.p]||l.p)}</span></td>
      <td><span class="pill ${l.ok?'ok':'down'}"><span class="dot ${l.ok?'ok':'down'}"></span>${l.ok?'成功':'失败'}</span></td>
      <td class="t-r mono">${fMs(l.ms)}</td>
      <td class="t-r mono">${nf(l.i)}</td>
      <td class="t-r mono">${nf(l.o)}</td>
      <td class="t-r muted">${svg('eye',14)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
  $$('#lgTable tbody tr',box).forEach((tr,i)=>tr.onclick=()=>openLog(rows[i].id));
  /* 客户端标签格：点击跳「数据统计」按该客户端过滤，并直接弹开最活跃来源的详情抽屉——
     「这个客户端属于哪个 IP」当场就有答案（多个来源共用同一标签时弹敲门最多的那个，其余都在过滤后的表里）。
     标签取 chip 自带的 data-cl（esc 过），绝不按 NodeList 索引对 rows——无标签的行不渲染 chip，按索引取会错位。 */
  $$('#lgTable .cell-client',box).forEach(el=>el.onclick=(e)=>{
    e.stopPropagation();
    stFilter.client=el.dataset.cl||'';
    go('stats');
    const hit=((DATA.stats&&DATA.stats.ips)||[]).filter(r=>stClients(r).some(c=>c.k===stFilter.client));
    if(hit.length)openIpStats(hit[0].ip);
  });
}
async function clearUsage(){
  if(!confirm('确定清空全部用量统计与最近调用记录吗？会写入 usage.json，不可撤销。'))return;
  try{await api('/admin/api/usage/clear',{method:'POST'});toast('✓ 已清空用量统计','ok');await loadAll()}catch(e){}
}
function openLog(id){
  const l=DATA.logs.find(x=>x.id===id); if(!l)return toast('该记录已被轮询刷新移除，请重新点击当前列表');
  drawer(`
    <div class="drawer-hd">
      <div style="min-width:0"><h3 style="font-size:15px" class="mono">${esc(l.id)}</h3>
      <div class="cell-sub">${esc(l.t)}</div></div>
      <div class="ml-auto row" style="gap:8px">
        <span class="pill ${l.ok?'ok':'down'}"><span class="dot ${l.ok?'ok':'down'}"></span>${l.ok?'成功':'失败'}</span>
        <button class="icon-btn" data-act="close-drawer">${svg('x',15)}</button></div>
    </div>
    <div class="drawer-bd">
      <dl class="kv">
        <dt>模型</dt><dd class="mono">${esc(l.m)}</dd>
        <dt>渠道</dt><dd>${esc(l.n)}</dd>
        ${l.cl?`<dt>客户端</dt><dd>${esc(l.cl)}</dd>`:''}
        <dt>协议</dt><dd><span class="chip ${esc(l.p)}">${esc(protoLabel[l.p]||l.p)}</span></dd>
        <dt>耗时</dt><dd class="mono">${fMs(l.ms)}</dd>
        <dt>Token</dt><dd class="mono">输入 ${nf(l.i)} · 输出 ${nf(l.o)}</dd>
      </dl>
      ${l.ok?'':'<div class="sec-title">失败原因</div><div class="card" style="padding:12px;border-color:color-mix(in srgb,var(--err) 30%,transparent)"><span class="mono" style="font-size:12px;color:var(--err)">'+esc(l.note||'上游返回失败，网关已自动切换到下一候选渠道')+'</span></div>'}
      <div class="sec-title">请求体</div>
      <div class="code"><div class="code-hd"><span class="fname">request.json</span>
        <button class="btn ghost sm copy" data-act="copy" data-t="${esc(JSON.stringify({model:l.m,messages:[{role:'user',content:'…'}],stream:true}))}">${svg('copy',13)}</button></div>
        <pre>{ <span class="k">"model"</span>: <span class="s">"${esc(l.m)}"</span>,
  <span class="k">"messages"</span>: [{ <span class="k">"role"</span>: <span class="s">"user"</span>, <span class="k">"content"</span>: <span class="s">"…"</span> }],
  <span class="k">"stream"</span>: <span class="s">true</span> }</pre></div>
      <div class="sec-title">响应摘要</div>
      <div class="code"><div class="code-hd"><span class="fname">response.sse</span></div>
        <pre><span class="c">// 用量记录只保留聚合字段，不落 SSE 原文；耗时 ${fMs(l.ms)}，输入 ${nf(l.i)} / 输出 ${nf(l.o)} tok</span>
data: {<span class="k">"usage"</span>:{<span class="k">"prompt_tokens"</span>:${l.i},<span class="k">"completion_tokens"</span>:${l.o}}}
data: [DONE]</pre></div>
    </div>
    <div class="drawer-ft">
      <button class="btn primary" data-t="${esc(l.m)}" data-act="copy-curl">${svg('copy',14)}复制 cURL</button>
      <button class="btn" data-act="copy" data-t="${esc(l.id)}">复制请求 ID</button>
    </div>`);
}
/* 复制一条可直接跑的 cURL；$GATEWAY_KEY 保持占位，避免把真实密钥写进剪贴板 */
function copyCurl(model,btn){
  const base=(CFG&&CFG.urls&&CFG.urls.openai)||(location.origin+'/v1');
  const body=JSON.stringify({model,messages:[{role:'user',content:'hi'}]});
  copyText('curl '+base+'/chat/completions -H "Authorization: Bearer $GATEWAY_KEY" -H "Content-Type: application/json" -d \''+body+'\'',btn);
}

/* ═══════════════════════════ 页面：数据统计（来源 IP 态势）═══════════════════════════ */
/* v1.18.11：密钥分享出去后被人放进"中转站"转卖时看得见——per-IP 敲门数 / token /
   模型 / 峰值并发 / 会话数估计 / 24 小时桶 + 固定来源外科手术式封禁。
   数据是**内存态**（网关重启清零）；封禁表落 config.security.bannedIPs（重启不丢）。
   过滤条件存 JS（与调用日志的 lgRange 同款）：8 秒轮询重绘不冲掉，跨页保留。 */
let stFilter={client:''};
function stClients(r){return (r.clients||[])}
function vStats(v){
  const s=DATA.stats;
  if(!s){v.innerHTML=`<div class="page-hd"><div><h1 class="page-title">数据统计</h1>
      <div class="page-sub">来源 IP 态势与封禁 · 重启后清零</div></div></div>
    <div class="card"><div class="card-bd"><div class="empty">统计端点不可达（网关是旧版本？重启网关后再试）</div></div></div>`;return}
  const g=s.global||{calls:0,tokIn:0,tokOut:0,cur:0,peak:0,bannedHits:0,activeIps:0,since:0};
  const rows=(s.ips||[]).filter(r=>!stFilter.client||stClients(r).some(c=>c.k===stFilter.client));
  v.innerHTML=`
  <div class="page-hd">
    <div><h1 class="page-title">数据统计</h1>
      <div class="page-sub">来源 IP 态势与封禁 · 内存态（网关重启清零）· 统计起点 ${g.since?esc(fmtTs(g.since)):'—'}</div></div>
    <div class="page-actions">
      ${stFilter.client?`<span class="chip">客户端：${esc(stFilter.client)} <button class="icon-btn" data-act="clear-st-filter" title="清除过滤">${svg('x',12)}</button></span>`:''}
      <button class="btn" data-act="stats-refresh">${svg('test',14)}刷新</button>
    </div>
  </div>

  <div class="row wrap st-kpi-row" style="gap:12px;margin-bottom:14px">
    <div class="card st-kpi" style="flex:1;min-width:150px"><div class="card-bd">
      <div class="micro muted">敲门（含 401/429）</div>
      <div class="mono st-kpi-num">${nf(g.calls)}</div>
      <div class="micro muted">封禁命中 ${nf(g.bannedHits)}</div></div></div>
    <div class="card st-kpi" style="flex:1;min-width:150px"><div class="card-bd">
      <div class="micro muted">Token（成功用量）</div>
      <div class="mono st-kpi-num">${nf(g.tokIn+g.tokOut)}</div>
      <div class="micro muted">入 ${nf(g.tokIn)} · 出 ${nf(g.tokOut)}</div></div></div>
    <div class="card st-kpi" style="flex:1;min-width:150px"><div class="card-bd">
      <div class="micro muted">并发（当前 / 峰值）</div>
      <div class="mono st-kpi-num">${nf(g.cur)} <span class="muted st-kpi-unit" style="font-size:14px">/ ${nf(g.peak)}</span></div>
      <div class="micro muted">全局峰值远超任何单 IP 峰值 = 轮换出口的中转站指纹</div></div></div>
    <div class="card st-kpi" style="flex:1;min-width:150px"><div class="card-bd">
      <div class="micro muted">活跃来源</div>
      <div class="mono st-kpi-num">${nf(g.activeIps)}</div>
      <div class="micro muted">${s.trustedProxy?'反代采信：'+esc(s.trustedProxy):'直连模式（不采信 X-Forwarded-For）'}</div></div></div>
  </div>

  ${(s.banned||[]).length?`<div class="card" style="margin-bottom:14px;border-color:color-mix(in srgb,var(--err) 30%,transparent)"><div class="card-bd tight">
    <div class="sec-title" style="margin-bottom:6px">已封禁来源（${(s.banned||[]).length}）· 管理面与控制台不受封禁影响</div>
    <div class="row wrap" style="gap:8px">${(s.banned||[]).map(ip=>`<span class="chip mono" style="border-color:color-mix(in srgb,var(--err) 40%,transparent)">${esc(ip)}
      <button class="icon-btn" data-act="unban-ip" data-t="${esc(ip)}" title="解封">${svg('x',12)}</button></span>`).join('')}</div>
  </div></div>`:''}

  <div class="card"><div class="card-bd tight">
    <div class="sec-title st-sec">来源明细（按敲门数排序 · 点击行看详情与封禁）</div>
    ${rows.length?`<div class="tbl-wrap"><table class="tbl st-fixed"><colgroup><col style="width:11%"><col style="width:7%"><col style="width:15%"><col style="width:6%"><col style="width:8%"><col style="width:14%"><col style="width:16%"><col style="width:13%"><col style="width:10%"></colgroup>
    <thead><tr><th class="t-c">来源 IP</th><th class="t-c">敲门</th><th>客户端标签</th><th class="t-c">会话</th><th class="t-c">峰值并发</th><th class="t-c">Token 入/出</th><th>模型</th><th class="t-c">24 小时</th><th class="t-c">最近</th></tr></thead>
    <tbody>${rows.map(r=>`<tr class="clickable">
      <td class="mono t-c" style="font-size:12px">${esc(r.ip)} ${r.banned?'<span class="pill down"><span class="dot down"></span>已封禁</span>':''}</td>
      <td class="t-c mono">${nf(r.calls)}${r.bannedHits?`<div class="micro" style="color:var(--err)">封禁命中 ${nf(r.bannedHits)}</div>`:''}</td>
      <td>${stClients(r).slice(0,3).map(c=>`<span class="chip">${esc(c.k)}</span>`).join(' ')||(r.calls?'<span class="muted t-c-ph">—</span>':'<span class="muted">仅被封</span>')}</td>
      <td class="t-c mono">${r.sessSat?'≥512':nf(r.sessions)}</td>
      <td class="t-c mono">${nf(r.peak)}${r.cur>0?`<div class="micro" style="color:var(--warn)">在飞 ${nf(r.cur)}</div>`:''}</td>
      <td class="t-c mono">${nf(r.tokIn)} / ${nf(r.tokOut)}</td>
      <td class="cell-name" style="font-size:12px">${(r.models||[]).slice(0,3).map(m=>esc(m.k)).join(' ')||'<span class="muted t-c-ph">—</span>'}${r.modelCount>3?`<span class="muted micro"> 等 ${r.modelCount}</span>`:''}</td>
      <td class="t-c">${sparkline(r.buckets,96,22)}</td>
      <td class="mono muted t-c" style="font-size:11.5px;white-space:nowrap">${esc(fmtTs(r.lastSeen))}</td>
    </tr>`).join('')}</tbody>
  </table></div>`:`<div class="empty">${stFilter.client?'没有使用客户端「'+esc(stFilter.client)+'」的来源（标签只显示每 IP 的前 8 种，且重启后清零）':'还没有任何客户端面流量（管理面手动测试不计数；网关刚重启也会清零）'}</div>`}
  </div></div>

  ${(s.models||[]).length?`<div class="card" style="margin-top:14px"><div class="card-bd tight">
    <div class="sec-title st-sec">按模型（全部来源聚合 · 成功用量口径）</div>
    <div class="tbl-wrap"><table class="tbl st-models">
    <thead><tr><th>模型</th><th class="t-c">次数</th><th class="t-c">占比</th></tr></thead>
    <tbody>${(()=>{const tot=(s.models||[]).reduce((a,m)=>a+m.n,0)||1;return (s.models||[]).map(m=>`<tr>
      <td class="cell-name mono" style="font-size:12px">${esc(m.k)}</td>
      <td class="t-c mono">${nf(m.n)}</td>
      <td><div class="row" style="align-items:center;gap:8px"><div style="flex:1;height:6px;border-radius:3px;background:var(--panel-3);overflow:hidden"><div style="width:${(m.n/tot*100).toFixed(1)}%;height:100%;background:var(--accent)"></div></div><span class="micro mono muted">${(m.n/tot*100).toFixed(1)}%</span></div></td>
    </tr>`).join('')})()}</tbody>
  </table></div>
  </div></div>`:''}
  `;
  $$('#viewport .tbl tbody tr.clickable').forEach((tr,i)=>{const ip=rows[i]&&rows[i].ip;if(ip)tr.onclick=()=>openIpStats(ip)});
}
function openIpStats(ip){
  const s=DATA.stats, r=s&&(s.ips||[]).find(x=>x.ip===ip); if(!r)return;
  const hours=r.buckets.map((n,h)=>[String(h).padStart(2,'0'),n]);
  drawer(`
    <div class="drawer-hd">
      <div style="min-width:0"><h3 style="font-size:15px" class="mono">${esc(ip)}</h3>
      <div class="cell-sub">来源态势 ${r.banned?'· 已封禁':''}</div></div>
      <div class="ml-auto row" style="gap:8px">
        ${r.banned?'<span class="pill down"><span class="dot down"></span>已封禁</span>':''}
        <button class="icon-btn" data-act="close-drawer">${svg('x',15)}</button></div>
    </div>
    <div class="drawer-bd">
      <dl class="kv">
        <dt>敲门</dt><dd class="mono">${nf(r.calls)} 次${r.bannedHits?`（封禁命中 ${nf(r.bannedHits)}）`:''}</dd>
        <dt>Token</dt><dd class="mono">入 ${nf(r.tokIn)} · 出 ${nf(r.tokOut)}</dd>
        <dt>会话数（估计）</dt><dd class="mono">${r.sessSat?'≥ 512（饱和）':nf(r.sessions)}</dd>
        <dt>峰值并发</dt><dd class="mono">${nf(r.peak)}${r.cur>0?`（当前在飞 ${nf(r.cur)}）`:''}</dd>
        <dt>最近活跃</dt><dd class="mono">${esc(fmtTs(r.lastSeen))}</dd>
      </dl>
      <div class="sec-title">客户端标签（按出现次数，前 ${stClients(r).length}${stClients(r).length>=8?'（上限 8）':''}）</div>
      <div class="row wrap" style="gap:8px">${stClients(r).length?stClients(r).map(c=>`<span class="chip">${esc(c.k)}<span class="micro muted"> ${nf(c.n)}</span></span>`).join(''):'<span class="muted">仅被封请求（没有成功用量）</span>'}</div>
      <div class="sec-title">模型（按次数，前 ${(r.models||[]).length}${(r.models||[]).length>=8?'（上限 8）':''}）</div>
      <div class="row wrap" style="gap:8px">${(r.models||[]).length?(r.models||[]).map(m=>`<span class="chip mono" style="font-size:12px">${esc(m.k)}<span class="micro muted"> ${nf(m.n)}</span></span>`).join(''):'<span class="muted">—</span>'}</div>
      <div class="sec-title">24 小时分布（本地时区 · 跨天清零）</div>
      <div>${areaChart(hours,520,150)}</div>
    </div>
    <div class="drawer-ft">
      ${r.banned
        ?`<button class="btn" data-act="unban-ip" data-t="${esc(ip)}">${svg('check',14)}解封该来源</button>`
        :`<button class="btn primary" data-act="ban-ip" data-t="${esc(ip)}">${svg('warn',14)}封禁该来源</button>`}
      <button class="btn" data-act="copy" data-t="${esc(ip)}">复制 IP</button>
    </div>`);
}
async function refreshStats(){
  try{RAW.stats=await api('/admin/api/stats');adapt();render()}catch(e){}
}
async function banIp(ip){
  if(!confirm('确定封禁来源 '+ip+' 吗？\n该来源对 /v1、/anthropic、/gemini 的请求将一律 403；管理面与控制台不受影响。名单写入 config.json，重启不丢。'))return;
  try{await api('/admin/api/bans',{method:'POST',body:JSON.stringify({ip})});toast('✓ 已封禁 '+ip,'ok');await refreshStats()}catch(e){}
}
async function unbanIp(ip){
  if(!confirm('确定解封 '+ip+' 吗？'))return;
  try{await api('/admin/api/bans/'+encodeURIComponent(ip),{method:'DELETE'});toast('✓ 已解封 '+ip,'ok');await refreshStats()}catch(e){}
}

/* ═══════════════════════════ 页面：Playground ═══════════════════════════ */
/* Playground 真的把请求打到网关 /v1/chat/completions：流式、温度、max_tokens、system 全部生效；
   命中渠道取自响应头 X-ZZCSAPI-Channel（网关在每条成功响应上都带），候选渠道取自别名表，
   所以「本次路由」卡里的数字都是这次调用的真实结果，不是演示值。 */
let PG=[], pgRoute=null, pgBusy=false;
/* 输入区同样是「轮询重绘」的受害者：草稿与参数都存 JS，重绘后回填
   （否则 8 秒一到，正在敲的消息和 System Prompt 就被重建的空 textarea 冲掉） */
let pgDraft='', pgSysText='', pgModelSel='', pgTempV=0.7, pgMaxV=2048, pgStreamOn=true;
function vPlayground(v){
  const def=(DATA.models[0]||{}).name||'';
  v.innerHTML=`
  <div class="page-hd">
    <div><h1 class="page-title">Playground</h1>
      <div class="page-sub">直接调试网关路由 · 请求走 /v1/chat/completions，与客户端调用完全一致</div></div>
    <div class="page-actions">
      <button class="btn" data-act="pg-clear">清空会话</button>
      <button class="btn primary" data-act="pg-copy-curl">${svg('copy',14)}复制 cURL</button>
    </div>
  </div>

  <div class="pg">
    <div class="card chat">
      <div class="card-hd">
        <span class="dot ok"></span>
        <h3>会话</h3>
        <span class="sub">自动选择渠道</span>
        <div class="r"><span class="chip accent" id="pgChip">${esc(pgModelSel||def)}</span><span class="tag" id="pgStreamTag">${pgStreamOn?'流式':'非流式'}</span></div>
      </div>
      <div class="chat-body" id="pgBody"></div>
      <div class="composer">
        <textarea id="pgInput" rows="1" placeholder="输入消息，Enter 发送 / Shift+Enter 换行…">${esc(pgDraft)}</textarea>
        <div class="composer-row">
          <div class="row" style="gap:7px">
            <span class="tag" id="pgTagStream">stream=${pgStreamOn}</span><span class="tag" id="pgTagTemp">temp ${pgTempV}</span><span class="tag" id="pgTagMax">max_tokens ${pgMaxV}</span>
          </div>
          <button class="send ml-auto" id="pgSend" title="发送">${svg('send',16)}</button>
        </div>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="card">
        <div class="card-hd"><h3>参数</h3></div>
        <div class="card-bd" style="display:flex;flex-direction:column;gap:15px">
          <div class="field"><label>模型</label>
            <select class="select" id="pgModel">${DATA.models.map(m=>`<option${m.name===(pgModelSel||def)?' selected':''}>${esc(m.name)}</option>`).join('')||'<option value="">（无可用模型）</option>'}</select></div>
          <div>
            <div class="param" style="margin-bottom:8px"><span class="k">Temperature</span><span class="v" id="tVal">${pgTempV}</span></div>
            <input class="range" id="pgTemp" type="range" min="0" max="2" step="0.1" value="${pgTempV}">
          </div>
          <div>
            <div class="param" style="margin-bottom:8px"><span class="k">Max tokens</span><span class="v" id="mVal">${pgMaxV}</span></div>
            <input class="range" id="pgMax" type="range" min="64" max="8192" step="64" value="${pgMaxV}">
          </div>
          <div class="param"><span class="k">流式输出</span><button class="switch${pgStreamOn?' on':''}" id="pgStream"></button></div>
          <div class="param"><span class="k">工具调用仿真</span><span class="tag">服务端自动</span></div>
          <div class="field"><label>System Prompt</label>
            <textarea class="input" id="pgSys" rows="3" placeholder="可选">${esc(pgSysText)}</textarea></div>
        </div>
      </div>
      <div class="card">
        <div class="card-hd"><h3>本次路由</h3><span class="sub">取自响应头 X-ZZCSAPI-Channel</span></div>
        <div class="card-bd" style="display:flex;flex-direction:column;gap:11px" id="pgRoute"></div>
      </div>
    </div>
  </div>`;
  const M=$('#pgModel',v), T=$('#pgTemp',v), X=$('#pgMax',v), S=$('#pgStream',v);
  M.onchange=()=>{pgModelSel=M.value;$('#pgChip').textContent=M.value};
  T.oninput=()=>{pgTempV=T.value;$('#tVal').textContent=T.value;$('#pgTagTemp').textContent='temp '+T.value};
  X.oninput=()=>{pgMaxV=X.value;$('#mVal').textContent=X.value;$('#pgTagMax').textContent='max_tokens '+X.value};
  S.onclick=()=>{S.classList.toggle('on');pgStreamOn=S.classList.contains('on');$('#pgStreamTag').textContent=pgStreamOn?'流式':'非流式';$('#pgTagStream').textContent='stream='+pgStreamOn};
  drawPG(); drawRoute();
  $('#pgSend',v).onclick=pgSend;
  $('#pgInput',v).oninput=e=>{pgDraft=e.target.value};
  $('#pgSys',v).oninput=e=>{pgSysText=e.target.value};
  $('#pgInput',v).onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();pgSend()}};
}
function drawPG(){
  const b=$('#pgBody'); if(!b)return;
  if(!PG.length){b.innerHTML='<div class="empty" style="padding:26px 0">还没有消息 · 在下方输入并回车，请求会真的打到网关</div>';return}
  b.innerHTML=PG.map(m=>{
    if(m.role==='user') return `<div class="msg user"><div class="who">YOU</div>
      <div class="bubble"><div class="meta"><span class="role">你</span></div><div class="body">${esc(m.text)}</div></div></div>`;
    return `<div class="msg ai"><div class="who">AI</div>
      <div class="bubble"><div class="meta"><span class="role">助手</span>${m.model?`<span class="chip accent" style="font-size:9.5px">${esc(m.model)}</span>`:''}</div>
      <div class="body"${m.error?' style="color:var(--err)"':''}>${esc(m.text)}</div>
      </div>
      ${m.usage?`<div class="usage"><span>${esc(m.usage)}</span><span>channel: ${esc(m.channel||'—')}</span></div>`:''}</div></div>`;
  }).join('');
  b.scrollTop=b.scrollHeight;
}
function drawRoute(){
  const box=$('#pgRoute'); if(!box)return;
  const r=pgRoute;
  if(!r){box.innerHTML='<div class="empty" style="padding:14px 0">发送一条消息后显示真实路由结果</div>';return}
  box.innerHTML=`
    <div class="legend-row"><span class="muted">来源渠道</span><span class="v mono">${r.cands.length}</span></div>
    <div class="legend-row"><span class="muted">实际命中</span><span class="v mono">${esc(r.hit||'—')}</span></div>
    <div class="legend-row"><span class="muted">首块延迟</span><span class="v mono">${r.ttfb?Math.round(r.ttfb)+' ms':'—'}</span></div>
    <div class="legend-row"><span class="muted">总耗时</span><span class="v mono">${(r.total/1000).toFixed(2)} s</span></div>
    <div class="divider" style="margin:4px 0"></div>
    <div class="row wrap" style="gap:6px">${r.cands.length?r.cands.map((c,i)=>`<span class="chip ${c===r.hit?'accent':''}">${i+1}. ${esc(c)}</span>`).join(''):'<span class="muted">该模型暂无来源渠道</span>'}</div>`;
}
function fmtUsage(u,ms){
  return `输入 ${nf(u.prompt_tokens||0)} · 输出 ${nf(u.completion_tokens||0)} · ${(ms/1000).toFixed(2)}s`;
}
function pgClear(){PG=[];pgRoute=null;drawPG();drawRoute();toast('已清空会话')}
function pgCopyCurl(){
  const model=$('#pgModel')?$('#pgModel').value:'';
  const base=(CFG&&CFG.urls&&CFG.urls.openai)||(location.origin+'/v1');
  const body=JSON.stringify({model,messages:[{role:'user',content:'hi'}],stream:true});
  copyText('curl '+base+'/chat/completions -H "Authorization: Bearer $GATEWAY_KEY" -H "Content-Type: application/json" -d \''+body+'\'');
}
async function pgSend(){
  if(pgBusy)return;
  const t=$('#pgInput'), text=(t.value||'').trim(); if(!text)return;
  const model=$('#pgModel').value;
  if(!model)return toast('没有可用模型','bad');
  const sys=$('#pgSys').value.trim();
  const temp=Number($('#pgTemp').value), maxTok=Number($('#pgMax').value);
  const stream=$('#pgStream').classList.contains('on');
  PG.push({role:'user',text}); t.value=''; pgDraft=''; drawPG();

  const b=$('#pgBody');
  const wait=document.createElement('div');
  wait.className='msg ai';
  wait.innerHTML=`<div class="who">AI</div><div class="bubble"><div class="meta"><span class="role">助手</span><span class="chip accent" style="font-size:9.5px">${esc(model)}</span></div>
    <div class="body" style="display:flex;gap:5px;align-items:center">
      <span class="dot ok" style="animation:fade .8s infinite alternate"></span><span class="muted" style="font-size:12.5px">正在路由…</span></div></div>`;
  b.appendChild(wait); b.scrollTop=b.scrollHeight;

  const msgs=[];
  if(sys)msgs.push({role:'system',content:sys});
  for(const m of PG)msgs.push({role:m.role==='user'?'user':'assistant',content:m.text});
  const base=(CFG&&CFG.urls&&CFG.urls.openai)||(location.origin+'/v1');
  const key=await gwKeyLive();
  const t0=performance.now();
  let ttfb=0, answer='', usage='', channel='', err='';
  pgBusy=true;
  try{
    const r=await fetch(base+'/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body:JSON.stringify({model,messages:msgs,temperature:temp,max_tokens:maxTok,stream}),
    });
    channel=r.headers.get('X-ZZCSAPI-Channel')||'';
    if(!r.ok){
      const j=await r.json().catch(()=>null);
      err=(j&&((j.error&&(j.error.message||j.error))||j.message))||('HTTP '+r.status);
    }else if(stream){
      const rd=r.body.getReader(), dec=new TextDecoder();
      let buf='', first=true;
      for(;;){
        const {done,value}=await rd.read(); if(done)break;
        buf+=dec.decode(value,{stream:true});
        const lines=buf.split('\n'); buf=lines.pop();
        for(const line of lines){
          const s=line.trim(); if(!s.startsWith('data:'))continue;
          const d=s.slice(5).trim(); if(!d||d==='[DONE]')continue;
          let j; try{j=JSON.parse(d)}catch(e){continue}
          const dl=(j.choices&&j.choices[0]&&j.choices[0].delta)||{};
          if(dl.content){if(first){ttfb=performance.now()-t0;first=false}answer+=dl.content}
          if(j.usage)usage=fmtUsage(j.usage,performance.now()-t0);
        }
      }
      if(first)ttfb=performance.now()-t0;
    }else{
      const j=await r.json();
      ttfb=performance.now()-t0;
      const ch=(j.choices&&j.choices[0])||{};
      answer=(ch.message&&ch.message.content)||'';
      if(j.usage)usage=fmtUsage(j.usage,ttfb);
    }
  }catch(e){ err=String(e&&e.message||e); }
  pgBusy=false;

  const total=performance.now()-t0;
  if(err) PG.push({role:'ai',text:'请求失败：'+err,error:true,model,channel});
  else PG.push({role:'ai',text:answer||'（上游返回空内容）',model,channel,
    usage:usage||('首块 '+(ttfb/1000).toFixed(2)+'s · 总 '+(total/1000).toFixed(2)+'s')});
  drawPG();
  const mm=DATA.models.find(x=>x.name===model);
  pgRoute={cands:mm?mm.chans.slice():[],hit:channel,ttfb,total};
  drawRoute();
  /* 这次调用已写进用量，刷新一次让总览 / 日志同步 */
  loadAll().catch(()=>{});
}

/* ═══════════════════════════ 页面：接入 ═══════════════════════════ */
const SNIP={
  curl:`<span class="c"># OpenAI 协议</span>
curl http://127.0.0.1:8787/v1/chat/completions \\
  -H <span class="s">"Authorization: Bearer $GATEWAY_KEY"</span> \\
  -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{"model":"gpt-6-astra","messages":[{"role":"user","content":"hi"}]}'</span>

<span class="c"># Anthropic 协议</span>
curl http://127.0.0.1:8787/anthropic/v1/messages \\
  -H <span class="s">"x-api-key: $GATEWAY_KEY"</span> \\
  -H <span class="s">"anthropic-version: 2023-06-01"</span> \\
  -d <span class="s">'{"model":"claude-opus-5","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'</span>`,
  python:`<span class="k">from</span> openai <span class="k">import</span> OpenAI

client = OpenAI(
    base_url=<span class="s">"http://127.0.0.1:8787/v1"</span>,
    api_key=<span class="s">"$GATEWAY_KEY"</span>,
)
resp = client.chat.completions.create(
    model=<span class="s">"gpt-6-astra"</span>,
    messages=[{<span class="s">"role"</span>: <span class="s">"user"</span>, <span class="s">"content"</span>: <span class="s">"hi"</span>}],
    stream=<span class="k">True</span>,
)
<span class="k">for</span> chunk <span class="k">in</span> resp:
    <span class="k">print</span>(chunk.choices[0].delta.content <span class="k">or</span> <span class="s">""</span>, end=<span class="s">""</span>)`,
  node:`<span class="k">import</span> OpenAI <span class="k">from</span> <span class="s">'openai'</span>;

<span class="k">const</span> client = <span class="k">new</span> OpenAI({
  baseURL: <span class="s">'http://127.0.0.1:8787/v1'</span>,
  apiKey: process.env.GATEWAY_KEY,
});

<span class="k">const</span> stream = <span class="k">await</span> client.chat.completions.create({
  model: <span class="s">'gpt-6-astra'</span>,
  messages: [{ role: <span class="s">'user'</span>, content: <span class="s">'hi'</span> }],
  stream: <span class="k">true</span>,
});
<span class="k">for await</span> (<span class="k">const</span> chunk <span class="k">of</span> stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? <span class="s">''</span>);`
};
/* ═══════════════════════════ 页面：密钥管理（v1.18.5）═══════════════════════
   密钥原来只来自环境变量（.env → compose → 进程），容器里改不了 .env，
   于是"轮换"只能手改文件 + 重开容器。这一页把它做成点得动的。

   实现要点（每一处都对应一个真实的坑）：
     · 轮换结果写进 config.json 的 auth 段，**优先级高于 .env**——否则重启就把轮换顶回去；
     · 换管理密钥时服务端清空全部会话并在轮换响应里**补发新会话 cookie**（v1.18.6）——
       发起轮换的这个页面不会被踢回登录门；其它标签页/设备下次请求 401，各自重新登录；
     · 明文一律现取（GET /admin/api/admin-key、/admin/api/gateway-key），页面快照里只有掩码；
     · 旧密钥**立即**失效（不设宽限期，这是明确选择），所以按钮要点两下确认。 */
const KEY_SRC_TXT={console:'控制台轮换',env:'环境变量',generated:'首启生成',none:'未设置（鉴权关闭）'};
let keyDraft={gateway:'',admin:''};      // 手填草稿：跨 8 秒轮询保留（同 .viewport 回填约定）
let keyReveal={gateway:'',admin:''};     // 现取到的明文，只活在内存里
let keyBusy=false;

function keyOf(kind){
  const k=RAW.keys||{};
  return (kind==='gateway'?k.gatewayKey:k.adminKey)||{masked:'—',set:false,source:'none'};
}
function keyCard(kind){
  const o=keyOf(kind), label=kind==='gateway'?'网关密钥':'管理密钥';
  const scope=kind==='gateway'?'调用 /v1 · /anthropic · /gemini 的客户端用它':'打开控制台与调用 /admin/* 用它';
  const plain=keyReveal[kind];
  return `<div class="card c6">
    <div class="card-hd"><h3>${label}</h3><span class="sub">${esc(scope)} · 来源：${esc(KEY_SRC_TXT[o.source]||'—')}</span></div>
    <div class="card-bd">
      <div class="ep-key" style="margin-bottom:12px"><span>当前值</span>
        <span class="kval mono" id="kr_${kind}">${esc(plain||o.masked||'—')}</span>
        <button class="btn ghost sm ml-auto" id="ke_${kind}">${svg(plain?'eyeOff':'eye',13)}${plain?'隐藏':'显示'}</button>
        <button class="btn ghost sm" id="kc_${kind}">${svg('copy',13)}复制</button></div>
      <div class="field">
        <span class="help" style="display:block;margin-bottom:6px">换新值：${kind==='admin'?'至少 8 位，且要同时包含大小写字母、数字和特殊字符':'至少 8 位可见 ASCII 字符（不要空格或中文）'}，或直接随机生成</span>
        <div class="row" style="gap:8px;align-items:flex-start">
          <input class="input" id="ki_${kind}" type="text" autocomplete="off" spellcheck="false"
            placeholder="粘贴新的${label}，或点「随机生成」" value="${esc(keyDraft[kind])}" style="flex:1">
          <button class="btn" id="kg_${kind}">${svg('zap',13)}随机生成</button>
          <button class="btn primary" id="ks_${kind}">${svg('check',13)}轮换</button>
        </div>
      </div>
      <div class="help">⚠ 轮换后<b>旧密钥立即失效</b>：${kind==='gateway'
        ?'所有调用方（应用 / 脚本里存的 key）必须马上换成新值'
        :'其它标签页与设备要用新值重新登录一次（这一页会自动更新自己）'}。</div>
    </div></div>`;
}
function vKeys(v){
  const k=RAW.keys;
  if(!k){
    v.innerHTML=`<div class="page-hd"><div><h1 class="page-title">密钥管理</h1>
      <div class="page-sub">轮换 GATEWAY_KEY 与 ADMIN_KEY</div></div></div>
      <div class="card"><div class="card-bd"><div class="empty">密钥接口不可用（GET /admin/api/keys 没有返回数据）</div></div></div>`;
    return;
  }
  const bad=!!k.keysInsecure;
  v.innerHTML=`
  <div class="page-hd">
    <div><h1 class="page-title">密钥管理</h1>
      <div class="page-sub">轮换 GATEWAY_KEY 与 ADMIN_KEY · 改完立即生效，不用重开容器</div></div>
    <div class="page-actions">
      <button class="btn" id="keyReset">${svg('x',14)}回到环境变量值</button>
      <button class="btn ghost" id="keyLogout">${svg('door',14)}退出登录</button>
    </div>
  </div>
  <div class="card" style="margin-bottom:16px;border-color:color-mix(in srgb,${bad?'var(--warn)':'var(--ok)'} 30%,transparent)">
    <div class="card-bd row" style="gap:9px;align-items:flex-start">
      <span style="color:${bad?'var(--warn)':'var(--ok)'}">${svg(bad?'warn':'check',15)}</span>
      <span class="help" style="margin:0">${bad
        ?'当前密钥仍是示例默认串（含 <b>change-me</b>）——<b>建议立刻换一对新的</b>：点「随机生成」填进框内，再点「轮换」生效。'
        :'当前密钥不是示例默认值。'}${k.rotatedAt?'<br>控制台最近一次轮换：'+esc(String(k.rotatedAt).replace('T',' ').slice(0,19)):''}</span>
    </div>
  </div>
  <div class="grid g12">${keyCard('gateway')}${keyCard('admin')}</div>
  <div class="card" style="margin-top:16px"><div class="card-bd">
    <div class="help" style="margin:0"><b>谁说了算</b>：控制台轮换出来的值写在 <span class="mono">config.json</span> 的
    <span class="mono">auth</span> 段，<b>优先级高于 .env</b>；轮换之后改 .env 不再影响生效值，
    点「回到环境变量值」才会把控制权交还给它。「来源」角标显示当前值是从哪来的。<br>
    页面快照里只有掩码，明文一律点「显示」时现取一次；轮换响应里的新值只回给发起轮换的这个页面。</div>
  </div></div>`;
  for(const kind of ['gateway','admin']){
    const inp=$(`#ki_${kind}`,v);
    if(inp) inp.oninput=e=>{keyDraft[kind]=e.target.value;};
    const eye=$(`#ke_${kind}`,v); if(eye) eye.onclick=()=>toggleKeyReveal(kind);
    const cp=$(`#kc_${kind}`,v); if(cp) cp.onclick=()=>copyKeyValue(kind,cp);
    const g=$(`#kg_${kind}`,v); if(g) g.onclick=()=>fillGeneratedKey(kind);
    const s=$(`#ks_${kind}`,v); if(s) s.onclick=()=>rotateKey(kind,keyDraft[kind],s);
  }
  const r=$('#keyReset',v); if(r) r.onclick=()=>resetKeysAction(r);
  const out=$('#keyLogout',v); if(out) out.onclick=logout;
}
/* 危险动作点两下确认（旧密钥立即失效，误点一次就能让所有调用方 401） */
function armConfirm(btn,what){
  if(!btn) return true;
  if(btn.dataset.arm==='1') return true;
  btn.dataset.arm='1';
  const old=btn.innerHTML;
  btn.innerHTML=svg('warn',13)+'确认'+(what||'');
  setTimeout(()=>{ if(btn.isConnected){btn.dataset.arm='0';btn.innerHTML=old;} },6000);
  return false;
}
async function toggleKeyReveal(kind){
  if(keyReveal[kind]){ keyReveal[kind]=''; render(); return; }
  try{
    const r=await api(kind==='gateway'?'/admin/api/gateway-key':'/admin/api/admin-key');
    keyReveal[kind]=(kind==='gateway'?r.gatewayKey:r.adminKey)||'';
    render();
  }catch(e){ /* api() 已经 toast 过了 */ }
}
async function copyKeyValue(kind,btn){
  try{
    if(!keyReveal[kind]) await toggleKeyReveal(kind);
    if(!keyReveal[kind]){ toast('没取到密钥原文','bad'); return; }
    copyText(keyReveal[kind],btn);
  }catch(e){ /* api() 已经 toast 过了 */ }
}
/* 随机生成只在本地填进输入框（与服务端 genKey 同规格：48 位、大小写字母+数字+特殊字符四样齐全），
   不直接轮换——用户要先看到/复制新值，再点「轮换」确认生效 */
function genLocalKey(){
  const pools=['abcdefghjkmnpqrstuvwxyz','ABCDEFGHJKMNPQRSTUVWXYZ','23456789','-_.!@#%*+'];
  const all=pools.join('');
  const b=new Uint8Array(48); crypto.getRandomValues(b);
  const chars=pools.map((p,i)=>p[b[i]%p.length]);          // 每池先保底一个
  for(let i=4;i<48;i++) chars.push(all[b[i]%all.length]);
  for(let i=47;i>0;i--){ const j=b[(i+13)%48]% (i+1); const t=chars[i]; chars[i]=chars[j]; chars[j]=t; }  // 洗牌
  return chars.join('');
}
function fillGeneratedKey(kind){
  const k=genLocalKey();
  keyDraft[kind]=k;
  const inp=$(`#ki_${kind}`);
  if(inp) inp.value=k;
  toast('已生成并填入框内——确认无误后点「轮换」生效（旧值届时立即失效）');
}
async function rotateKey(kind,value,btn){
  if(keyBusy) return;
  if(!String(value||'').trim()){ toast('先填新密钥，或点「随机生成」','warn'); return; }
  const label=kind==='gateway'?'网关密钥':'管理密钥';
  // 用户明确要求：轮换单击直接生效（页面上方与按钮旁均已写明"旧密钥立即失效"）
  keyBusy=true;
  const old=btn.innerHTML; btn.disabled=true; btn.innerHTML=svg('clock',13)+'执行中…';
  try{
    const body=kind==='gateway'?{gatewayKey:value}:{adminKey:value};
    const r=await api('/admin/api/keys',{method:'POST',body:JSON.stringify(body)});
    // 换的是管理密钥：服务端已清空全部会话并在本响应里补发了新会话 cookie（Set-Cookie 由浏览器自动种下），
    // 这个页面不会把自己踢回登录门；其它标签页/设备下次请求 401，各自重新登录一次
    keyDraft[kind]=''; keyReveal[kind]='';
    toast(`${label}已轮换（旧值已立即失效）`);
    await reload();
    render();
  }catch(e){
    btn.disabled=false; btn.innerHTML=old; btn.dataset.arm='0';   // api() 已经 toast 过错误原文
  }finally{ keyBusy=false; }
}
async function resetKeysAction(btn){
  if(keyBusy) return;
  if(!armConfirm(btn,'交还控制权')) return;
  keyBusy=true;
  const old=btn.innerHTML; btn.disabled=true; btn.innerHTML=svg('clock',13)+'执行中…';
  try{
    await api('/admin/api/keys/reset',{method:'POST',body:'{}'});
    keyDraft={gateway:'',admin:''}; keyReveal={gateway:'',admin:''};
    toast('已回到「环境变量 → 首启生成」的密钥');
    await reload();
    render();
  }catch(e){
    btn.disabled=false; btn.innerHTML=old; btn.dataset.arm='0';
  }finally{ keyBusy=false; }
}

function vAccess(v){
  /* 全部取自 /admin/api/config，不写死端口与密钥：CFG.urls 由服务端按实际 PORT 拼好 */
  const u=(CFG&&CFG.urls)||{};
  const base=(u.openai||(location.origin+'/v1')).replace(/\/v1$/,'');
  const gwKey=(CFG&&CFG.gatewayKey)||'';   // 服务端只给掩码（v1.18.4），原文要复制时走 copyGwKey() 现取
  const m1=(DATA.models[0]||{}).name||'自定义别名';
  const m2=((DATA.models.find(m=>/claude/i.test(m.name))||{}).name)||m1;
  const eps=[
    {t:'OpenAI 协议',p:'openai',u:u.openai||base+'/v1',note:'/v1/chat/completions · /v1/models · /v1/embeddings'},
    {t:'Anthropic 协议',p:'anthropic',u:u.anthropic||base+'/anthropic',note:'/anthropic/v1/messages · 支持 stream'},
    {t:'Gemini 协议',p:'gemini',u:u.gemini||base+'/gemini/v1beta',note:'/gemini/v1beta/models/{m}:generateContent'}
  ];
  // 端点清单先记下来：密钥原文不在这份快照里，等用户点「复制全部」时再实时取一次拼上（v1.18.4）
  EP_COPY_TEXT=[...eps.map(e=>`${e.t}\t${e.u}`)].join('\n');
  v.innerHTML=`
  <div class="page-hd">
    <div><h1 class="page-title">接入信息</h1>
      <div class="page-sub">网关地址与密钥 · 三套协议端点共用同一个 GATEWAY_KEY</div></div>
    <div class="page-actions">
      <button class="btn" data-act="go" data-page="keys">${svg('key',14)}密钥管理</button>
      <button class="btn primary" data-act="copy-all-endpoints">${svg('copy',14)}复制全部</button>
    </div>
  </div>

  <div class="grid g3 stagger" style="margin-bottom:16px">
    ${eps.map(x=>`<div class="card"><div class="card-bd ep">
      <div class="row"><span class="chip ${esc(x.p)}">${esc(x.t)}</span><span class="dot ok ml-auto"></span></div>
      <div class="ep-url"><span style="flex:1;min-width:0">${x.u}</span>
        <button class="btn ghost sm" data-t="${esc(x.u)}" data-act="copy">${svg('copy',12)}复制</button></div>
      <div class="muted" style="font-size:11.5px">${esc(x.note)}</div>
      <div class="ep-key"><span>GATEWAY_KEY</span><span class="kval mono">${esc(gwKey||'—')}</span>
        <button class="btn ghost sm ml-auto" data-act="copy-gw-key">${svg('copy',13)}复制</button></div>
    </div></div>`).join('')}
  </div>

  <div class="card" style="margin-bottom:16px">
    <div class="card-hd"><h3>调用示例</h3>
      <div class="r"><div class="tabs" id="snipTabs">
        <button class="tab on" data-s="curl">cURL</button><button class="tab" data-s="python">Python</button><button class="tab" data-s="node">Node</button>
      </div></div>
    </div>
    <div class="card-bd">
      <div class="code"><div class="code-hd"><span class="fname" id="snipName">example.sh</span>
        <button class="btn ghost sm copy" id="snipCopy">${svg('copy',13)}复制</button></div>
        <pre id="snipBody">${SNIP.curl}</pre></div>
    </div>
  </div>

  <div class="grid g12">
    <div class="card c7">
      <div class="card-hd"><h3>客户端配置</h3><span class="sub">DSH / Cursor / Cline</span></div>
      <div class="card-bd tight tbl-wrap">
        <table class="tbl"><thead><tr><th>客户端</th><th>Base URL</th><th>模型名</th></tr></thead><tbody>
          ${[['DSH（OpenAI 兼容）',u.openai||base+'/v1',m1],['DSH（Anthropic 兼容）',u.anthropic||base+'/anthropic',m2],['Cursor',u.openai||base+'/v1','自定义别名'],['Cline',u.openai||base+'/v1','自定义别名']]
            .map(r=>`<tr><td class="cell-name">${r[0]}</td><td class="mono" style="font-size:12px"><span style="display:inline-flex;align-items:center;gap:7px">${r[1]}<button class="btn ghost sm" data-t="${esc(r[1])}" data-act="copy" title="复制地址">${svg('copy',12)}</button></span></td><td class="mono" style="font-size:12px">${esc(r[2])}</td></tr>`).join('')}
        </tbody></table>
      </div>
    </div>
    <div class="card c5">
      <div class="card-hd"><h3>管理端点</h3><span class="sub">需要 ADMIN_KEY</span></div>
      <div class="card-bd tight tbl-wrap">
        <table class="tbl"><thead><tr><th>路径</th><th>方法</th><th>说明</th></tr></thead><tbody>
          ${[['/console','GET','Web 控制台'],['/healthz','GET','存活探针（免鉴权）'],['/admin/api/status','GET','渠道状态'],['/admin/api/usage','GET','用量统计'],['/admin/api/recheck','POST','触发重探测'],['/admin/api/channel','POST','改优先级 / 启停']].map(r=>`<tr><td class="mono" style="font-size:12px">${r[0]}</td><td><span class="tag">${r[1]}</span></td><td class="muted" style="font-size:12px">${r[2]}</td></tr>`).join('')}
        </tbody></table>
      </div>
    </div>
  </div>

  ${(()=>{
    /* 只有密钥还是"公开可猜的默认串"时才报警；首启随机生成的密钥不会命中，不吓唬人 */
    // 密钥原文已不下发到前端，无法就地 /change-me/i 判断——由服务端算好 keysInsecure 给一个布尔
    const insecure=!!(CFG&&CFG.keysInsecure);
    return `<div class="card" style="margin-top:16px${insecure?';border-color:color-mix(in srgb,var(--warn) 34%,transparent)':''}">
    <div class="card-bd row" style="gap:12px;align-items:flex-start">
      <span style="color:var(--${insecure?'warn':'ok'})">${svg(insecure?'warn':'check',17)}</span>
      <div>
        <div style="font-weight:700;font-size:13.5px">${insecure?'安全提示':'密钥状态'}</div>
        <div class="muted" style="font-size:12.5px;margin-top:4px">${insecure
          ?'ADMIN_KEY / GATEWAY_KEY 仍是公开可猜的默认串，建议轮换成随机值：改 .env 的 ZZCSAPI_ADMIN_KEY / ZZCSAPI_GATEWAY_KEY（推荐），或删掉 config.json 里的 adminKey / gatewayKey 后重启（会自动重新生成）。主机端口是否收敛到 127.0.0.1 见 docker-compose.yml。'
          :'ADMIN_KEY 与 GATEWAY_KEY 均非仓库默认值（首启自动生成或你自定义的设置）。'}</div>
      </div>
      <button class="btn ml-auto" data-act="show-key-help">${insecure?'查看轮换步骤':'查看'}</button>
    </div>
  </div>`;
  })()}`;
  $$('#snipTabs .tab',v).forEach(t=>t.onclick=()=>{
    $$('#snipTabs .tab',v).forEach(x=>x.classList.remove('on'));t.classList.add('on');
    const s=t.dataset.s;
    $('#snipBody').innerHTML=SNIP[s];
    $('#snipName').textContent=s==='curl'?'example.sh':s==='python'?'example.py':'example.mjs';
    $('#snipCopy').onclick=function(){copyText($('#snipBody').textContent,this)};
  });
  $('#snipCopy').onclick=function(){copyText($('#snipBody').textContent,this)};
}
/* 密钥只能由服务端环境变量决定，控制台不写配置，所以这里给的是真实改法而不是假按钮。
   弹窗刻意做成「只读步骤清单」：每条命令单独一块、各自可复制，避免让人以为能在这里直接编辑保存。 */
function showKeyHelp(){
  const port=(CFG&&CFG.port)||location.port||8787;
  const steps=[
    {t:'在仓库根目录的 .env 写入新密钥（docker-compose 读的是 ZZCSAPI_ 前缀）',
     c:'ZZCSAPI_ADMIN_KEY=<新的管理密钥>\nZZCSAPI_GATEWAY_KEY=<新的网关密钥>'},
    {t:'重建并重启容器，新密钥才生效',c:'docker compose up -d --force-recreate'},
    {t:'用新 ADMIN_KEY 重新进入控制台：打开 /console 粘贴一次即可——换回 12 小时会话 cookie，浏览器不再存密钥本身（v1.18.6 起 ?key= 已停用）',
     c:`http://127.0.0.1:${port}/console`},
  ];
  modal(`
    <div class="m-hd"><span class="m-ico">${svg('key',14)}</span><h2>轮换密钥</h2>
      <span class="chip ml-auto" style="margin-right:8px">只读</span>
      <button class="icon-btn" data-act="close-modal">${svg('x',15)}</button></div>
    <div class="m-bd">
      <div class="card" style="padding:11px 13px;border-color:color-mix(in srgb,var(--warn) 30%,transparent)">
        <div class="row" style="gap:9px;align-items:flex-start">
          <span style="color:var(--warn)">${svg('warn',15)}</span>
          <span class="help" style="margin:0">想<b>在线轮换</b>请去侧栏「工具 → 密钥管理」，点一下就生效、不用重启容器。
            下面这套是<b>命令行</b>做法，适合没有控制台、或想改 <span class="mono">.env</span> 里那个"初始值"的情况
            ——注意：如果之前用控制台轮换过，<b>.env 说了不算</b>，得先「回到环境变量值」。</span>
        </div>
      </div>
      ${steps.map((s,i)=>`
        <div class="field">
          <span class="help" style="display:block;margin-bottom:6px">${i+1}. ${s.t}</span>
          <div class="code"><div class="code-hd"><span class="fname">step ${i+1}</span>
            <button class="btn ghost sm copy" data-t="${esc(s.c)}" data-act="copy">${svg('copy',13)}复制</button></div>
          <pre>${esc(s.c)}</pre></div>
        </div>`).join('')}
      <div class="field"><span class="help">⚠ 只改 GATEWAY_KEY 不影响已登录的控制台；改 ADMIN_KEY 后所有已登录的会话全部作废，每个浏览器都要用新值重新粘一次。</span></div>
    </div>
    <div class="m-ft"><button class="btn ghost ml-auto" data-act="close-modal">关闭</button></div>`);
}

/* ═══════════════════════════ 弹窗：通用容器 ═══════════════════════════ */
function modal(html,wide){
  const box=$('#modalBox');
  box.className='modal'+(wide?' wide':'');
  box.innerHTML=html;
  $('#mask').classList.add('on');
  box.scrollTop=0;
}
function closeModal(){$('#mask').classList.remove('on')}
function setStatus(el,text,cls){if(!el)return;el.className='status-line '+(cls||'');el.textContent=text}
function toggleMenu(id){const m=document.getElementById(id);if(!m)return;const on=m.classList.contains('on');$$('.menu.on').forEach(x=>x.classList.remove('on'));m.classList.toggle('on',!on)}
document.addEventListener('click',e=>{if(!e.target.closest('.menu-wrap'))$$('.menu.on').forEach(m=>m.classList.remove('on'))});

/* ═══════════════════════════ 渠道：协议元数据 / 派生字段 ═══════════════════════════ */
const PROTO_META={
  openai:{label:'OpenAI 兼容',base:'',key:'中转站 / 官方 v1 的 API Key（sk- 开头）'},
  anthropic:{label:'Anthropic',base:'',key:'Anthropic API Key（sk-ant- 开头）'},
  gemini:{label:'Gemini',base:'',key:'Google AI Studio 的 API Key'},
  notion:{label:'Notion 逆向',base:'https://app.notion.com',key:'浏览器 F12 → Application → Cookies → app.notion.com → 复制 token_v2 的完整值'},
  'notion-agent':{label:'Notion Agent',base:'https://api.notion.com',key:'开发者门户集成令牌（ntn_ 开头，连接需勾选「查看会话并与代理交互」）'},
  workbuddy:{label:'WorkBuddy',base:'https://www.workbuddy.ai/v2',key:'CodeBuddyExtension auth 文件里 auth.accessToken 的 JWT（ey 开头、三段点分，勿填 refreshToken）。注：新版 CodeBuddy 已把该字段加密成 envelope（$wbEncrypted / ciphertext）——那不是 JWT、填了会被当场拒，需从客户端实际请求里取明文 token'},
  codex:{label:'Codex 订阅反代',base:'https://chatgpt.com/backend-api/codex',key:'ChatGPT 订阅的 refresh token（rt.1. 开头）。RT 一次性轮转，每次刷新自动写回新值'},
  genspark:{label:'Genspark 网页会话',base:'https://www.genspark.ai',key:'网页会话 session_id 的完整值（uuid:hex，F12 → Cookies → www.genspark.ai → session_id）。代理必填'},
  hark:{label:'hark 网页会话',base:'https://hark.com',key:'F12 → Application → Cookies → hark.com → 复制 __Secure-hark.session_token 的完整值（含 %2F/%3D 转义，**别解码**）。本机直连会被 CF 403 → 代理填 http://127.0.0.1:7897（Node/curl 不读系统代理）。上游只有一个 agent，模型别名随便起（如 hark-agent）；工具走文本仿真，可调客户端工具'}
};
const PROTO_ORDER=['openai','anthropic','gemini','notion','notion-agent','workbuddy','codex','genspark','hark'];

/* 密钥来自 /admin/api/status 下发的渠道明文 key，控制台默认掩码、按需明文显示 */
function chKey(id){const c=DATA.channels.find(x=>x.id===id);return (c&&c.apiKey)||''}
/* v1.18.4：管理面默认只下发掩码（一次 GET 不再等于全部密钥失守），原文改成"点一下取一条"。
   chKey() 给的是掩码，chKeyLive() 才是原文；网关密钥同理走 gwKeyLive() 并按页缓存。 */
let EP_COPY_TEXT='';   // 「接入信息」页的端点清单（复制全部时和实时密钥拼在一起）
let _gwk=null;
async function chKeyLive(id){const j=await api('/admin/api/channels/'+encodeURIComponent(id)+'/key');return (j&&j.apiKey)||''}
async function gwKeyLive(){if(_gwk!==null)return _gwk;try{const j=await api('/admin/api/gateway-key');_gwk=(j&&j.gatewayKey)||''}catch(e){_gwk=''}return _gwk}
async function copyChKey(id,btn){try{const k=await chKeyLive(id);if(!k)return toast('这个渠道没有配密钥','warn');await copyText(k,btn)}catch(e){toast('取密钥原文失败：'+(e&&e.message||e),'bad')}}
async function copyGwKey(btn){try{const k=await gwKeyLive();if(!k)return toast('网关没设密钥（免鉴权模式）','warn');await copyText(k,btn)}catch(e){toast('取网关密钥失败：'+(e&&e.message||e),'bad')}}
async function copyAllEndpoints(btn){try{const k=await gwKeyLive();await copyText(EP_COPY_TEXT+'\nGATEWAY_KEY\t'+(k||'（未设置）'),btn)}catch(e){toast('复制失败：'+(e&&e.message||e),'bad')}}
const maskKey=k=>{k=String(k||'');if(!k)return '—';if(k.length<=12)return k.slice(0,3)+'••••';return k.slice(0,7)+'•'.repeat(Math.min(20,k.length-11))+'•'+k.slice(-4)};
const chBaseUrl=c=>c.baseUrl||(PROTO_META[c.proto]||{}).base||'—';
const chAliases=c=>(c.aliases||[]).map(r=>({alias:r.alias,upstream:r.upstream}));
/* 渠道自定义请求头 → 表单文本。接口下发的是对象，表单收的是 "Name: value" 多行文本。
   v1.18.44 现场：这个框此前**从不回填**，于是「获取模型」发出去的探测不带 User-Agent，
   AgentRouter 直接 401 unauthorized client detected（实测带它认的 UA 才回 200）。 */
const headersTextOf=c=>{const h=c&&c.headers;if(!h)return '';if(typeof h==='string')return h;
  return Object.entries(h).map(([k,v])=>`${k}: ${v}`).join('\n');};

/* ═══════════════════════════ 弹窗：添加 / 编辑渠道 ═══════════════════════════ */
let modalChId=null, modalModels=[];
function openChannelForm(id){
  const c=id?DATA.channels.find(x=>x.id===id):null;
  modalChId=c?c.id:null;
  modalModels=c?chAliases(c).map(r=>({...r})):[];
  probeFound=[]; probeSel=new Set(); probeQ='';
  const proto=c?c.proto:'openai', pm=PROTO_META[proto];
  modal(`
    <div class="m-hd">
      <span class="m-ico">${svg(c?'edit':'plus',14)}</span>
      <h2>${c?'编辑渠道 · '+esc(c.name||c.id):'添加渠道'}</h2>
      <button class="icon-btn ml-auto" data-act="close-modal">${svg('x',15)}</button>
    </div>
    <div class="m-bd">
      <div class="field-row">
        <div class="field" style="flex:1.7"><label>渠道 ID <span class="help">英文 / 数字 / _ / -</span></label>
          <input class="input" id="f-id" value="${esc(c?c.id:'')}" placeholder="vendor-x" ${c?'disabled':''}></div>
        <div class="field"><label>显示名称</label>
          <input class="input" id="f-name" value="${esc(c?c.name:'')}" placeholder="中转 X"></div>
      </div>
      <div class="field-row">
        <div class="field" style="flex:1.5"><label>协议</label>
          <select class="select" id="f-proto">${PROTO_ORDER.map(p=>`<option value="${p}" ${p===proto?'selected':''}>${PROTO_META[p].label}（${p}）</option>`).join('')}</select></div>
        <div class="field" style="flex:.7"><label>优先级</label>
          <input class="input" id="f-pri" type="number" value="${c?c.pri:0}"></div>
        <div class="field" style="flex:.7"><label>权重 <span class="help">0 = 不参与</span></label>
          <input class="input" id="f-weight" type="number" min="0" step="1" value="${c?(c.w||0):0}" title="加权轮询：同一模型的候选里按权重比例分流（3:1 ⇒ ≈75%/25%）。0 或不填 = 不参与分流，只按优先级做兜底。与优先级分工不同：优先级管「谁先试」，权重管「按比例分」"></div>
        <div class="field" style="flex:.7"><label>启用</label>
          <select class="select" id="f-on"><option value="1" ${(c?c.on:true)?'selected':''}>是</option><option value="0" ${(c?!c.on:false)?'selected':''}>否</option></select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>首字死线 (ms) <span class="help">留空 = 默认（有候选 30s / 末位 60s）</span></label>
          <input class="input" id="f-fcms" type="number" min="1000" max="300000" step="100" value="${esc(msTextOf(c,'fcMs'))}" placeholder="例：8000" title="上游多久没回响应头就换下一家。挂死或很慢的家配小值（例 8000），它就会被**快速跳过**，而不是白等 30~60 秒。0 不是「不超时」——留空才是回默认"></div>
        <div class="field"><label>总超时 (ms) <span class="help">留空 = 默认（90s 起）</span></label>
          <input class="input" id="f-toms" type="number" min="1000" max="600000" step="1000" value="${esc(msTextOf(c,'toMs'))}" placeholder="例：120000" title="这家渠道一次请求的总死线（只影响这家）。正常渠道不必配；给慢家配小值可以更早放弃它"></div>
      </div>
      <div class="field"><label>Base URL <span class="help">${pm.base?'默认 '+pm.base:'按上游填写'}</span></label>
        <input class="input" id="f-base" value="${esc(c?chBaseUrl(c):'')}" placeholder="https://api.example.com/v1"></div>
      <div class="field"><label>代理 <span class="help">可选；codex / genspark 必填；openai / anthropic / gemini / workbuddy 填了即生效（经代理转发，流式响应会整体缓冲后一次性回放）；notion 系不支持。如 http://host.docker.internal:7897（容器经宿主机代理出网）</span></label>
        <input class="input" id="f-proxy" value="${esc(c&&c.proxy||'')}" placeholder="留空 = 直连"></div>
      <div class="field"><label>自定义请求头 <span class="help">可选，每行一条 <code>Name: value</code>；Authorization 不可覆盖</span></label>
        <textarea class="input" id="f-headers" rows="2" placeholder="User-Agent: claude-cli/2.0.0 (external, cli)">${esc(headersTextOf(c))}</textarea></div>
      <div class="field"><label>不发这些参数 <span class="help">逗号或空格分隔；出站前从这家渠道的请求报文里删掉这几个参数（上游对某个参数组合直接 400 时用，例如 tools + reasoning_effort）</span></label>
        <input class="input" id="f-drop" value="${esc(dropParamsOf(c))}" placeholder="留空 = 一个都不删；例：reasoning_effort, temperature">
        ${dropChipsHtml()}</div>
      <div class="field"><label>API Key</label>
        <div class="row" style="gap:8px">
          <input class="input" id="f-key" type="password" value="" autocomplete="new-password" placeholder="${c?'已配置 ' + esc(chKey(c.id)||'（未设置）') + ' · 留空保持不变':'sk-… 或 notion 的 token_v2'}">
          <button class="btn ghost sm" id="f-key-btn" style="flex:0 0 auto" data-act="toggle-key-field">${svg('eye',13)}明文</button>
        </div>
        <span class="help" id="f-key-help">${pm.key}</span></div>
      <div class="field">
        <label>模型 <span class="help" id="modelsCount">${modalModels.length} 个</span></label>
        <div class="probe-bar">
          <button class="btn ghost sm" data-act="add-model-row">${svg('plus',13)}添加一行</button>
          <button class="btn ghost sm" id="f-probe" data-act="probe-upstream">${svg('test',13)}从上游探测更多</button>
          <span class="status-line ml-auto" id="probeStatus"></span>
        </div>
        <div class="models-box" id="modelsEditor"></div>
        <div class="probe-panel" id="probePanel" style="display:none"></div>
      </div>
      <div class="field"><label class="toggle"><input type="checkbox" id="f-autoAlias" ${c&&c.autoAlias?'checked':''}> 自动路由上游所有模型 <span class="help">（不勾则只暴露上表所列）</span></label></div>
    </div>
    <div class="m-ft">
      <button class="btn ghost ml-auto" data-act="close-modal">取消</button>
      <button class="btn primary" data-act="save-channel">${svg('check',13)}保存渠道</button>
    </div>`);
  renderModelRows();
  $('#f-proto').onchange=e=>{
    const p=e.target.value, m=PROTO_META[p];
    const cur=$('#f-base').value.trim();
    const isDefault=!cur||Object.values(PROTO_META).some(x=>x.base===cur);
    if(m.base&&isDefault)$('#f-base').value=m.base;
    $('#f-base').previousElementSibling.querySelector('.help').textContent=m.base?'默认 '+m.base:'按上游填写';
    $('#f-key-help').textContent=m.key;
    renderModelRows();
  };
}
function renderModelRows(){
  const box=$('#modelsEditor'); if(!box)return;
  const upLabel=$('#f-proto').value==='notion-agent'?'上游智能体名称':'上游真实模型';
  box.innerHTML=modalModels.length
    ? `<div class="model-row head"><div>对外名称 alias</div><div>${upLabel}</div><div></div><div></div></div>`+modalModels.map((r,i)=>`<div class="model-row" data-i="${i}">
        <input data-k="alias" value="${esc(r.alias)}" placeholder="alias">
        <input data-k="upstream" value="${esc(r.upstream)}" placeholder="upstream model">
        <button class="tst" title="测试此模型" data-act="test-row-model" data-idx="${i}">测</button>
        <button class="del" title="删除" data-act="del-model-row" data-idx="${i}">×</button>
      </div>`).join('')
    : '<div class="model-empty">还没有模型<br><span class="help">点「添加一行」手动加，或「从上游探测更多」批量拉取</span></div>';
  $('#modelsCount').textContent=modalModels.length+' 个';
  $$('#modelsEditor .model-row:not(.head)').forEach(row=>{
    const i=Number(row.dataset.i);
    $$('input',row).forEach(inp=>inp.oninput=()=>{modalModels[i][inp.dataset.k]=inp.value});
  });
}
function addModelRow(){
  modalModels.push({alias:'',upstream:''});
  renderModelRows();
  const rows=$$('#modelsEditor .model-row:not(.head)');
  rows[rows.length-1]?.querySelector('input')?.focus();
}
function delModelRow(i){modalModels.splice(i,1);renderModelRows();if(probeShown())renderProbeList()}
let probeFound=[],probeSel=new Set(),probeQ='';
const probeShown=()=>$('#probePanel')?.style.display!=='none';
async function probeUpstream(){
  const base=$('#f-base').value.trim();
  let key=$('#f-key').value.trim();   // 编辑已有渠道且没重填时，按需取一次原文（v1.18.4）；.trim() 与保存路径(2198)对齐——v1.18.19 现场教训：粘贴尾巴的换行没 trim，「从上游探测」把带尾随换行的钥匙发给上游吃 401 Invalid token（库里存的钥匙其实一直是好的）
  if(!key&&modalChId){try{key=await chKeyLive(modalChId)}catch(e){}}
  const st=$('#probeStatus'), btn=$('#f-probe');
  if(!base)return setStatus(st,'先填 Base URL','bad');
  if(!key)return setStatus(st,'先填 API Key（或用抽屉里的明文按钮取一次）','bad');
  btn.disabled=true; btn.innerHTML=svg('test',13)+'探测中…';
  setStatus(st,'请求上游 /v1/models …','wait');
  try{
    const r=await api('/admin/api/probe',{method:'POST',body:JSON.stringify({
      baseUrl:base,apiKey:key,protocol:$('#f-proto').value,
      proxy:$('#f-proxy').value.trim()||undefined,
      headers:$('#f-headers').value,models:Object.fromEntries(modalModels.filter(r=>r.alias&&r.upstream).map(r=>[r.alias,r.upstream])),   // v1.18.49：把表单当前别名表也发给探测——无模型目录的协议（hark/workbuddy/genspark/codex）靠它决定"回报已配别名"还是"给一条默认建议"。**故意并进这一行**：app.js 每增删 1 行都要重算代码地图 §0.2 的锚点
    })});
    if(!r.ok){setStatus(st,'✗ '+(r.error||'探测失败'),'bad');return}
    probeFound=(r.models||[]).slice().sort();
    probeSel=new Set(); probeQ='';
    const extra=r.agents?`（智能体 ${r.agents.length} 个）`:(r.account&&r.account.spaces?`（空间 ${r.account.spaces.length} 个）`:'');
    setStatus(st,`✓ ${probeFound.length} 个${extra} · ${r.latencyMs} ms${r.account&&r.account.note?` · ${r.account.note}`:''}`,'ok');   // v1.18.49：把「上游为什么没有模型目录」的说明也显示出来（workbuddy/genspark/codex/hark 都会带 account.note）；否则用户只看到一条建议、不知道依据。就地改一行保行数（避免 console.html 的 JS 偏移重算）
    renderProbeList();
    $('#probePanel')?.scrollIntoView({block:'nearest'});
  }catch(e){
    setStatus(st,'✗ '+(e.message||e),'bad');
  }finally{
    btn.disabled=false; btn.innerHTML=svg('test',13)+'重新探测';
  }
}
function renderProbeList(){
  const box=$('#probePanel'); if(!box)return;
  const have=new Set(modalModels.flatMap(r=>[r.alias,r.upstream]).filter(Boolean));
  [...probeSel].forEach(m=>{if(have.has(m))probeSel.delete(m)});
  box.style.display='';
  box.innerHTML=`
    <div class="pp-hd">
      <span class="t">探测到 ${probeFound.length} 个</span>
      <div class="pp-search">${svg('filter',12)}<input id="probeQ" value="${esc(probeQ)}" placeholder="搜索模型名…"></div>
    </div>
    <div class="pp-list">${probeFound.map(m=>{
      const has=have.has(m);
      return `<label class="pp-row${has?' have':''}" data-m="${esc(m)}" title="${esc(m)}">
        <input type="checkbox" ${probeSel.has(m)?'checked':''} ${has?'disabled':''}>
        <span class="nm">${esc(m)}</span>${has?'<span class="tag2">已在表中</span>':''}
      </label>`}).join('')}</div>
    <div class="pp-ft">
      <span class="sel" id="probeSelCnt"></span>
      <button class="btn ghost sm ml-auto" data-act="probe-select-all">全选</button>
      <button class="btn ghost sm" data-act="probe-clear-sel">清空</button>
      <button class="btn primary sm" id="probeAddBtn" data-act="probe-add-selected">${svg('plus',13)}加入所选</button>
    </div>`;
  const qi=$('#probeQ',box);
  qi.oninput=()=>{probeQ=qi.value;filterProbeRows()};
  $$('.pp-row',box).forEach(row=>{
    const cb=$('input',row);
    cb.onchange=()=>{cb.checked?probeSel.add(row.dataset.m):probeSel.delete(row.dataset.m);updateProbeSel()};
  });
  filterProbeRows();
}
function filterProbeRows(){
  const box=$('#probePanel'); if(!box)return;
  const q=probeQ.trim().toLowerCase();
  $$('.pp-row',box).forEach(row=>row.style.display=(!q||row.dataset.m.toLowerCase().includes(q))?'':'none');
  updateProbeSel();
}
function updateProbeSel(){
  const box=$('#probePanel'); if(!box)return;
  const n=probeSel.size, cnt=$('#probeSelCnt',box), btn=$('#probeAddBtn',box);
  if(cnt)cnt.textContent=n?`已选 ${n} 个`:'勾选要加入的模型';
  if(btn)btn.disabled=!n;
}
function probeSelectAll(){
  const box=$('#probePanel'); if(!box)return;
  $$('.pp-row',box).forEach(row=>{
    if(row.style.display==='none')return;
    const cb=$('input',row); if(cb.disabled)return;
    cb.checked=true; probeSel.add(row.dataset.m);
  });
  updateProbeSel();
}
function probeClearSel(){
  const box=$('#probePanel'); if(!box)return;
  $$('.pp-row',box).forEach(row=>{$('input',row).checked=false});
  probeSel.clear(); updateProbeSel();
}
function probeAddSelected(){
  const names=[...probeSel]; if(!names.length)return;
  const existing=new Set(modalModels.flatMap(r=>[r.alias,r.upstream]).filter(Boolean));
  let n=0;
  for(const m of names){if(existing.has(m))continue;modalModels.push({alias:m,upstream:m});existing.add(m);n++}
  probeSel.clear();
  renderModelRows(); renderProbeList();
  toast(n?`已加入 ${n} 个模型`:'所选模型都已在表中',n?'ok':'');
}
function testRowModel(i){
  const row=modalModels[i]; if(!row)return;
  if(!modalChId)return toast('先保存渠道再测试该模型');
  if(!row.upstream)return toast('上游模型名为空');
  closeModal();
  openTestModels({channelId:modalChId,only:row.alias||row.upstream});
}
async function toggleKeyField(){
  const inp=$('#f-key'), btn=$('#f-key-btn');
  const show=inp.type==='password';
  if(show&&!inp.value.trim()&&modalChId){
    // 表单不再回填原文（v1.18.4 管理面只下发掩码），所以输入框是空的：
    // 首次点「明文」时现取一次真密钥填进来，否则点了也看不到东西。
    // 取到的是**当前密钥本身**，不修改直接保存等于原样写回，不会造成改动。
    try{
      const k=await chKeyLive(modalChId);
      if(k){inp.value=k;toast('已载入当前密钥（只看不改，保存后仍原样）','ok')}
      else toast('这个渠道没有配密钥','warn');
    }catch(e){toast('取密钥原文失败：'+(e&&e.message||e),'bad');return}
  }
  inp.type=show?'text':'password';
  btn.innerHTML=svg(show?'eyeOff':'eye',13)+(show?'隐藏':'明文');
}
async function saveChannel(){
  const id=($('#f-id').value||'').trim();
  const base=$('#f-base').value.trim();
  const key=$('#f-key').value.trim();
  if(!id)return toast('渠道 ID 必填');
  if(!/^[A-Za-z0-9_-]+$/.test(id))return toast('渠道 ID 只能用英文 / 数字 / _ / -');
  if(!modalChId&&DATA.channels.some(c=>c.id===id))return toast('渠道 ID「'+id+'」已存在');
  if(!base)return toast('Base URL 必填');
  if(!key&&!modalChId)return toast('API Key 必填');   // 编辑已有渠道时留空 = 保持原密钥（v1.18.4）
  // 权重：加权轮询用。空 = 0（不参与）；非数字/负数直接挡在这里，别等后端 400
  const wRaw=($('#f-weight').value||'').trim();
  const weight=wRaw===''?0:Number(wRaw);
  if(!Number.isFinite(weight)||weight<0)return toast('权重必须是不小于 0 的数字（留空 = 0 = 不参与加权轮询）');
  /* 渠道级超时字段（v1.18.46）：空框 = 回默认（合法），非空就必须是值域内的整数。
     在后端 400 之前先挡一道——但**只挡明显错误**：真正的门槛仍在 validateChannelDef（值域只有一份）。 */
  const msField=(sel,label,min,max)=>{
    const raw=($(sel).value||'').trim();
    if(raw==='')return{ok:true,value:''};
    const n=Number(raw);
    if(!Number.isInteger(n)||n<min||n>max)return{ok:false,msg:label+'必须是 '+min+'~'+max+' 之间的整数毫秒（留空 = 用默认；0 不是「不超时」）'};
    return{ok:true,value:String(n)};
  };
  const fcms=msField('#f-fcms','首字死线',1000,300000); if(!fcms.ok)return toast(fcms.msg);
  const toms=msField('#f-toms','总超时',1000,600000); if(!toms.ok)return toast(toms.msg);
  const seen=new Set(), models={};
  for(const r of modalModels){
    const alias=(r.alias||'').trim(), up=(r.upstream||'').trim();
    if(!alias&&!up)continue;
    if(!up)return toast('alias「'+alias+'」缺上游模型名');
    const a=alias||up;
    if(seen.has(a))return toast('重复 alias：'+a);
    seen.add(a); models[a]=up;
  }
  const body={
    id,
    name:$('#f-name').value.trim()||id,
    baseUrl:base,
    apiKey:key||undefined,   // undefined 会被 JSON.stringify 丢掉 → 服务端沿用原密钥
    protocol:$('#f-proto').value,
    priority:Number($('#f-pri').value)||0,
    weight,
    enabled:$('#f-on').value==='1',
    autoAlias:$('#f-autoAlias').checked,
    proxy:$('#f-proxy').value.trim()||undefined,
    headers:$('#f-headers').value,
    /* 渠道级「不发这些参数」（v1.18.33）：**总是**提交这个字段——框空 = 显式 `[]` = 清空。
       刻意与上面几个字段的 `||undefined`（"留空 = 不动"）不同：服务端对 dropParams 的语义是
       "传了空数组就清空、压根不传才沿用旧值"，前端若不发，用户就永远清不掉已配的清单。
       这里不做白名单校验（前端只做"挡住明显错误"这类便宜检查）——合法名清单由服务端下发用于**提示**，
       真正的准入门槛在后端 validateChannelDef，写错名字会 400 并把合法清单原文回显给用户。 */
    dropParams:($('#f-drop').value||'').split(/[\s,]+/).map(s=>s.trim()).filter(Boolean),
    /* 渠道级超时字段（v1.18.46）：**总是**提交这两个字段——框空 = 显式 `''` = 回默认。
       语义与 dropParams 同款（三态）：服务端只认"显式空值才清空"，前端不发就永远清不掉已配的值。 */
    firstChunkTimeoutMs:fcms.value,
    timeoutMs:toms.value,
    models,
  };
  const btn=$('.m-ft .btn.primary');
  if(btn){btn.disabled=true;btn.textContent='保存中…'}
  try{
    const r=await api('/admin/api/channels',{method:'POST',body:JSON.stringify(body)});
    closeModal();
    toast(`✓ 已${r.existed?'更新':'创建'}渠道 ${id} · 正在后台探测`,'ok');
    await loadAll();
  }catch(e){
    if(btn){btn.disabled=false;btn.innerHTML=svg('check',13)+'保存渠道'}
  }
}

/* ═══════════════════════════ 弹窗：导入（Codex RT / Codex JSON / Genspark） ═══════════════════════════ */
const IMPORT_META={
  'codex-rt':{ico:'zap',title:'导入 Codex RT',mode:'paste',label:'Refresh Token',ph:'rt.1.…',
    hint:'rt.1. 开头，与 sub2api「手动导入 RT」同款。',
    steps:'粘贴后自动完成：换令牌 → 拿账号 → 拉订阅模型列表 → 建渠道。',
    warn:'RT 一次性轮转：导入后这份字符串即作废。同一个号别同时挂 sub2api 和这里，谁刷新谁活。',
    bad:v=>/^rt\.1\./.test(v)?'':'Refresh Token 应以 rt.1. 开头'},
  'codex-json':{ico:'file',title:'导入 Codex JSON',mode:'file',accept:'.json,application/json',
    hint:'选择 sub2api 导出的 codex JSON（含 access_token / refresh_token），支持多选批量导入。',
    warn:'兼容三种结构：扁平 {refresh_token} · {credentials:{…}} · {accounts:[{credentials:{…}}]}。'},
  'gs-session':{ico:'cookie',title:'导入 Genspark 会话',mode:'paste',label:'会话 JSON / session_id',ph:'{"sessionId":"xxxxxxxx-…:hex…"}',
    hint:'Claw session.enc 内容、整段 cookie、或裸 session_id 均可。',
    steps:'自动提取 sessionId 换成渠道 key，并免费验证登录（is_login，不耗积分）。',
    warn:'只用 sessionId，JSON 里的 gsk- apiKey 不需要。session 约 20 天过期，过期后重新登录再导一份。',
    bad:v=>parseGsSessionId(v)?'':'没找到 sessionId（uuid:hex 格式）'},
  'gs-json':{ico:'file',title:'导入 Genspark JSON',mode:'file',accept:'.json,.txt,application/json,text/plain',
    hint:'选择 genspark 会话 JSON 文件，支持多选批量：每个新会话自动建一个新渠道（多号 = 多份每日积分）。',
    warn:'同一 key 视为刷新会话，不会重复建渠道。'}
};
function parseCodexUnits(j){
  const has=o=>o&&(o.access_token||o.refresh_token);
  const list=Array.isArray(j.accounts)?j.accounts:(Array.isArray(j.data)?j.data:null);
  if(has(j))return [j];
  if(has(j.credentials))return [j.credentials];
  if(list)return list.map(a=>(a&&a.credentials)||a).filter(has);
  return [];
}
function parseGsSessionId(raw){
  const s=String(raw);
  const m=s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::[0-9a-f]{8,})?/i);
  if(m)return m[0];
  const m2=s.match(/"sessionId"\s*:\s*"([^"]+)"/i)||s.match(/session_id\s*[:=]\s*"?([A-Za-z0-9:\-_.]+)/i);
  return m2?m2[1]:null;
}
function openImport(kind){
  const m=IMPORT_META[kind];
  const body=m.mode==='paste'
    ? `<div class="field"><label>${m.label} <span class="help">${m.hint}</span></label>
         <textarea class="input" id="impText" rows="3" placeholder="${esc(m.ph)}"></textarea></div>
       ${m.steps?`<div class="field"><span class="help">${m.steps}</span></div>`:''}
       <div class="field"><span class="help">⚠ ${m.warn}</span></div>
       <div class="field"><span class="status-line" id="impStatus"></span></div>`
    : `<label class="drop" for="impFile">
         <span class="d-ico">${svg('upload',16)}</span>
         <span>点击选择文件（可多选批量导入）</span>
         <span class="d-sub">${esc(m.accept)}</span>
       </label>
       <input type="file" id="impFile" class="hide" accept="${m.accept}" multiple data-change="import-files" data-kind="${kind}">
       <div class="field"><span class="help">${m.hint}</span></div>
       <div class="field"><span class="help">⚠ ${m.warn}</span></div>
       <div class="field"><span class="status-line" id="impStatus"></span></div>
       <div class="field" id="impFilesWrap" style="display:none"><label>处理结果</label><div class="test-out" id="impFiles"></div></div>`;
  modal(`
    <div class="m-hd">
      <span class="m-ico">${svg(m.ico,14)}</span>
      <h2>${m.title}</h2>
      <button class="icon-btn ml-auto" data-act="close-modal">${svg('x',15)}</button>
    </div>
    <div class="m-bd">${body}</div>
    <div class="m-ft">
      <button class="btn ghost ml-auto" data-act="close-modal">取消</button>
      ${m.mode==='paste'
        ? `<button class="btn primary" id="impGo" data-act="do-import" data-kind="${kind}">${svg('upload',13)}导入</button>`
        : `<button class="btn primary" data-act="pick-import-file">${svg('upload',13)}选择文件</button>`}
    </div>`);
  if(m.mode==='paste')setTimeout(()=>$('#impText')?.focus(),60);
}
/* 真导入：Codex RT 与 Genspark 会话各打自己的端点，返回体统一收敛成 {label,detail}，
   便于同一套 UI 渲染。两端点在失败时都返回 HTTP 200 + {ok:false,error}，必须显式判 ok。 */
async function importCodexRt(rt){
  const r=await api('/admin/api/codex-import',{method:'POST',body:JSON.stringify({rt})});
  if(!r||r.ok===false)throw new Error((r&&r.error)||'导入失败');
  return {label:r.id,detail:`${(r.models||[]).length} 个模型${r.rotated?' · RT 已轮转存新值':''}`};
}
async function importGsSession(raw){
  const r=await api('/admin/api/genspark-import',{method:'POST',body:JSON.stringify({raw,mode:'add'})});
  if(!r||r.ok===false)throw new Error((r&&r.error)||'导入失败');
  if(r.hint)throw new Error(r.hint);
  return {label:r.id,detail:`${r.created?'新建渠道':'刷新已有渠道'}${r.email?' · '+r.email:''}${r.login?' · 登录验证通过':' · ⚠ 登录验证失败，检查该渠道 proxy'}`};
}
async function doImport(kind){
  const m=IMPORT_META[kind];
  const raw=($('#impText').value||'').trim();
  const st=$('#impStatus'), btn=$('#impGo');
  if(!raw)return setStatus(st,'先粘贴内容','bad');
  const bad=m.bad&&m.bad(raw);
  if(bad)return setStatus(st,'✗ '+bad,'bad');
  btn.disabled=true; const old=btn.innerHTML; btn.innerHTML=svg('upload',13)+'导入中…';
  setStatus(st,kind==='gs-session'?'⏳ 换取渠道 key 并免费验证登录…':'⏳ 换令牌 → 拉账号 → 拉模型 → 建渠道…','wait');
  try{
    const r=kind==='gs-session'?await importGsSession(raw):await importCodexRt(raw);
    setStatus(st,`✓ 已导入 → 渠道 ${r.label} · ${r.detail}`,'ok');
    toast(`✓ 已导入渠道 ${r.label}`,'ok');
    await loadAll();
  }catch(e){
    setStatus(st,'✗ '+String((e&&e.message)||e),'bad');
  }finally{
    btn.disabled=false; btn.innerHTML=old;
  }
}
async function importFiles(kind,input){
  const files=Array.from(input.files||[]);
  input.value='';
  if(!files.length)return;
  const st=$('#impStatus'), out=$('#impFiles'), wrap=$('#impFilesWrap');
  const isGs=kind==='gs-json';
  wrap.style.display=''; out.innerHTML='';
  let ok=0,bad=0;
  for(let i=0;i<files.length;i++){
    const f=files[i];
    setStatus(st,`⏳ ${i+1}/${files.length} ${f.name}`,'wait');
    let row;
    try{
      const text=await f.text();
      if(isGs){
        const r=await importGsSession(text);
        ok++;
        row=`<div class="r ok"><span>${svg('check',12)}</span><span>${esc(f.name)}</span><span class="e">渠道 ${esc(r.label)} · ${esc(r.detail)}</span></div>`;
      }else{
        const units=parseCodexUnits(JSON.parse(text));
        if(!units.length)throw new Error('文件里找不到 access_token / refresh_token');
        const withRt=units.filter(u=>u.refresh_token);
        if(!withRt.length)throw new Error(units.length+' 个账号均缺少 refresh_token');
        const ids=[];
        for(const u of withRt){const r=await importCodexRt(JSON.stringify(u));ids.push(r.label);ok++}
        row=`<div class="r ok"><span>${svg('check',12)}</span><span>${esc(f.name)}</span><span class="e">导入 ${withRt.length} 个渠道：${esc(ids.join(', '))}</span></div>`;
      }
    }catch(e){
      bad++;
      row=`<div class="r fail"><span>${svg('warn',12)}</span><span>${esc(f.name)}</span><span class="e">${esc(String((e&&e.message)||e))}</span></div>`;
    }
    out.insertAdjacentHTML('beforeend',row);
  }
  setStatus(st,`✓ 成功 ${ok} · 失败 ${bad}`.replace('失败 0','全部成功'),bad?'bad':'ok');
  toast(bad?`⚠ 导入完成：成功 ${ok}，失败 ${bad}`:`✓ 已导入 ${ok} 个渠道`,bad?'':'ok');
  await loadAll();
}

/* ═══════════════════════════ 弹窗：测试模型 ═══════════════════════════ */
function openTestModels(opts){
  opts=opts||{};
  const chId=opts.channelId||null, only=opts.only||null;
  const groups=[];
  /* 停用渠道**也要能测**：停用只是"不参与调度、不自动探测"，不代表不能手动打一发看看模型还活着不。
     所以这里不再 `if(!c.on)continue`，而是把停用的排到后面并打上「已停用」标签。
     （测试报文一律带 channelId，上游只会打这一条渠道，不会因为停用渠道入列就改真实分流。） */
  const list=DATA.channels.filter(c=>!chId||c.id===chId).sort((a,b)=>(b.on?1:0)-(a.on?1:0));
  for(const c of list){
    let items=chAliases(c).map(r=>r.alias);
    if(only)items=items.filter(a=>a===only);
    if(items.length)groups.push({c,items});
  }
  const total=groups.reduce((s,g)=>s+g.items.length,0);
  const offN=groups.filter(g=>!g.c.on).reduce((s,g)=>s+g.items.length,0);
  modal(`
    <div class="m-hd">
      <span class="m-ico">${svg('test',14)}</span>
      <h2>测试模型</h2>
      <span class="help">${chId?'· 渠道 '+esc(chId):'· 完整调度'}</span>
      <button class="icon-btn ml-auto" data-act="close-modal">${svg('x',15)}</button>
    </div>
    <div class="m-bd">
      <div class="probe-bar">
        <span class="status-line wait" id="testSummary">${total} 个模型</span>
        <label class="toggle ml-auto" title="真实客户端（DSH 等）走的**就是流式**；关掉只测非流式，可能漏掉「非流式答得好、流式那条路是坏的」的渠道"><input type="checkbox" id="testStream" checked> 流式</label>
        <label class="toggle"><input type="checkbox" id="testAll" checked> 全选</label>
      </div>
      ${offN?`<div class="model-empty" style="margin-bottom:8px">其中 ${offN} 个来自<b>已停用</b>渠道：手动测试照打，测通也不会因此启用它，且停用渠道不参与自动探测。</div>`:''}
      <div class="test-list" id="testList">${total
        ? groups.map(g=>`<div class="g">${esc(g.c.name||g.c.id)}${g.c.on?'':'<span class="tag">已停用</span>'}<span class="n">${g.items.length} 个</span></div>`+
            g.items.map(a=>`<label><input type="checkbox" data-m="${esc(a)}" data-c="${esc(g.c.id)}" checked><span>${esc(a)}</span></label>`).join('')
          ).join('')
        : '<div class="model-empty">暂无可测试模型 — 先在渠道里配置别名</div>'}</div>
      <div class="field"><label>提示词 <span class="help">默认 hi</span></label>
        <input class="input" id="testPrompt" value="hi"></div>
      <div class="field" id="testOutWrap" style="display:none"><label>测试结果</label>
        <div class="test-out" id="testOut"></div></div>
    </div>
    <div class="m-ft">
      <button class="btn ghost ml-auto" data-act="close-modal">取消</button>
      <button class="btn primary" id="testRun" data-act="run-tests" ${total?'':'disabled'}>${svg('send',13)}运行测试</button>
    </div>`,true);
  const all=$('#testAll');
  all.onchange=()=>$$('#testList input[type=checkbox]').forEach(c=>c.checked=all.checked);
  $$('#testList input[type=checkbox]').forEach(c=>c.onchange=()=>{
    const boxes=$$('#testList input[type=checkbox]');
    all.checked=boxes.every(x=>x.checked);
    all.indeterminate=!all.checked&&boxes.some(x=>x.checked);
  });
}
/* 渠道 id → 显示名（测试结果里要让用户一眼认出打的是哪个渠道，而不是看 id 猜） */
function chName(id){const c=DATA.channels.find(x=>x.id===id);return (c&&c.name)||id;}
/* 测试结果判定（纯函数，便于回归）：
   · fail  —— 没通（网络 / HTTP / 上游拒绝）
   · empty —— 通了（HTTP 2xx）但模型一个字没说。**既不能算"通过"**（会让人以为模型正常），
               **也不能算"失败"**（会让人去查网络）—— 单列一档，用中性色显示。
   · ok    —— 通了且有回复。 */
function testRowVerdict(row){
  if(!row||row.ok!==true)return 'fail';
  return String(row.reply==null?'':row.reply).trim()?'ok':'empty';
}
/* 逐个模型打真实 /admin/api/test：指定 channelId 时上游只会返回该渠道一行结果。
   提示词与超时都走服务端默认（30s），测试成功会由服务端**半愈合**渠道状态（v1.18.40：测试成功
   不再清零真实流量的欠账，只放开冷却 + 还探测侧的账），所以跑完要 loadAll() 把最新状态拉回来。
   v1.18.40：默认按**流式**打 —— 真实客户端走的就是流式，只测非流式等于只测了一半。 */
async function runTests(){
  const picks=$$('#testList input:checked').map(i=>({model:i.dataset.m,chan:i.dataset.c}));
  if(!picks.length)return toast('至少勾选一个模型');
  const prompt=($('#testPrompt').value||'').trim()||'hi';
  const streamEl=$('#testStream'), stream=streamEl?streamEl.checked:false;
  const btn=$('#testRun'), old=btn.innerHTML;
  btn.disabled=true; btn.innerHTML=svg('send',13)+'运行中…';
  const wrap=$('#testOutWrap'), out=$('#testOut');
  wrap.style.display=''; out.innerHTML='';
  let okN=0, emptyN=0;
  for(const p of picks){
    const pend=document.createElement('div');
    pend.className='r wait';
    pend.innerHTML=`${svg('clock',12)} <b>${esc(p.model)}</b> <span class="muted">@ ${esc(chName(p.chan))}</span> …`;
    out.appendChild(pend); out.scrollTop=out.scrollHeight;
    let row;
    try{
      const r=await api('/admin/api/test',{method:'POST',body:JSON.stringify({model:p.model,channelId:p.chan,prompt,...(stream?{stream:true}:{})})});
      row=(r.results||[])[0]||{ok:false,error:'上游未返回结果'};
    }catch(e){row={ok:false,error:String((e&&e.message)||e)}}
    pend.remove();
    const v=testRowVerdict(row);
    if(v==='ok')okN++; else if(v==='empty')emptyN++;
    /* 三档各自给中文标签 + 图标：只靠颜色区分，用户根本不知道自己看的是"通了"还是"没通" */
    const meta={ok:['ok','check','通过'],empty:['wait','clock','空回复'],fail:['fail','warn','失败']}[v];
    const tok=(row.promptTokens!=null||row.completionTokens!=null)?` · ${row.promptTokens||0}+${row.completionTokens||0} tok`:'';
    /* 流式结论要标明"这是流式判的"并带上帧数 —— 否则用户分不清这次绿是不是流式绿 */
    const sm=stream?` · 流式${row.streamFrames!=null?' '+row.streamFrames+' 帧':''}${row.streamIgnored?'（上游无视 stream）':''}`:'';
    /* 每一行都带**模型名**（一个渠道挂多个模型时，只写渠道名等于没说测的是谁）+ 渠道显示名 */
    const where=`<b>${esc(p.model)}</b> <span class="muted">@ ${esc(chName(p.chan))}</span>`;
    const detail=v==='fail'
      ? esc(String(row.error||'失败').slice(0,200))
      : v==='empty'
        ? '（HTTP 200 但回复为空 —— 模型没说任何话）'
        : `"${esc(String(row.reply||'').slice(0,160))}"`;
    out.insertAdjacentHTML('beforeend',
      `<div class="r ${meta[0]}"><span>${svg(meta[1],12)}</span>`+
      `<span>${where} · <b>${meta[2]}</b> · ${fMs(row.latencyMs)}${sm}${v==='fail'&&row.status?' · HTTP '+row.status:''}${tok}</span>`+
      `<span class="e">${detail}</span></div>`);
    out.scrollTop=out.scrollHeight;
  }
  const totalN=picks.length, failN=totalN-okN-emptyN;
  btn.disabled=false; btn.innerHTML=old;
  setStatus($('#testSummary'),
    `通过 ${okN} · 空回复 ${emptyN} · 失败 ${failN}（共 ${totalN} 个 · ${stream?'流式':'非流式'} · 提示词「${prompt}」）`,
    failN||emptyN?(okN?'wait':'bad'):'ok');
  toast(failN===0&&emptyN===0?`✓ 全部通过（${okN}/${totalN}）`
    :okN===0&&emptyN===0?`✗ 全部失败（0/${totalN}）`
      :`⚠ 通过 ${okN} · 空回复 ${emptyN} · 失败 ${failN}`,failN===0&&emptyN===0?'ok':'');
  loadAll().catch(()=>{});
}

/* ═══════════════════════════ 抽屉 / 主题 / 全局 ═══════════════════════════ */
function drawer(html){
  $('#drawer').innerHTML=html;
  $('#drawer').classList.add('on'); $('#scrim').classList.add('on');
}
function closeDrawer(){$('#drawer').classList.remove('on');$('#scrim').classList.remove('on')}
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    if($('#mask').classList.contains('on'))closeModal();
    else closeDrawer();
  }
});
function setTheme(t){
  document.documentElement.dataset.theme=t;
  try{localStorage.setItem('zzcs-theme',t)}catch(e){}
  $('#themeBtn').innerHTML=svg(t==='dark'?'sun':'moon',15);
  $('#themeBtn').title=t==='dark'?'切换到浅色':'切换到深色';
}
$('#themeBtn').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
/* v1.18.24 右上角全局搜索框已**移除**（用户拍板，2026-10-07）。它只做一件事：回车把关键词塞进
   `chQ` 再跳渠道页——而渠道页自己就有筛选框（`#chQ`），其它页各有各的搜索；放在全站位置却总跳
   渠道管理，是纯粹的重复入口，还容易被当成"搜当前页"。
   v1.18.23 曾为它补过"清空对称"，随本次移除一并作废；别再把这个框加回来——
   `test/console-state.test.js` §20 现在守的是"它不存在、也没有 Ctrl/⌘+K 抢焦点"。 */
/* ═════════════════════════ 事件委托：全站唯一事件入口（v1.18.7） ═════════════════════════
   内联事件属性（onclick=/onchange=/onkeydown=）已全量清零：动作进 data-act、参数走 data-*，
   document 上的委托监听统一分发——8 秒轮询整页重绘不用重挂；点击从目标向上找最近的 [data-act]，
   行内按钮天然只触发自己（行/卡片的 data-act 不会再被按钮冒泡触发，stopPropagation 成为历史）。
   新增交互：在 ACTS 里加一行 + 模板里写 data-act，别再写内联属性
   （test/security-headers-e2e.test.js 的回潮守卫会拦）。change 走同一条路（目前仅导入文件框）。 */
const ACTS={
  'export-usage':()=>exportUsage(),
  'recheck-all':el=>recheckAll(el),
  'go':el=>go(el.dataset.page),
  'open-channel':el=>openChannel(el.dataset.id),
  'open-log':el=>openLog(el.dataset.id),
  'open-model':el=>openModel(el.dataset.m),
  'toggle-imp-menu':()=>toggleMenu('impMenu'),
  'open-import':el=>openImport(el.dataset.kind),
  'open-test-models':el=>openTestModels(el.dataset.id?{channelId:el.dataset.id}:{}),
  'open-channel-form':el=>openChannelForm(el.dataset.id||undefined),
  /* v1.18.33 渠道级「不发这些参数」：合法参数名 chip → 填进输入框（名字走 data-k，不拼事件代码） */
  'fill-drop-param':el=>addDropParam(el.dataset.k),
  'toggle-ch':el=>toggleCh(el.dataset.id),
  'close-drawer':()=>closeDrawer(),
  'toggle-drawer-key':el=>toggleDrawerKey(el.dataset.id,el),
  'copy-ch-key':el=>copyChKey(el.dataset.id,el),
  'reprobe':el=>reprobe(el.dataset.id),
  'drawer-edit-channel':el=>{closeDrawer();openChannelForm(el.dataset.id)},
  'drawer-toggle-open':el=>{toggleCh(el.dataset.id);openChannel(el.dataset.id)},
  'del-channel':el=>delChannel(el.dataset.id),
  'export-models':()=>exportModels(),
  'copy-models':()=>copyModels(),
  'copy':el=>copyText(el.dataset.t,el),
  'copy-curl':el=>copyCurl(el.dataset.t,el),
  'clear-usage':()=>clearUsage(),
  'export-logs':()=>exportLogs(),
  'apply-log-filter':()=>drawLogTable(),
  'stats-refresh':()=>refreshStats(),
  'clear-st-filter':()=>{stFilter.client='';render()},
  'ban-ip':el=>banIp(el.dataset.t),
  'unban-ip':el=>unbanIp(el.dataset.t),
  'pg-clear':()=>pgClear(),
  'pg-copy-curl':()=>pgCopyCurl(),
  'copy-all-endpoints':el=>copyAllEndpoints(el),
  'copy-gw-key':el=>copyGwKey(el),
  'show-key-help':()=>showKeyHelp(),
  'close-modal':()=>closeModal(),
  'toggle-key-field':()=>toggleKeyField(),
  'add-model-row':()=>addModelRow(),
  'probe-upstream':()=>probeUpstream(),
  'save-channel':()=>saveChannel(),
  'test-row-model':el=>testRowModel(+el.dataset.idx),
  'del-model-row':el=>delModelRow(+el.dataset.idx),
  'probe-select-all':()=>probeSelectAll(),
  'probe-clear-sel':()=>probeClearSel(),
  'probe-add-selected':()=>probeAddSelected(),
  'import-files':el=>importFiles(el.dataset.kind,el),
  'pick-import-file':()=>document.getElementById('impFile').click(),
  'do-import':el=>doImport(el.dataset.kind),
  'run-tests':()=>runTests(),
};
document.addEventListener('click',e=>{
  const el=e.target&&e.target.closest?e.target.closest('[data-act]'):null;
  if(!el)return;
  const fn=ACTS[el.getAttribute('data-act')];
  if(fn)fn(el);
});
document.addEventListener('change',e=>{
  const el=e.target&&e.target.closest?e.target.closest('[data-change]'):null;
  if(!el)return;
  const fn=ACTS[el.getAttribute('data-change')];
  if(fn)fn(el);
});

/* 登录门（v1.18.6 会话化）：管理密钥只在这里出现一次——POST /admin/api/session 换回
   HttpOnly + SameSite=Strict 的会话 cookie 后即被丢弃，不落 localStorage、不进地址栏、JS 读不到。
   之后所有管理面调用只靠 cookie；会话过期/被轮换清掉时 api() 收到 401 重新弹这扇门。 */
function showKeyGate(){
  if(document.getElementById('zz-gate'))return;
  const g=document.createElement('div');g.id='zz-gate';
  g.style.cssText='position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:var(--bg);backdrop-filter:blur(6px)';
  g.innerHTML=`<div style="max-width:420px;width:calc(100% - 48px);background:var(--panel);border:1px solid var(--accent-line);border-radius:14px;padding:28px 26px;box-shadow:0 18px 50px rgba(0,0,0,.45)">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <span style="width:34px;height:34px;border-radius:10px;background:var(--accent-soft);display:inline-flex;align-items:center;justify-content:center"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>
      <span style="font-size:17px;font-weight:700">管理密钥</span></div>
    <div class="help" style="margin-bottom:14px">首启密钥在容器日志里：docker logs zzcsapi | grep ADMIN_KEY<br>验证通过后会换成会话（12 小时有效），密钥本身不会被浏览器存下来。</div>
    <input id="zz-gate-input" type="password" autocomplete="new-password" placeholder="粘贴 ADMIN_KEY" style="width:100%;box-sizing:border-box">
    <div id="zz-gate-err" style="color:var(--err);font-size:12px;margin-top:8px;min-height:16px"></div>
    <button id="zz-gate-btn" class="btn" style="width:100%;margin-top:6px">进入控制台</button>
  </div>`;
  document.body.appendChild(g);
  const input=g.querySelector('#zz-gate-input');input.focus();
  input.addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('zz-gate-btn').click()});
  const attempt=async()=>{
    const k=input.value.trim();if(!k)return; /* 2026-10-04：终端 cat 复制带尾随换行/空格不再被打成 401 */
    const errEl=g.querySelector('#zz-gate-err');errEl.textContent='';
    try{
      const r=await fetch('/admin/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k})});
      const j=await r.json().catch(()=>null);
      if(r.status!==200){errEl.textContent=errMsgOf(j,'密钥不对（HTTP '+r.status+'）');input.select();return}
      input.value='';          // 密钥用完即弃：不留输入框、不进存储
      g.remove();boot();
    }catch(e){errEl.textContent='网络错误：'+(e&&e.message||e)}
  };
  g.querySelector('#zz-gate-btn').onclick=attempt;
}
async function logout(){
  try{ await fetch('/admin/api/session',{method:'DELETE'}); }catch(e){}
  location.reload();   // cookie 已被服务端清掉，重载自然弹回登录门
}
/* 启动探针：不问本地存储（里面已经什么都没有了），直接敲一发管理接口——
   200 = 会话 cookie 还活着，直接进；401/网络错 = 弹登录门。 */
fetch('/admin/api/status',{headers:{'Content-Type':'application/json'}})
  .then(r=>{ r.status===200?boot():showKeyGate(); })
  .catch(()=>showKeyGate());

function tick(){
  const d=new Date(), p=n=>String(n).padStart(2,'0');
  $('#clock').textContent=p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}

/* 首屏先渲染骨架再拉数据，避免白屏；之后每 8 秒静默刷新。
   标签页不可见时不打接口，否则后台标签会一直空转网关。
   会话化（v1.18.6）：启动前先探一发 /admin/api/status——有活着的会话 cookie 才 boot()，
   否则 showKeyGate()；api() 遇 401 也会重新弹门（会话过期 / 密钥被轮换时）。 */
let __ZZ_BOOTED__=false;
function boot(){
  if(__ZZ_BOOTED__)return;__ZZ_BOOTED__=true;
  let t='dark'; try{t=localStorage.getItem('zzcs-theme')||'dark'}catch(e){}
  setTheme(t);
  renderRail();
  tick(); setInterval(tick,1000);
  $('#btnRecheck').onclick=()=>recheckAll($('#btnRecheck'));
  go('overview');
  loadAll().catch((e)=>toast('加载失败：'+(e&&e.message||e),'bad'));
  /* 8 秒静默刷新：只重绘当前页（不是整页刷新），但会重建 DOM。
     所以两种情况跳过这一拍——正在流式请求中（会把「正在路由」气泡抽掉），
     以及用户正在某个输入框里编辑（重绘会打断中文输入法联想、也可能吞掉未同步的草稿）。
     数据不丢，下一个周期补上。 */
  setInterval(()=>{
    if(document.visibilityState!=='visible'||pgBusy)return;
    const a=document.activeElement, vp=$('#viewport');
    if(a&&vp&&vp.contains(a)&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))return;
    loadAll().catch(()=>{});
  },8000);
}
