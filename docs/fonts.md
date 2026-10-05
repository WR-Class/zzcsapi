# 全站字体：HCRound（寒蝉全圆体的子集化改名版）

> 一句话：控制台的字体是**自托管**的 `HCRound`，它由 **寒蝉全圆体 ChillRoundF v3.200**（SIL OFL 1.1）
> 按 `unicode-range` 子集化并**改名**而来。改名不是洁癖——按 SIL 官方口径，子集化属于 OFL 意义上的
> **修改版**，修改版**不得再使用上游的保留字体名**。本文件记录：授权事实、改名依据、交付形态、
> 字重映射表、可复现的再生成步骤，以及"哪个测试守着哪一条"。

---

## 1. 为什么换（以及本文**不**主张什么）

**换的直接原因**：所有者判断 MiSans 的使用限制太多、存在法律风险，决定换成授权明确的开源字体。

**本文刻意不写"MiSans 不能商用"**——那是我们**没有**核实到的结论：

- 换字体之前，仓库里的记录是「MiSans（小米开源、可商用）· 官方 CDN」（见 `build/head.html` 旧注释、`AGENTS.md` §2 旧条款）。
- 本轮想复核小米的**条款原文**时，`hyperos.mi.com/font/` 是 JS 单页应用，抓不到条款正文，
  Bing 检索也被同名内容污染——**所以本轮没有拿到可引用的 MiSans 条款原文**。
- 换成 OFL-1.1 之后这件事不再重要：下面第 3 节的授权事实是**逐条可复核**的（仓库 LICENSE 字段、
  随包 `LICENSE.txt` 原文），不需要依赖对第三方条款的解读。

顺带收益：字体不再向任何第三方域名发起请求，渗透测试发现 **N-04**（「CSP 引外部字体 CDN（供应链/隐私面）」，
此前登记为"维持"）就此关闭（见 [security-hardening.md](security-hardening.md)）。

---

## 2. 授权事实（逐条证据）

| 事实 | 证据 |
| --- | --- |
| 上游仓库 | [`Warren2060/ChillRound`](https://github.com/Warren2060/ChillRound)（"圆体字体拓展计划"） |
| 许可证 | **SIL Open Font License 1.1**（GitHub 仓库 license 字段 `spdx_id: OFL-1.1`；随包 `LICENSE.txt` 93 行 OFL 1.1 原文） |
| 保留字体名（RFN） | `LICENSE.txt` 头：`© 2023 ChillType, with Reserved Font Name 'ChillRoundF' 'ChillRoundM'.` |
| 采用的版本 | **v3.200（2024-05-09）**，`ChillRoundF_v3.200.zip`（15.87 MB），含 `ChillRoundFRegular/Bold.ttf/.otf` + `LICENSE.txt` |
| 上游血统 | 小杉圆体（Kosugi Maru / MOTOYA）+ jf open 粉圆 + 猫啃糖圆体；西文 Varela Round |
| 字重 | **只有 Regular(400) 与 Bold(700)**；**不是可变字体**（无 `fvar`） |
| 字形规模 | 15,865 字形 / cmap 57,032 码位（48,816 汉字）；GSUB 含 `tnum`、`pnum`、`vert`、`ss01-03` 等；GPOS 含 `kern`/`vkrn` |
| 无等宽 / 无衬线变体 | 与 MiSans 同样的约束（三个 `--f-*` 变量实际都落到同一族） |

> 字体资产落在 `assets/fonts/chillround/`：`LICENSE.txt` + `regular/`（129 片 woff2）+ `bold/`（137 片 woff2）
> + 入口 `font.css`（两个字重合并，266 条 `@font-face`）。仓库里**不**提交 6 MB 级的源 TTF。

---

## 3. 改名：为什么必须做，依据是什么

### 3.1 SIL 的官方口径（OFL-FAQ + 专论）

| 出处 | 原文要点 |
| --- | --- |
| [OFL-FAQ §2.6](https://openfontlicense.org/open-font-license-official-text/) | **"Is subsetting a webfont considered modification?" — "Yes.** Removing any parts of the font when delivering a webfont to a browser, including unused glyphs and smart font code, is considered modification. This is permitted by the OFL but **would not normally allow the use of RFNs**." |
| [OFL-FAQ §2.2.1](https://openfontlicense.org/open-font-license-official-text/) | 只有"除 WOFF 压缩外原始字体数据完全未变、且 WOFF 元数据原样保留"的**纯格式转换**才可以不改名——子集化不属于此列 |
| [Webfonts and Reserved Font Names](https://openfontlicense.org/webfonts-and-reserved-font-names/) | **Pre-subsetting**（按 `unicode-range` 预切分，正是我们做的）："…it is not possible to preserve FE (Functional Equivalence), and so pre-subsetting needs to be considered a **Modified Version for which RFN restrictions apply**." |
| OFL-FAQ §5.3 | 保留名还不得"以任何方式向用户标识该字体"——所以 CSS 里声明的族名同样不能是 RFN |
| OFL-FAQ §5.4 / §5.2 | 允许用保留名的**部分**词（如 `Foo`/`bar`），但应避免"几乎照搬同一串字母"的取名 |

**结论**：子集化**被 OFL 允许**，唯一的后果是**不能用保留名**。所以我们照做——不是绕开许可，而是遵守它。

### 3.2 我们具体怎么改的

`build/fonts.js rename` 在**切分之前**改写源 TTF 的 `name` 表（切分工具会把 `name` 表抄进每个分片，
所以在源头改一次就传导到全部 266 片）：

| nameID | 含义 | 处置 |
| --- | --- | --- |
| 1 / 16 / 21 | 族名 / 排版族名 / WWS 族名 | → `HCRound` |
| 2 / 17 / 22 | 子族名 | → `Regular` / `Bold` |
| 4 / 18 | 全名 | → `HCRound Regular` / `HCRound Bold` |
| 6 | PostScript 名 | → `HCRound-Regular` / `HCRound-Bold` |
| 3 | UniqueID | → `HCRound;Regular;subset`（**原值里含 RFN，必须换**） |
| 10 | 描述 | **原文保留**，末尾追加一句本站改作与上游链接（FAQ §5.3 允许在 description 注明出处） |
| 0 / 7 / 8 / 9 / 12 / 13 / 14 | 版权 / 商标 / 制造商 / 设计者 / 设计者 URL / 许可描述 / 许可 URL | **原样保留**（OFL 条件 2 要求随附声明） |

改完 `build/fonts.js dump` 的复核结果是「含保留字体名的不同取值：**0 条**」；`checkSumAdjustment` 用独立
重算核对一致；16 张表的集合与顺序与源字体一致（`DSIG GDEF GPOS GSUB OS/2 cmap glyf head hhea hmtx loca maxp name post vhea vmtx`）。

**为什么不用工具自带的 `--renameOutputFont`**：实测它是**空转**的——传了 `--renameOutputFont HCRound`
之后，输出分片的 `name` 表里 `ChillRoundFRegular` / `3.200;CTQY;ChillRoundFRegular` 原封不动（该参数只影响
输出**文件名**）。所以改名必须在源 TTF 上做。

---

## 4. 交付形态

```
assets/fonts/chillround/
├── LICENSE.txt          # OFL 1.1 原文（OFL 条件 2 的"随附许可"）
├── font.css             # 入口：266 条 @font-face（两个字重合并），build/fonts.js merge 生成
├── regular/result.css   # 工具原始产物（含元数据头），供复核用
├── regular/<hash>.woff2 # 129 片（400）
├── bold/result.css
└── bold/<hash>.woff2    # 137 片（700）
```

| 项 | 值 |
| --- | --- |
| 入口 `head.html` 里的链接 | `<link href="/console/fonts/font.css" rel="stylesheet">`（**绝对路径**，故 `/`、`/console`、`/console/` 三种入口都成立；同源，无需 preconnect） |
| 路由 | `GET|HEAD /console/fonts/**`，由 `font-assets.js` 提供（`server.js` 里只有一行调用） |
| 安全模型 | 启动时把目录扫成**白名单 Map**，请求只做 `FILES.get(pathname)`——**不把请求路径拼进文件路径**，路径穿越面因此不存在；扩展名白名单只放 `.woff2`/`.css`/`.txt` |
| 缓存 | 分片是内容哈希 → `public, max-age=31536000, immutable`；入口 CSS 名字固定 → `public, max-age=300` |
| 压缩 | 入口 CSS 26 万字符：brotli q9 → **49.9 KB**（gzip 75.2 KB），**首次请求时惰性压一次并缓存**（不拖慢启动、测试起实例不付这笔钱）；woff2 本身即 Brotli，**绝不二次压缩** |
| 公开性 | 与 `/console` 壳同等公开（字体不是机密，控制台的机密全在 `/admin/api`），故在客户端面封禁闸门之外 |
| 容器 | `Dockerfile` 必须 `COPY assets/fonts ./assets/fonts`——漏了这行容器里没有字体，**页面不报错、只是字变了**（测试守着这条） |

---

## 5. 两条已知限制（都是实测得到的，不要"顺手修"）

1. **cn-font-split 不把 `nameID 13/14`（许可描述、许可 URL）写进输出分片。** 实测分片的 `name` 表只剩 7 条
   记录（版权 / 族名 / 子族名 / UniqueID / 全名 / 版本 / PostScript）。它自己 `result.css` 头部的
   "LicenseDescription …" 读的是**输入字体**，**不能**当作分片里真有许可描述的证据。
   → 这**不违反** OFL：条件 2 明文允许 "*either as stand-alone text files … or in the appropriate
   machine-readable metadata fields*"（版权声明已随每片），**但反过来意味着 `LICENSE.txt` 是承重件**——
   删掉它才是真违约。`test/font-assets-e2e.test.js` 同时断言"266 片都带版权声明"和"独立许可文件在位"。
2. **只有 400/700 两档，且没有等宽/衬线变体。** 中间档（原来的 500/600）已归并，见下节；
   代码块与数值列**做不到严格等宽对齐**，靠 `font-variant-numeric:tabular-nums` 缓解。

---

## 6. 字重映射表（500→400 / 600→700）

浏览器做字体匹配时，请求 500 会落到 400、600 会落到 700——两档都是**真实存在的字重**，
所以**不会触发伪粗体合成**。逐处判定如下（每处的"为什么可以这么降"都写了理由，不是一刀切）：

| 原 600 → **700** | 理由 |
| --- | --- |
| `h1,h2,h3,h4` / `.serif` / `.card-hd h3` / `.m-hd h2` / `.proto b` / `.test-out .r b` | 标题与强调，本来就该是最粗一档；700 比原来的 600 更实 |
| `.btn.primary` | 主按钮 |
| `.avatar` / `.msg .meta .role` / mono 微标签（10–10.5px） | 小字号在 400 下会糊，必须给 700 |
| `build/extra.css`：`.aw-note b` / `.aw-m-name` / `.aw-sh` / `.set-stat b`；`build/app.js`：2 处内联 | 数值/名称主值 |

| 原 500 → **400** | 为什么可以降（强调由别的属性承担） |
| --- | --- |
| `table.tbl thead th`（表头） | 已有 9.5px + `letter-spacing:.1em` + `text-transform:uppercase` + `--panel-2` 底色 + `--tx-3` 弱化色 |
| `.tab` | 选中态有底色与描边（`.tab.on`） |
| `.delta` | 有语义色与胶囊底色 |
| `.cell-name` | 与 `.cell-sub` 靠**颜色**（`--tx` vs `--tx-3`）和**字号**（13 vs 10.5）区分 |
| `.bar-name` / `.kpi-val .unit` / `.st-kpi-unit` | 标签/单位，弱化色本就不该抢层级 |
| 侧栏项、次要按钮、原型表单控件 | 有 hover/选中底色与描边 |

`--fw-display:700` 未动：它与标题同为 700，但字号（34/40px）本身就拉开了层级。

---

## 7. 重新生成（可复现步骤）

```powershell
# 0) 取出上游字体（zip 已被 .gitignore 忽略，不进仓库）
#    https://github.com/Warren2060/ChillRound/releases → ChillRoundF_v3.200.zip
#    解出 ChillRoundFRegular.ttf / ChillRoundFBold.ttf

# 1) 改名（OFL 保留字体名条款，必须在切分之前）
node build/fonts.js rename <src>\ChillRoundFRegular.ttf <tmp>\HCRound-Regular.ttf HCRound Regular 400
node build/fonts.js rename <src>\ChillRoundFBold.ttf    <tmp>\HCRound-Bold.ttf    HCRound Bold    700
node build/fonts.js dump <tmp>\HCRound-Regular.ttf      # 期望：含保留字体名的不同取值 0 条

# 2) 切分（cn-font-split 7.4.x；内核 wasm/dll 需手动装，见下方注意）
npx cn-font-split run -i <tmp>\HCRound-Regular.ttf -o assets\fonts\chillround\regular --css.fontFamily HCRound --css.fontWeight 400
npx cn-font-split run -i <tmp>\HCRound-Bold.ttf    -o assets\fonts\chillround\bold    --css.fontFamily HCRound --css.fontWeight 700
#    产物里的 index.html / index.proto / reporter.bin 是工具副产品，删掉

# 3) 合并 + 逐片校验 + RFN 扫描（失败即非零退出，不给"悄悄发不合规字体"的机会）
node build/fonts.js merge

# 4) 守卫
node test/font-assets-e2e.test.js
node build/build.js
```

注意事项（都是踩过的坑）：

- **npm 源**：本机直连 registry 会 `ERR_TLS_CERT_ALTNAME_INVALID`，用
  `--registry=https://registry.npmmirror.com` 或 `HTTPS_PROXY=http://127.0.0.1:7897`；
  且必须用 `npm.cmd` / `npx.cmd`（裸 `npm` 会命中禁用的 `.ps1`）。
- **cn-font-split 的 postinstall 会被 npm 11 的 allow-scripts 挡掉**，需要手动把平台内核
  放进 `node_modules/cn-font-split/dist/` 并写一个 `version` 文件（本轮装的是
  `libffi-x86_64-pc-windows-msvc.dll` 7.6.8 + `version` = `x86_64-pc-windows-msvc@7.6.8`）。
- **唯一不可复现的字段**：`font.css` 头里的 `CreateTime` 时间戳（每次生成都不同，
  合并时只保留 Regular 那份的头）。除此之外产物是确定的。
- **改名脚本会重建整个 sfnt**（表目录按 tag 排序、重算每张表校验和与 `head.checkSumAdjustment`），
  所以改动后务必用 `dump` 复核，并确认表集合与顺序与源字体一致。

---

## 8. 谁来守这些结论

`test/font-assets-e2e.test.js`（44 项断言，零依赖，真起临时网关）——每条结论都有对应断言，
**且刻意避开"看起来像证据"的假证据**：

| 断言 | 守的是 |
| --- | --- |
| 入口 CSS 与 **266 片解压后的 `name` 表**都不含 `ChillRoundF`/`ChillRoundM` | 第 3 节的合规结论（为此在用例里实现了最小 woff2 解码器：woff2 是 Brotli 压缩的，**在压缩字节上直接搜名字永远是"假通过"**；解码器还带"解压长度 = Σ表长"的自检与"HCRound 正对照"） |
| 266 片都带原始版权声明（nameID 0）+ `LICENSE.txt` 在位且是 OFL 原文 | OFL 条件 2（并记录第 5.1 节那个"工具会丢许可记录"的事实） |
| `@font-face` 条数 = 目录里 woff2 片数（266 = 266）、CSS 引用的分片逐个存在、400/700 两个声明都在 | 少一片就是"部分字回落系统字体"（页面不报错） |
| 八种路径穿越写法（`..` / `%2e%2e` / 混合，**原始报文直发绕过客户端归一化**）全部 404；目录路径、无扩展名路径 404；POST 405 | 第 4 节的安全模型 |
| br / gzip / 原样三条压缩线、CSS 短缓存、分片 `immutable`、woff2 不二次压缩、真 `wOF2` 字节 | 第 4 节的交付与缓存策略 |
| CSP 里 `font-src 'self'`、全仓无 `font.sec.miui.com`/`cdn-file.hyperos.mi.com`、`/console` 真发出来的 HTML 里字体入口是同源的 | N-04 关闭的物证 |
| `build/head.html` 仍是 21 行、源文件里 `font-weight:500/600` 已清零、Dockerfile 有 `COPY assets/fonts` | 构建期行数守卫 / 第 6 节 / 容器可运行 |

配套：`test/security-headers-e2e.test.js` 的 CSP **逐字**守卫（`CSP_EXPECT`）也已同步改为无外部主机版本。
