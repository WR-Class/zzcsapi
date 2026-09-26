# AGENTS.md · 项目协作约定

> 本文件是**强约束**。任何 Agent（或人）在本仓库动手之前必须先读，动手之后必须执行 §1。

---

## 1. 【强制】改动必须同步文档

**无论改动来自谁——你、其他 Agent、还是人工——只要动了代码，就必须在同一次改动里更新对应文档。**
不允许"先改代码，文档下次补"。文档与代码不一致，视为改动未完成。

### 1.1 改什么 → 更新哪里

> **前置认知：`console.html` 是构建产物，不是手写文件。**
> 它 = `console-redesign.html` 的 `<style>` 原文 + `build/` 下的 head/shell/extra.css/app.js。
> 改完任何源文件**必须重新 `node build/build.js`**，否则改动不生效、且下次构建会覆盖手改。

| 你改动了 | 必须同步更新 |
| --- | --- |
| `console-redesign.html` 的 `<style>`（视觉：字号 / 留白 / 圆角 / 配色 / 卡片 / 弹窗） | 重新 `node build/build.js`；`docs/frontend-code-map.md`（**行号锚点、索引、修改路由表**）+ `docs/frontend-console-detailed.md`（§2 设计系统、§8 变更日志） |
| `console-redesign.html` 的 JS / markup（原型演示逻辑） | 重新构建（CSS 会带过去）；`docs/frontend-code-map.md` 的行号锚点 + `docs/frontend-console-detailed.md` §8 |
| `build/app.js`（生产数据层 / 交互 / 渲染） | 重新 `node build/build.js`；`docs/frontend-console-detailed.md` §8 变更日志 + 涉及页面/流程的章节；新增函数登记到 `docs/frontend-code-map.md` §0.2 |
| `build/shell.html`（生产 body 骨架） | 重新构建；`docs/frontend-code-map.md` §0.2 结构表 |
| `build/extra.css`（生产独有组件样式） | 重新构建；`docs/frontend-console-detailed.md` §4 组件规范 |
| `build/head.html`（head / 字体 CDN） | 重新构建；`docs/frontend-console-detailed.md` §2.2 |
| `build/build.js`（组装逻辑 / 自检） | `README.md`「前端代码文档」+ `docs/frontend-code-map.md` §0.2 |
| `server.js` 新增/修改端点 | `README.md` 端点总表 + `docs/frontend-console-detailed.md` §7 原型→生产映射表 |
| `server.js` 调度 / 排序 / 优先级算法 | `README.md` §调度顺序（含「有效优先级」公式、生效条件与数据来源字段） |
| 新增/修改渠道协议 | `README.md` 协议说明表 + `console-redesign.html` 的 `PROTO_META`/`PROTO_ORDER` + `build/app.js` 同名字典 + 两份前端文档 |
| 新增文档 | 登记到 `README.md` 的「前端代码文档」章节和本文件 §3 文档索引 |
| 新增配置项 / 环境变量 | `README.md` + `config.example.json` |

### 1.2 ⚠️ 行号锚点会漂移（最容易腐烂的一环）

`docs/frontend-code-map.md` 的核心是**两张行号锚点表**：§1/§3 对应 `console-redesign.html`，§0.2 对应 `build/*`。
你在任一文件里增删任何一行，**它后面所有行号全部失效**。

所以改完源文件后，**必须重新核对代码地图里的行号**，方法：

```powershell
# 重新导出 console-redesign.html 的函数/常量真实行号，与文档逐一比对
Select-String -Path d:\DSHXM\ZZCSAPI\console-redesign.html `
  -Pattern 'function\s+[A-Za-z_$][\w$]*\s*\(|^const (DATA|IC|NAV|PROTO_META|PROTO_ORDER|MODEL_POOL|PROBE_POOL|IMPORT_META|REPLIES)\s*=' |
  ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
```

```powershell
# 重新导出 build/app.js 的函数/常量真实行号（生产侧）
Select-String -Path d:\DSHXM\ZZCSAPI\build\app.js `
  -Pattern '^\s*(async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(|^const (IC|NAV|PROTO_META|PROTO_ORDER|OV_RANGE|IMPORT_META|CFG)\s*=' |
  ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
```

```powershell
# 重新导出 CSS 区块行号（console-redesign.html）
Select-String -Path d:\DSHXM\ZZCSAPI\console-redesign.html -Pattern '/\*\s*═+' |
  ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
```

> **换算捷径**（构建是纯拼接，偏移恒定，改完源文件后可用它自查文档里的 `console.html` 行号）：
> - `console.html` 的 CSS 行号 = `console-redesign.html` 行号 **+13**
> - `console.html` 的 JS 行号 = `build/app.js` 行号 **+617**
>
> 偏移只受 `build/head.html`（21 行）/ `build/shell.html`（52 行）/ `build/extra.css`（8 行）增删行影响
> （head/shell 已由 build.js 构建期行数守卫把住，extra.css 改动仍需人工重算偏移并同步此处）。

若偏移量是整体平移，可以按差值批量修正；若只是局部插入，务必逐个核对，不要凭估算改数字。

### 1.3 改完自检

- [ ] 改了 `console-redesign.html` / `build/*` 后**已重新 `node build/build.js`**，且 `git diff console.html` 里能看到预期变化
- [ ] 受影响的文档已更新，且**不是**只写"已优化"这类空话，而是写明**问题 → 根因 → 处置**
- [ ] 代码地图里的行号已用 §1.2 的命令重新核对
- [ ] 新增的文件/端点/协议已登记到 §1.1 表格涉及的所有位置
- [ ] `docs/frontend-code-map.md` §8「快速自测清单」里相关的项已手工验证

---

## 2. 工程约定

- **字体**：全站统一小米开源 MiSans（可商用），官方 CDN `font.sec.miui.com`，按 `unicode-range` 分片加载。
  MiSans **无等宽变体**，代码块与数值列无法严格等宽对齐，层级一律靠**字重**区分，不要靠字体族切换。
- **配色**：全站暖色系，**明确排除冷色**（青、蓝绿、紫青）。暗色=暖琥珀陶土，亮色=暖锈橙。
- **涨跌配色**：遵循中国股票惯例**红涨绿跌**（`.delta.up` 用 `--err`）。这是刻意反直觉的，不要"顺手修回"欧美惯例。
- **图表**：全部手写内联 SVG，不引入图表库；曲线用独立图表带 + `preserveAspectRatio="none"` 铺满，避免与文字重叠。
- **弹窗**：遮罩**不响应点击关闭**（拖选复制易误关），关闭路径只有 × / 取消 / Esc。
- **布局**：整页不滚动，`.viewport` 是唯一滚动容器。不要用 `min-height: calc(100vh - Npx)` 这类写死横幅高度的写法。

---

## 3. 文档索引

| 文档 | 内容 |
| --- | --- |
| `README.md` | 后端协议、渠道配置、端点总表、部署方式 |
| `docs/frontend-code-map.md` | 前端代码地图：行号锚点、CSS/z-index 全景、JS 索引、数据契约、修改路由表、坑位清单 |
| `docs/frontend-console-detailed.md` | 控制台前端详细设计：设计系统、布局、组件、页面、交互流程、原型→生产映射、变更日志 |
| `docs/arena-protocol.md` | Arena 协议（已撤渠道，留档） |
| `docs/prism-reverse-proxy-research.md` | Prism 反代可行性研究（已撤渠道，留档） |
| `docs/genspark-claw-reverse-proxy-research.md` | Genspark Claw 反代研究 |
| `docs/PONYTAIL_REVIEW.md` | Ponytail 全项目审查：整改项 PT 清单（file:line 证据 + 最小修复 + 最小回归）、已验证非问题、前端独立审查 |
| `docs/AI工具调用桥接-群友分享版.md` | AI 工具调用桥接说明 |
