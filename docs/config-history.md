# 配置代际与一键回滚（v1.18.83 后端 / v1.18.84 控制台入口 / v1.18.85 原子写与启动自愈）

> 一句话：**每次改写 `config.json` 之前，先把"当前这一份"存成一代**；环上留最近 N 代（默认 20），
> 控制台「配置历史」页（v1.18.84）与管理 API 都可以列出代际、看「那一代 → 现在」的**字段级差异**、一键回滚。
> 对应的代码在 `server.js` 的 `persistConfig` 下方（`snapshotConfigForHistory` 一族），
> 前端在 `build/app.js` **文件末尾**的 `vHistory` 一族（刻意追加在末尾，零锚点漂移；
> 页面说明见 [`frontend-console-detailed.md`](frontend-console-detailed.md) §5.12），
> 守卫测试是 [`test/config-history-e2e.test.js`](../test/config-history-e2e.test.js)、
> [`test/config-atomic-write-e2e.test.js`](../test/config-atomic-write-e2e.test.js)（v1.18.85）与
> [`test/console-state.test.js`](../test/console-state.test.js) §21。

---

## 1. 为什么需要它（不是"配置备份"的仪式，是一类反复发生的真实事故）

`persistConfig()` 写 `config.json` 时用的是**显式字段白名单**：它逐个字段构造一个 `out` 对象，
没被列进去的字段**一律不写**。所以只要往渠道上加一个新字段、忘了同步白名单，
**"保存任意一个渠道"就会把所有渠道的该字段一起抹掉**——而且是静默的、没有任何报错。

这不是假设，PT29 一族已经连发四例：

| 版本 | 被抹掉的字段 | 现场症状 |
| --- | --- | --- |
| PT29 | `weight` | 权重保存后被"归零"，分流比例永远一样 |
| v1.18.33 | `dropParams` | 「不发这些参数」保存后失效，又把上游不认的参数发出去了 |
| v1.18.41 | `notionAttachments` | 内联附件"明明开了"，下一轮就没了 |
| v1.18.46 | `firstChunkTimeoutMs` / `timeoutMs` | 渠道级超时保存后回默认，"这家慢"的配置反复丢失 |

**更难的是"抹掉之后查不出来"**：`config.json.bak` 只保留**上一次**，而控制台一次批量保存
（或一次"全部渠道逐条保存"）就把上一份也覆盖了。于是用户手里只剩"我记得配过"和一份
"看起来很正常"的配置文件——**没有任何副本能回答"到底少的是哪个字段"**。

代际要解决的正是这个：**留一份能对照的、时间有序的历史**，并且差异要能自己算出来、
字段名要能直接念出来。

---

## 2. 机制

### 2.1 存什么、存哪

| 项 | 值 |
| --- | --- |
| 目录 | `ZZCSAPI_CONFIG_HISTORY_DIR`，缺省 = `config.json` 同级的 `config-history/`（容器里是 `/app/config-history`） |
| 索引 | `<目录>/index.json`：`{ version: 1, entries: [{ seq, at, hash, bytes, reason, channels }] }` |
| 快照 | `<目录>/gen-000123.json`：**那一代 config.json 的原文**（逐字节，连字段顺序与缩进都保留） |
| 保留 | `ZZCSAPI_CONFIG_HISTORY_MAX`，默认 20，钳到 1–100；**淘汰时连文件一起删**，不留"能点开但不在列表里"的幽灵代 |
| 提示 | 快照是**整份配置原文**，含全部渠道明文 `apiKey` ⇒ 目录已在 `.gitignore`，且 `/admin/api/config/history` 一律**掩码**下发（见 §5） |

索引用「先写临时文件再 `rename`」落盘——半截索引比没有索引更难查。
快照文件同样是**原子写**（v1.18.85 起）：几 KB 的一次写虽然不会出现"写一半"的中间态，
但**进程被 kill 或磁盘写满**照样会留下半截快照，而回滚读到坏代时只会报 `snapshot file missing or corrupt`，
排查方向离真因很远。索引与快照现在共用 `writeFileAtomic()`（见 §2.4）。

### 2.2 何时存

`persistConfig()` 的**第一行**（在 `copyFileSync` 到 `.bak` 与 `writeFileSync` 之前）：

```js
snapshotConfigForHistory('save');
```

顺序是关键：**必须在写文件之前**。存"写完之后的那一份"等于存了新版本，回滚只会回到同一个状态
（守卫测试 §0 用 `indexOf` 把这条顺序钉住了）。

触发点覆盖所有落库路径：渠道 upsert / 删除、`/admin/api/settings`、封禁名单变更、密钥轮换、
导入类端点（codex / genspark）——**只要它调了 `persistConfig`，就有一代**。

### 2.3 两条防退化设计

- **hash 去重**：与**最近一代**内容相同就不存。否则控制台轮询式保存十次，环上全是同一个状态，
  真正该回滚的那一代反而被顶掉——这是"有历史但没得回滚"的经典死法。
  注意语义是"与最近一代比"，不是"与任意一代比"：A → B → A 会存三代（A、B、A），这是刻意的，
  因为"回到 A 的那一刻"本身就是有价值的信息。
- **异常一律吞掉**：`snapshotConfigForHistory` 内部 `try/catch` 到底，日志一行 `[history] 快照失败（不影响配置落盘）`。
  历史是**补救手段**，不是落盘的前置条件——目录只读、磁盘满、JSON 坏掉，都不许让保存失败。

另外：写入 `reason`。目前出现的值有 `save`（常规保存）与 `before-rollback`（回滚前留的那一代）。
列表接口把它原样给出，于是"这一代是怎么来的"不用猜。

### 2.4 落盘一律原子写（v1.18.85）

`writeFileAtomic(target, text, encoding)` 就是三件事：**同目录 tmp → 写 → fsync → rename**。

为什么加这一层：`persistConfig` 长期用裸 `fs.writeFileSync(CONFIG_PATH, ...)` **直接覆盖正主文件**。
进程在写盘中途被 kill（控制台保存、一键回滚、Ctrl+C 撞在同一毫秒）或磁盘在这几 KB 上写满，
盘上留下的就是**半截 JSON**——而 `loadConfig` 里 `JSON.parse` 没有兜底，
于是"上一次保存被打断"直接变成"网关起不来"，报错还是 `Unexpected end of JSON input`。
本项目其实早就知道这个模式（同一个文件里的 `writeHistoryIndex` 一直是 tmp+rename，注释还写着
「半截索引比没有索引更难查」）——**索引用了，正主忘了用**。

三条纪律：

| 纪律 | 理由 |
| --- | --- |
| tmp 与目标**同目录** | 跨盘 / 跨文件系统 `rename` 会退化成 copy+unlink，中途失败照样半截 |
| 先 `fsync` 再 `rename` | 不 fsync 时断电可能让目录项先于内容落盘，rename 后拿到"长度对、内容空"的文件——比半截更难查 |
| 失败清理 tmp | 写一半抛异常时删掉 `.tmp`，别在目录里越堆越多；清理失败不许掩盖原始异常 |

**第四条：目标不可替换时降级，绝不把进程打挂（容器实测补的）。**
Docker 的 `-v ./config.json:/app/config.json` 是**单文件挂载**，容器里那个路径是**挂载点本身**，
`rename()` 到它必然失败。第一版没兜这条，实测"点一次保存渠道 → 网关 `Exited(1)`"：

```
Error: EBUSY: resource busy or locked, rename '/app/.config.json.1.sawulnov.tmp' -> '/app/config.json'
    at writeFileAtomic (/app/server.js:45:8)
    at persistConfig (/app/server.js:3794:3)
```

这不是"写失败"，是"这个路径不支持原子替换"。处置：捕获 `EBUSY` / `EXDEV` / `EPERM` / `EACCES`，
**退化成原地覆写**（即 P0-1 之前的行为），并打一行 `[atomic] … 已降级为原地覆写` 说明原因与改法；
其它错误（如 `EIO` 磁盘满）仍如实抛出，不吞。

**本机的真实原因是 `EXDEV` 跨设备，不是 `EBUSY`**（实测 device 号）：`/app` 是 `dev=91`，
而 `config.json` / `usage.json` 是挂载点、`dev=72` ⇒ tmp 建在 `/app`（91）、目标在 72，跨设备 rename 失败。
`config-history/` 当时已是**目录**挂载（同为 72），所以它的快照原子性一直是好的——
**这恰好实测印证了"要原子就挂目录"**。

### 2.6 v1.18.86：统一数据目录（把原子性拿回来）

上面那条降级是**兜底**，不是目标状态。v1.18.86 直接把 compose 改成**一个目录装全部**：

```yaml
volumes:
  - ./data:/app/data          # config.json / config.json.bak / usage.json / config-history/ 全在里面
environment:
  ZZCSAPI_CONFIG: /app/data/config.json
  ZZCSAPI_USAGE: /app/data/usage.json
  ZZCSAPI_CONFIG_HISTORY_DIR: /app/data/config-history
```

挂目录后，tmp 与目标**同 device**，`rename` 成功，**原子性完整**；那行 `[atomic]` 降级日志正常情况不再出现。

配套改了 `USAGE_PATH` 的默认值：从 `__dirname` 改成 `path.dirname(CONFIG_PATH)`——否则即使
`ZZCSAPI_CONFIG` 指进 `/app/data`，`usage.json` 仍会落在 `/app`（另一 device），每次 flush 都 `EXDEV` 降级。
代际快照目录本来就这么推导（`CONFIG_HISTORY_DIR`），这次只是把用量对齐到同一姿势。

> **⚠ 同时修掉一个被掩盖的缺陷**：`Dockerfile` 原来写的是
> `COPY config.example.json ./config.json`——把模板**改名**成 `config.json` 塞进镜像。
> 于是 `EXAMPLE_PATH`（`/app/config.example.json`）在镜像里**根本不存在**，`loadConfig` 的首启分支
> `fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH)` **永远走不通**。旧部署靠"单文件挂载盖住它"才没暴露；
> 一旦改挂目录（宿主机首次没有 `config.json`），就只剩一句「配置文件不存在: /app/data/config.json」。
> 现在保持原名 `./config.example.json`，目录挂载下宿主机为空 → 自动从模板生成 → 正常首启。
> 由 `test/docker-image-files.test.js` 的"那段 COPY 不得再把模板改名"一条守住。

| 部署形态 | 保存/回滚 | 原子性 |
| --- | --- | --- |
| 本机 `node server.js` | 正常 | ✅ 完整（rename 原子替换） |
| compose 挂 `./data` 目录（**v1.18.86 起默认**） | 正常 | ✅ 完整 |
| 旧式单文件挂载 `./config.json:/app/config.json` | 正常（降级原地覆写 + 日志） | ⚠️ 只保"不崩、能存"；被杀时仍可能半截，靠启动三跳自愈兜 |

> 单文件挂载是**老部署**的兼容姿势：仍能用（降级路径留着，且打了明确日志），只是少了那层断电保护。
> 迁移方式：把根目录的 `config.json` / `usage.json` / `config-history/` 挪进 `./data/`，然后 `docker compose up -d`。

落盘点全覆盖：`config.json`（保存 / 回滚 / 首启密钥）、`usage.json`、`config-history/index.json`、
`config-history/gen-*.json`。**新加落盘点一律走它，不要再写裸 `writeFileSync`**——守卫测试会拦。

### 2.5 启动自愈：正主坏了怎么起得来（v1.18.85）

原子写把"写坏正主"的概率压到接近 0，但**已经坏掉的盘**（历史遗留、外部工具改坏、断电）仍然要能起。
`loadConfig` 因此走一条**三跳退路**，顺序是"离现在最近的可用版本优先"：

| 跳 | 来源 | 说明 |
| --- | --- | --- |
| ① | `config.json` | 正主；能解析且结构合法就直接用（绝大多数启动走这条，零额外开销） |
| ② | `config.json.bak` | `persistConfig` 每次写前都会复制一份 ⇒ 它就是"上一个好版本" |
| ③ | `config-history/gen-*.json` | 按 `seq` **从大到小**取第一个能解析的（代际是整份原文，v1.18.83 起就有） |

命中 ② 或 ③ 时做三件事，并打印一段 `════ 配置自愈 ════` 日志：

1. **坏文件留档**成 `config.json.corrupt-<ISO时间戳>`——不直接覆盖现场（下一次还要靠它查真因）；
2. **把找到的好版本原子写回正主**——否则每次重启都要再走一遍退路，而退路依赖的 `.bak`/代际
   可能在下一次保存里就被顶掉；
3. 如实报告用的是哪一跳（日志里写 `config.json.bak` 还是 `代际快照 gen:12`）。

**三跳全坏 ⇒ 必须报错退出**（非 0），绝不能"静默用空配置起来"——那等于把用户全部渠道丢掉
还说启动成功了。错误文案会点明"已尝试 `.bak` 与代际快照，均不可用"，把排查方向直接写出来。

> **v1.18.88 补的一处缺口：「读不到」与「内容坏」是两种病，必须都能走退路。**
> 原先 ① 那一步读正主的代码**不在 `try` 里**：`existsSync` 为真而 `readFileSync` 抛错时（`EACCES` 权限/属主不对、
> `EISDIR` 路径被占成目录、`EPERM`），异常直接穿出模块初始化 ⇒ **进程带着裸栈退出，②③ 一次都不会试**，
> 而上面那句"正主坏了（或读不到）"里的"读不到"从来没实现过。触发场景都很实在：bind mount 属主/权限配错、
> 以非 root 跑而 `config.json` 是 `600 root`、路径被占成目录。
> 现在读正主也包在 `try` 里，失败即当作"这一跳不可用"继续走 ②③；三跳全坏时的报错**单独点明是"读不动"
> 并带上系统错误码**（别把人引去查 JSON 语法）；且"读不动"**不留 `.corrupt-`**——没有内容可留档，
> 造一个 0 字节的假现场只会误导。回归：`test/config-atomic-write-e2e.test.js` §5（把正主换成同名目录，
> 可移植地模拟 `EISDIR`，断言"起得来 + 恢复到 .bak 那份 + 日志点明读不动 + 不留假现场"）。

> 与回滚的分工：**回滚**是用户在控制台里主动选一代（人决定回哪），**自愈**是启动时机器自己找
> 最近一个能用的（没人操作）。两者共用同一批快照文件，但触发路径与语义完全不同。

---

## 3. 三个端点

> 控制台侧消费的就是这三个（`build/app.js` 的 `vHistory` 一族，v1.18.84）：列表 → 详情 → 回滚。
> 前端只取**元信息与 `diff`**，`config` 那段掩码视图**不进 DOM**（页面里连 `apiKey` 这个词都不出现，
> `test/console-state.test.js` §21 有守卫）；回滚在 UI 上是**两步确认**（`armConfirm`），第一下不发请求。

### `GET /admin/api/config/history`

列表，新的在前。

```json
{ "ok": true, "max": 20, "dir": "/app/config-history",
  "entries": [ { "seq": 12, "at": "2026-10-20T09:12:44.318Z", "bytes": 4213,
                 "reason": "save", "hash": "9f2c1a…(12位)", "channels": 9 } ] }
```

**只有元信息**：seq / 时间 / 字节 / hash 前 12 位 / 触发原因 / 渠道数。
这里漏一个字段都算破纪律——列表是"看有几代"，不是"取配置"。

### `GET /admin/api/config/history/{seq}`

某一代的**掩码视图** + 与**当前磁盘上那份**的字段级差异。

```json
{ "ok": true, "seq": 12, "at": "…", "hash": "…", "channels": 9,
  "willTouchKeys": false,
  "config": { "channels": [ { "id": "huidev", "apiKey": "sk-h…9f21", … } ], "port": 8787, … },
  "diff": {
    "channels": {
      "added":   ["新加的渠道 id"],
      "removed": ["那一代有、现在没了的 id"],
      "changed": [ { "id": "huidev", "fields": ["customField", "priority"] } ]
    },
    "groups": ["security"],
    "keysIgnored": false } }
```

- `config` 一律掩码：`apiKey` / `accessToken` 走 `maskSecret()`（`sk-h…9f21`），
  `adminKey` / `gatewayKey` **整个字段删掉**，`auth` 只回 `{ redacted: true }`。
  理由：详情是**看差异**的口子，不是**下载密钥**的旁路。要原文请走按需揭示端点
  （`GET /admin/api/channels/{id}/key` 等），那条路有自己的鉴权与 `no-store` 纪律。
- `diff` 是排障的主要价值：`changed[].fields` 直接告诉用户**少的是哪个字段**，
  不用再拿两坨 JSON 人眼对齐。
- `groups` 列出变化的顶层配置组；`keysIgnored` 表示"两边的密钥段不一样"（回滚时会被刻意忽略，见 §4.2）。

### `POST /admin/api/config/rollback`

```json
请求：{ "seq": 12 }
响应：{ "ok": true, "rolledBackTo": 12, "at": "…", "channels": 9,
        "keysPreserved": true, "needsRestart": ["cooldown"], "diff": { … } }
```

执行顺序（顺序本身就是语义）：

1. 取快照并**按与 `loadConfig` 同一套硬规矩校验**：每个渠道必须有 `id` / `baseUrl` / `apiKey`
   （少一样就 400，`config.json` **一个字节都不动**）。理由：回滚到一个起不来的配置，
   等于用补救手段制造事故，而且那种错误要等到**下次重启**才暴露。
2. 算 `diff`（回滚后再算就看不到了）与 `needsRestart`。
3. `snapshotConfigForHistory('before-rollback')`——把"现在"也存一代，**回滚本身可撤销**。
   （去重规则同样适用：若"现在"与环上最近一代内容相同，就不会多存一份——那种情况下该状态**本来就在环里**，
   照样能回滚回去，所以不需要为了"可撤销"而强行存一代重复的。）
4. 应用到运行期（见 §4.1）。
5. 把「快照本体 + 当前密钥段」整份写回 `config.json`。

`diff` 报的是「回滚前 → 回滚后」。`willTouchKeys` 固定 `false`。

---

## 4. 回滚语义

### 4.1 哪些**立即生效**，哪些要**重启**

| 配置 | 回滚后 |
| --- | --- |
| `channels`（含 `models` / `dropParams` / `headers` / 超时 / `weight` / 任意扩展字段） | **立即生效**（`upsertChannel` 深拷贝写入；快照没有的 id 会删掉，并按 DELETE 渠道的规矩清 `SWRR_*` / `AUTO_STATE` 旧权值） |
| `sessionAffinity` / `rateLimit` / `metrics` / `thinkingReplay` / `autoWeight` | **立即生效**（整份覆盖 + `applyRuntimeSettings()` + `AUTO_W`） |
| `security`（含 `bannedIPs`、`trustedProxy`） | **立即生效**（`SECURITY_BANNED` 是启动时建的集合，回滚会重建它） |
| `port` / `health` / `retries` / `cooldown` | **只写进文件**，`needsRestart` 里点名。它们是模块初始化时算成 `const` 的（`PORT` / `HEALTH` / `PER_CHANNEL_RETRIES` / `COOLDOWN`），热改一半比不改更糟 |
| `auth` / `adminKey` / `gatewayKey` | **不回滚**，保持当前值（见 §4.2） |

渠道的**运行期状态**（冷却、延迟、探测结果、自动权重健康分）不会因为回滚被重置——
回滚的是配置，不是"这家渠道刚才失败过"这件事。相反，**被删掉**的渠道会按删除渠道的规矩
清掉它的轮询权重，避免同 id 加回来时继承旧权值。

### 4.2 为什么**不动密钥段**（这条是硬纪律）

回滚配置 ≠ 回滚门锁。若把快照里的 `auth` / `adminKey` / `gatewayKey` 一起写回去，会出现两种事故：

1. **把用户锁在门外**：控制台已经在用轮换后的新管理密钥，回滚到旧的 ⇒ 下一次请求 401，
   而"回滚"这个动作通常正是在出事后手忙脚乱时做的。
2. **把旧钥匙复活**：轮换掉的密钥本该永久失效（`rotateKeys()` 还清了全部会话），
   被一份历史快照顺手捞回来，等于让一次轮换白做。

所以 `buildRollbackConfig()` 用**当前**的密钥段覆盖快照里的，响应里用 `keysPreserved: true` 明说。
想改密钥请走 `/admin/api/keys`，那是唯一该动它们的地方。

### 4.3 回滚之后，`config.json` 长什么样

写回的是「快照解析出来的对象 + 当前密钥段」，再 `JSON.stringify(next, null, 2)`。
所以**白名单挡不住的字段也能回来**（这正是本功能存在的理由）——`customField` 这类
"没人认识但确实在配置里"的字段会完整复原。

⚠️ 但请注意边界：**下次任何人保存一次渠道，`persistConfig` 的白名单又会把它抹掉。**
代际是**补救**，不是修复白名单本身。真要让字段不再丢，仍然必须把它加进
`persistConfig` 的字段清单（AGENTS.md §2「渠道字段的三态语义」）。

---

## 5. 纪律（破一条都是事故）

1. **快照含明文密钥** ⇒ 目录必须 gitignore；**列表接口一个字都不给**、**详情接口一律掩码**。
   否则"回滚功能"就成了继 `/admin/api/channels/{id}/key` 之后第二个密钥出口，而它更容易被忽视。
2. **hash 去重**（与最近一代比），别让同一状态占满整个环。
3. **任何异常都不许影响落盘**：历史坏了不能让保存失败。
4. **不动密钥段**（§4.2）；**回滚前先存一代**（可撤销）；**校验不过不改文件**。
5. **冷启动字段只写文件、如实报 `needsRestart`**，不要假装热生效。

---

## 6. 运维

**目录位置**（容器）：v1.18.86 起随配置一起放在 `./data/`，compose 只挂一行 `./data:/app/data`，
快照目录是 `/app/data/config-history`（由 `ZZCSAPI_CONFIG` 的 dirname 推导，`CONFIG_HISTORY_DIR` 与
`USAGE_PATH` 共用同一姿势）。**必须挂目录**：挂成 `./data/config-history.json:/app/data/config-history.json`
这种单文件时，宿主机没有该文件 Docker 会建一个**同名目录** ⇒ 服务端写文件 `EISDIR`（启动就报错）；
而且单文件挂载是挂载点、与 tmp 跨 device ⇒ 原子写的 `rename` 必然失败。
宿主机上 `./data/` 里全是明文密钥与用量记录，别拷进仓库、别丢进共享盘、别塞进工单附件（已在 `.gitignore`）。

**清理**：直接删目录里的 `gen-*.json` 就行，但**要同时改 `index.json`**（否则列表里会出现点不开的代）。
最省事的做法是把整个目录删掉——网关会重新建，历史从空开始（不影响 `config.json`）。

**启动自愈留下的两类文件**（v1.18.85，都在 `config.json` 同级，且都含明文密钥 ⇒ 已在 `.gitignore`）：

| 文件 | 何时出现 | 怎么处理 |
| --- | --- | --- |
| `config.json.corrupt-<时间戳>` | 启动时正主解析失败、从 `.bak`/代际恢复成功 | 保留一两份查真因，确认没用后**手动删**（它不会被自动清理，也不参与任何读取） |
| `.config.json.<pid>.<随机>.tmp` 之类 | 原子写进行中被强杀留下的半截 tmp | 正常不会残留（成功后 rename 掉、失败会 unlink）；看到就是某次被 `kill -9`，确认正主可解析后**手动删**即可，**不要**拿它当配置用 |

**典型排查姿势**：

```bash
# 1) 最近几代
curl -s -H "Authorization: Bearer $ADMIN" localhost:8787/admin/api/config/history | jq '.entries[:5]'

# 2) 拿最近一代看"现在的配置比它少了什么"（重点看 diff.channels.changed[].fields）
curl -s -H "Authorization: Bearer $ADMIN" localhost:8787/admin/api/config/history/<seq> | jq '.diff'

# 3) 确认无误再回滚
curl -s -X POST -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"seq":<seq>}' localhost:8787/admin/api/config/rollback
```

**什么时候它救不了你**：渠道的**上游密钥本身就错**、上游封号/额度耗尽、运行期统计（`usage.json`）
丢失——代际只管 `config.json`。

---

## 7. 已知边界

- 只覆盖 `config.json`。`usage.json`（用量统计）、`dump/`（请求体诊断）、内存里的限流/会话表都不在范围内。
- 快照是**整份**，不是增量；20 份 ≈ 几十 KB（渠道多、`models` 表大时会到几百 KB），不必担心体积。
- 回滚**不会重放**任何网络动作（不重新探测渠道、不重建 COOKIE 会话）；需要的话回滚后点一次「全部重探测」。
- 回滚不改 `port`，所以"回滚到另一台机器的配置"这种用法不成立（端口/绑定是部署项，不是配置项）。
- 代际是**补救**：它让"被抹掉的字段"能回来，但不会让下一次保存不再抹——见 §4.3 的提醒。
- 控制台「配置历史」页**按需拉取**（进页 / 点「重新读取」/ 回滚成功后），**不跟 8 秒轮询**：别人刚保存的一代不会自己跳进列表，点一下刷新即可。这是刻意取舍——代际只在"保存/回滚"时变，跟着轮询每 8 秒打一次纯属浪费。
- 页面只支持**整份回滚**（一键换回某一代），不支持"只回滚某几个渠道 / 某一组设置"：整份回滚 + 回滚本身可再回滚，已经覆盖"救回被抹掉的字段"这个真实场景，做部分应用反而要一套新的路径校验。
- **启动自愈是"救起来"，不是"修好"**：从 `.bak`/代际恢复出来的那一份，就是**那一刻**的内容——如果正主被外部工具改坏了某个字段，自愈只会把**上一份完整配置**写回，坏掉的那次改动不会保留（这正是想要的）。恢复后强烈建议去控制台核对一眼渠道，再存一次（存一次就会产生新的 `.bak` 与代际）。
- **原子写不保证"多写者安全"**：`writeFileAtomic` 只保证**单次写入**不会留下半截文件；同一台机器上**多个网关进程同时写同一份 `config.json`** 仍是"后写覆盖先写"。一个部署只跑一个网关实例是前提（`docker-compose` 也是单实例）。

---

## 8. 守卫测试

`node test/config-atomic-write-e2e.test.js`（29 项断言，零依赖、不出网、临时目录，v1.18.85）：

- §0 装配守卫：`writeFileAtomic` 的 tmp 与目标**同目录**、`fsync` 在 `rename` **之前**、失败清理 tmp、
  **配置 / 用量 / 历史索引 / 代际快照四处都不再有裸 `writeFileSync`**（剥掉块注释后再找，否则会被
  说明注释里的反例误报——本用例第一版就栽在这）、`loadConfig` 走 `readConfigWithFallback`、
  恢复顺序是「正主 → `.bak` → 代际快照」、恢复后原子写回正主、坏文件留档 `.corrupt-*`、
  两端共用 `CONFIG_HISTORY_DIR`、`.gitignore` 覆盖临时文件与坏文件留档。
- §1 真链路：保存后目录里**没有 `.tmp` 残留**、`config.json` 是完整合法 JSON、`.bak` 已生成。
- §2 **正主写坏 → 从 `.bak` 恢复**：仍能启动、写回合法 JSON、恢复出的是两个渠道的完整版本、坏文件留档、无 `.tmp` 残留。
- §3 **正主与 `.bak` 都坏 → 从代际快照恢复**（正对着"一次批量保存把 `.bak` 也覆盖了"的现场）。
- §4 **三跳全坏 → 非 0 退出**，且错误文案点明"已尝试 `.bak` 与代际快照"（绝不许静默用空配置起来）。

`node test/config-history-e2e.test.js`（43 项断言，零依赖、不出网、临时目录）：

- §0 装配守卫：快照调用必须在写文件**之前**、去重比较的是最近一代、列表视图不含 `apiKey`/`config`、
  详情掩码三件套、`buildRollbackConfig` 覆盖三个密钥字段、回滚前存 `before-rollback`、
  `.gitignore` 有 `config-history/`、compose 挂的是**目录**（不是文件）。
- §1 真链路（临时网关 + 假上游）：保存 → 字段被白名单吞掉 → 列表/详情/差异 → 回滚 →
  **字段回到 `config.json`** 且**运行期也认**；回滚可撤销；hash 去重；密钥段在回滚后仍是新轮换值
  且**新管理密钥照常可用、旧密钥仍然失效**。
- §2 环形上限（`ZZCSAPI_CONFIG_HISTORY_MAX=3`：条数封顶 + 环外文件真被删）与坏快照
  （渠道缺 `apiKey` → 400，且 `config.json` 一个字节没动）。

控制台侧的守卫在 **`node test/console-state.test.js` §21**（29 项，从 `build/app.js` 现抠真实函数在 DOM 桩里真跑）：
结构侧守「`render()` 与 `go()` 两张分发表都注册」「代际不进 `loadAll`」「回滚走 `armConfirm`」「两个渲染函数里没有 `apiKey`」；
行为侧守「差异点名到字段（`customField`/`timeoutMs`）」「**掩码视图里的假原文一个字都不进 DOM**」
「第一下不发请求、第二下 POST 只有 `{seq}`」「回滚成功后作废缓存并重拉」「404 原文直显」「空代际是有指引的空态」。
