# 时光机 0.3.0 前后端审计报告

- 日期：2026-11-03
- 平台：Windows 11 专业版 10.0.26300（x64）
- Node：`v24.19.0`
- Git：`2.56.0.windows.2`
- 宿主类型定义：`@deepseek-ai/dsh 0.2.2-alpha.3`
- 版本：`dsh-time-machine 0.2.0` → `0.3.0`
- 范围：`lib/`（宿主）、`shared/protocol.js`、`src/client/`（浏览器）、
  `client/client.js` 产物、`scripts/`、`tests/`、`docs/`
- 结论：**未发现可被远程利用的越界写入/删除或鉴权绕过**；发现并修复 21 项
  正确性、安全性、数据保持与可用性问题，其中 5 项 P1、9 项 P2、7 项 P3。
  数据格式（store version 1）、影子仓库布局与宿主 API 依赖不变，已有还原点
  无需迁移。

## 1. 审计范围与方法

| 层 | 重点文件 | 审查重点 |
|---|---|---|
| 快照 | `lib/git.js` | 快照范围、忽略规则、持久 index、`.gitattributes`、路径通配、临时文件 |
| 恢复 | `lib/restore.js`、`lib/engine.js` | 计划/执行/回滚三层路径校验、忽略文件过滤、journal、状态机、忙碌判定 |
| 存储 | `lib/store.js`、`lib/config.js` | 元数据上限、损坏恢复、事务性写盘、配置归一化 |
| 宿主接线 | `lib/index.js`、`lib/server.js`、`lib/surfaces.js` | 会话事件、工作目录变化、引擎缓存、HTTP 鉴权、命令/工具 |
| CLI/安装 | `lib/bin.js`、`scripts/install.mjs` | `doctor` 容错、恢复确认、profile 清单原子写 |
| 浏览器 | `src/client/*`、`client/client.js` | 请求超时、竞态、设置项、焦点、错误 i18n、样式热重载 |

方法：

1. 逐文件静态审查，沿三条数据流走：
   - 输入 → 路径 → Git 命令 → 文件写入；
   - 失败 → 安全点 → 回滚 → journal；
   - 会话事件 → 引擎缓存 → 轮次状态。
2. 对可疑点写临时复现脚本（真实 Git、真实工作区、junction/符号链接、构造
   journal、构造损坏元数据），确认能复现后再修。
3. 修复后补回归测试，跑完整测试、构建、离线视觉验收。
4. 对照 DSH 0.2.2-alpha.3 的 `Session`、`webServer`、`working-directory` 类型
   定义复核宿主 API；Host 测试使用 fake `webServer`，不是真实 GUI 端到端。

## 2. 安全结论

- **影子仓库隔离仍成立**：`GIT_DIR`/`GIT_WORK_TREE`/临时 index 都是插件私有；
  用户仓库的 index、objects、HEAD、refs 不被写。`tests/engine.test.mjs` 有逐
  字节对比。
- **路径校验仍是双层的**：计划阶段与执行阶段都做 scope、逃逸、`.git`、目录
  冲突、大小写冲突、祖先符号链接与大小校验；本次补齐了**删除路径的祖先
  检查**，并在 Windows 上拒绝结尾点/空格与设备名。
- **恢复计划会按当前忽略规则过滤**：即使目标快照创建于排除规则之前，当前
  被忽略的文件也不会被写回或删除。
- **HTTP 写接口仍有进程内控制密钥**，所有路由只接受回环请求；`Host`/`Origin`/
  转发头检查在路由入口统一执行；`timingSafeEqual` 与 1 MiB 请求体上限不变。
- **Git 调用不经过 shell**，参数由插件构造；环境变量白名单式清洗，并新增
  `GIT_ATTR_NOSYSTEM=1`。
- **未发现**：远程任意文件写/删、`..` 逃逸、`.git` 改写、未授权写接口调用、
  通过 HTTP body 注入命令行参数。

### 2.1 本地威胁模型说明

以下问题需要本机工作区或插件数据目录的写权限，不是远程攻击面，但仍会导致
数据损坏或越界删除，因此按 P1/P2 处理：

- 删除路径的父目录在计划后被换成符号链接（TOCTOU）；
- 伪造/损坏的 `journals/*.json`；
- 数据目录配置错误（指到工作区根或经 junction 指到工作区）。

## 3. 发现与处置

严重度：P1 = 数据丢失/越界写删/持续磁盘问题；P2 = 错误状态、错误恢复或用户
可见功能失效；P3 = 健壮性、一致性与可维护性问题。

| ID | 级别 | 位置 | 问题 | 处置 | 回归 |
|---|---|---|---|---|---|
| F-01 | P1 | `lib/git.js` `snapshotTree` | 持久 index 保留上一轮已跟踪条目；新增 `excludes` 或 `.gitignore` 后，旧文件仍被 `write-tree` 写进新快照，违反“忽略文件不记录” | 每次 `git add` 后用 `ls-files -z -ci --exclude-standard` 找出当前被忽略的缓存条目，再以 `update-index --force-remove` 移除 | `新增排除规则后，已缓存的文件不再进入新快照` |
| F-02 | P1 | `lib/restore.js` `buildRestorePlan` | 目标快照可能创建于排除规则之前；恢复旧快照会把现在被忽略的文件写回，精确模式甚至可能删除/覆盖 | 计划阶段用 `git check-ignore --no-index` 过滤当前忽略路径，并同步移除 oversized 列表项 | `恢复旧快照时跳过后来才被排除的文件` |
| F-03 | P1 | `lib/git.js` `createBinding`、`writeExcludes` | `DSH_TIME_MACHINE_DATA_DIR` 等于工作区根时影子仓库快照自己；数据目录经 junction 指到工作区时可绕过排除；目录名以 `!`/`#` 开头或含通配字符时排除失效 | 数据目录先 `canonicalPath`；与快照根相同直接 `BAD_DATA_DIR`；强制排除改为锚定、转义的字面路径 | `数据目录等于快照根时拒绝绑定`、`数据目录位于工作区内时…` |
| F-04 | P1 | `lib/restore.js` `applyEntries` | 删除/回滚分支没有检查祖先目录。父目录在计划后变成指向工作区外的 junction/symlink 时，`rm` 会删外部文件 | 在计划、执行和回滚路径统一调用 `assertSafeParents`；Windows rename 回退不再对符号链接 `chmod` | `删除计划遇到父目录符号链接时拒绝…` |
| F-05 | P1 | `lib/store.js` `load` | 元数据加载硬编码 `.slice(0, 500)`，但配置允许 1000；重启后时间线静默丢一半，剩余 refs 变孤儿 | 上限改为 `CONFIG_LIMITS.maxCheckpoints[1]`，并记录超限 issue | `配置索引加载上限…（1000）` |
| F-06 | P2 | `lib/engine.js` `journalFile` / `listJournals` | journal 的 `planId` 未校验。构造 `planId: "../victim"` 的日志可让 `recover` 删除日志目录外的文件 | 严格 `PLAN_ID_RE`；文件名必须等于 `<planId>.json`；结构校验（commit/tree/safetyId/createdAt） | `恢复日志的 planId 不允许路径穿越` |
| F-07 | P2 | `lib/index.js` `endTurn` | 轮次中切换工作目录后，`endTurn` 用新 cwd 找引擎，旧引擎的 `activeTurns` 永远不清，旧工作区永久显示忙碌 | 轮次开始记录 `enginePromise`，结束/收尾都使用同一个引擎 | `会话在轮次中切换工作目录后…` |
| F-08 | P2 | `lib/index.js` `engineFor` | 缓存键用未 canonical 的路径；同一工作区经 junction、符号链接或不同拼写到达时会建两个引擎写同一份元数据，时间线分叉 | 先 `canonicalPath` 再取缓存键；`createBinding` 也接收 canonical 路径 | `同一工作区通过 junction/符号链接访问时共用引擎…` |
| F-09 | P2 | `lib/config.js` `normalizeConfig`/`update` | `excludes: null` 或字符串会得到 `undefined`，无 issue 地清空原规则；写盘失败时内存配置已改，面板显示未持久化的值 | 非数组保留原值并记 issue；写盘成功后才提交；写操作串行化 | `配置更新写盘失败时…`、`配置归一化…` |
| F-10 | P2 | `lib/git.js` `ensureShadowRepo` | `info/attributes` 只写一次且只禁用 `text`/`filter`；工作区 `.gitattributes` 的 `ident` 会把 `$Id: xxx $` 改写成 `$Id$`，`working-tree-encoding` 也会转码 | 每次确保仓库时重写属性；新增 `-ident -working-tree-encoding` | `工作区 .gitattributes 的 ident 不会改写快照字节` |
| F-11 | P2 | `lib/bin.js` `commandDoctor`、`lib/git.js` `repoStats` | 坏记录（缺 `commit`）或影子仓库尚未创建时，`git` spawn 的 cwd 不存在，`doctor` 以 `spawn git ENOENT` 崩溃 | `repoStats`/`runGc` 先检查 shadow 目录；`doctor` 用 `isValidCheckpoint` 过滤并容错 | `CLI doctor：元数据里的坏记录不会让命令崩溃` |
| F-12 | P2 | `lib/engine.js` `recoverJournal` | `/rewind recover` 与 CLI 回滚不检查会话忙碌，可能在 Agent 写入期间回滚 | 入口与串行链内各检查一次 `isBusy()`，返回 `SESSION_BUSY` | `会话运行中拒绝执行 journal 回滚` |
| F-13 | P2 | `src/client/api.js` | 超时定时器在 `fetch` 返回响应头后就清除；body 卡住会永久挂起。恢复客户端 300s，小于宿主 600s 回滚上限 | 计时器覆盖 `response.text()`；快照 180s、计划 300s、恢复 900s | 客户端 bundle 契约 + 代码审查 |
| F-14 | P2 | `src/client/settings.js` | 设置页只暴露 7 个字段，`autoGc`、`restoreTimeoutMs`、`maxRestoreFileBytes` 无法在面板修改，与 README 不符 | 新增自动 GC 开关、恢复超时、单文件上限（MiB）并更新载荷测试 | `设置草稿与提交载荷互转` |
| F-15 | P3 | `lib/engine.js` `reconcileRefs` | 崩溃遗留的 `refs/time-machine/plans/*` 永远不清理，引用对象无法被 GC | 启动时删除超过 2×TTL 的 plan 引用；保留宽限期避免 CLI 误删宿主计划 | `启动时只清理已过期的 plan 引用…` |
| F-16 | P3 | `lib/git.js` `snapshotTree` | `git add`/`write-tree` 失败时临时 index 与 `.lock` 留在 `tmp/`，`doctor` 只能按 24 小时报告 | 所有失败路径与索引重建路径统一 `cleanupIndex` | 代码审查 |
| F-17 | P3 | `src/client/panel.js`、`index.js`、`format.js` | 面板打开后焦点仍在触发按钮；关闭不还焦点；样式标签已存在时不更新旧 CSS；回滚失败/超时等错误在英文界面回退中文 | 聚焦面板、关闭还焦点；复用 style 时更新 `textContent`；补齐 6 个错误码中英文案，错误横幅 `role=alert` | 客户端构建 + 离线视觉 |
| F-18 | P3 | `scripts/install.mjs` `writeManifest` | 生成 temp 后直接覆盖写 profile `package.json`，temp 从未 rename；崩溃可能留下半个清单。Windows 编辑器/PowerShell 5 写入的 BOM 也会让读取失败 | temp + `renameSync`，EPERM/EACCES 时回退删除再 rename；读取时剥离 `\uFEFF` | 临时 profile 实测安装/卸载 |
| F-19 | P3 | `lib/bin.js` `commandRecover` | `recover --plan <不存在>` 仍以 0 退出，脚本误判成功 | 记录 matched，未命中输出提示并 `exitCode=1` | 代码审查 |
| F-20 | P3 | `lib/util.js` `insidePath` | Windows 会规范化结尾点/空格，`.git.` 实际可指向 `.git`；`CON`/`NUL` 等设备名未拦截 | Windows 上归一化每段并拒绝设备名/空段 | `路径安全…` 增加 Windows 断言 |
| F-21 | P3 | `lib/engine.js` `recordError`/`forgetSession` | 预期的 `SESSION_BUSY` 也写入 `lastError` 横幅；会话销毁只清理当前 cwd 引擎的 `afterAttempts` | `SESSION_BUSY` 不记 lastError；销毁时通知所有引擎并清理 session 前缀 | Host 测试 / 代码审查 |

### 3.1 忽略规则为什么会“记住”旧文件（F-01）

影子仓库把 `.git/index` 当 stat 缓存，下一轮复制后只对当前 scope 做
`git add --all`。Git 不会因为一个已跟踪文件后来被 ignore 就把它从 index 删除。
修复前实测：

```text
snapshot1 tree: a.txt + secret.txt
配置 excludes += secret.txt
snapshot2 tree: 仍然是同一个 tree（secret.txt 仍在）
```

修复后同一场景 tree 只剩 `a.txt`；继续修改 `secret.txt` 也不会进入新快照。

### 3.2 旧快照恢复与当前忽略规则（F-02）

只修 F-01 仍不够：目标快照是**过去**的树，里面本来就有 `secret.txt`。修复前
计划从 target 树取 blob，会把 `s1` 写回工作区；修复后在计划阶段用当前
`info/exclude` + `.gitignore` 调 `git check-ignore --no-index` 过滤，示例计划
只写 `a.txt`，`secret.txt` 保持 `s2` 不变，并在 warnings 中说明跳过原因。

### 3.3 数据目录指到工作区根（F-03）

修复前把 `DSH_TIME_MACHINE_DATA_DIR` 设为工作区根，第二次快照的 tree 为：

```text
a.txt
repos/<key>/binding.json
repos/<key>/empty.gitconfig
repos/<key>/tmp/index-<pid>-<ts>
repos/<key>/tmp/index-<pid>-<ts>.lock
workspaces/<key>.json
```

每次快照都包含临时 index，永远判定为“有变化”，磁盘持续增长。现在
`createBinding` 在比较 canonical dataDir 与快照根后直接拒绝，并给出明确修复
建议。数据目录只是位于工作区内部（不等于根）时仍支持，改为锚定字面排除。

### 3.4 删除路径的祖先符号链接（F-04）

`applyEntries` 的写入分支一直有 `assertSafeParents`，删除分支没有。修复前
构造：

```text
workspace/link -> outside（Windows junction）
entries = [{ path: 'link/victim.txt', status: 'D' }]
```

`applyEntries` 会删除 `outside/victim.txt`。修复后抛出 `UNSAFE_PATH`，外部
文件保留；计划阶段与回滚路径同样检查。

### 3.5 journal 路径穿越（F-06）

修复前构造 `journals/evil.json`：

```json
{ "planId": "../victim", "entries": [], "safetyCommit": "<valid>", "safetyTree": "<valid>" }
```

调用 `recoverJournal('../victim')` 后，`repoDir/victim.json` 被删除。修复后
`planId` 不匹配 `PLAN_ID_RE` 会被拒绝；文件名与内容不一致、缺少
`safetyCommit/safetyTree/safetyId` 的 journal 也不会进入列表。

### 3.6 工作目录切换与引擎缓存（F-07 / F-08）

修复前 Host 实测：

- `s1` 在 `ws1` 开始轮次，收到 `working-directory/change` 到 `ws2`，再
  `turn/end`；`ws1` 的另一个会话查询 status 仍是 `busy: true`。
- `ws1` 与指向它的 junction 分别建会话；先各查一次 status，再通过 junction
  建快照，真实路径会话的 `total` 仍为 0。

修复后前者 `busy: false`，后者同一引擎返回 `total: 1`，且
`checkpoints[0].id` 与创建结果一致。

### 3.7 客户端超时与设置页（F-13 / F-14）

旧 `send()` 在 `fetch` 解析完响应头后就 `clearTimeout`，`response.text()` 没有
超时保护；恢复请求 300s 到期时宿主可能仍在 600s 的回滚预算内。现在计时器
覆盖整个响应读取，且客户端上限大于宿主上限。设置页新增三个字段后，离线下
的 `settings-light.png` 重新生成，面板显示 0.3.0、`120000`、`64` 和自动 GC
开关为开。

## 4. 未修复 / 残余风险

以下问题按 0.3.0 范围保留，或属于设计取舍：

1. **同工作区多进程没有跨进程文件锁**：宿主与 CLI 同时快照/恢复时元数据仍是
   last-writer-wins；plan 引用有 10 分钟崩溃清理宽限，checkpoint 孤儿引用不
   自动删除（避免误删另一个进程正在写的 ref），只由 `doctor` 报告。
2. **恢复期间不锁工作区**：`applyRestore` 在串行链内运行，但外部进程仍可写
   文件；恢复后复核会发现不一致并按安全点回滚。它不是文件系统事务。
3. **轮次中切换工作目录**：轮前/轮后快照归属切换前引擎；新目录从下一轮建立
   基线。交接轮次内不建议恢复。
4. **Windows 符号链接/junction**：写入/删除目标或父目录是链接时拒绝；不含
   符号链接的计划仍支持。POSIX 符号链接恢复仍受文件系统权限约束。
5. **子模块内部、LFS 实体、特殊文件**：按 gitlink/指针字节记录，不保证内容级
   恢复；恢复计划会跳过子模块并告警。
6. **旧快照中的排除文件不会删除**：F-02 只保证当前忽略规则命中的路径不被写
   回/删除；它们仍可能作为历史 blob 存在于旧对象中，直到 GC 回收。
7. **控制密钥经回环 GET 下发**：本机进程可以读 `GET /status` 的 `key`；浏览器
   仍受 `Host`/`Origin`/自定义头限制，不能跨站读取或写。本机恶意进程本就有
   文件权限。
8. **工具恢复依赖模型自觉**：`time_machine` 的 `restore` 仍只开放覆盖模式且
   总是先建安全点，但宿主没有人类确认令牌；提示注入可能诱导模型发起回滚。
   需要更强保证时应加策略开关或人类确认。
9. **真实 GUI 未复测**：本次验证覆盖真实 Git/临时工作区/Host fake webServer/
   CLI/离线视觉；没有在真实 DSH Web 或桌面窗口里跑完整端到端矩阵。

## 5. 验证结果

```text
node --test tests/*.test.mjs
  tests 38
  pass  38
  fail  0
  duration_ms ≈ 18.9s

node scripts/build.mjs
  插件 id : dsh-time-machine
  样式    : 23.6 KB
  模块    : 10 个
  产物    : client/client.js (93.9 KB)

node verify/preview.mjs
  16 页 HTML（4 视图 × 中英 × 深浅色）

node verify/capture.mjs
  4 张 1.5x PNG，面板标题显示 v0.3.0

临时 profile 安装/卸载
  --apply 后 dependencies=dsh-time-machine:file:D:/Questions/dsh-time-machine
  bundle 顺序 dsh-base → dsh-time-machine，安装输出 v0.3.0
  --uninstall --apply 后依赖、bundle、node_modules 副本均移除
```

新增/加强的回归覆盖：

- 新增排除规则后旧缓存条目不进入快照；
- 恢复旧快照时跳过当前忽略文件；
- `.gitattributes` 的 ident 不改写快照字节；
- 删除路径的父目录是 junction/符号链接时拒绝且外部文件保留；
- 数据目录等于快照根时拒绝绑定；
- 元数据加载 600 条不被截断；
- journal planId 路径穿越拒绝；
- 会话忙碌时拒绝 journal 回滚；
- 崩溃遗留 plan 引用的 TTL 清理与宽限期保留；
- 工作目录切换后旧引擎释放；
- junction/符号链接工作区共用一个引擎；
- 配置写盘失败不提交内存值、非法 excludes 不清空原规则；
- CLI doctor 对坏记录的容错。

## 6. 版本与兼容

- `package.json` → `0.3.0`；CHANGELOG 增加 `0.3.0` 条目；构建脚本强制版本与
  CHANGELOG 首条一致。
- 元数据 `version` 仍为 `1`，无迁移步骤；影子仓库布局、refs、journal 结构不变。
- 宿主依赖不变：`session/event`、`agent/turn-stopping`、`tools/pre-execute`、
  `ctx.commands`、`ctx.tools`、`ctx.webServer`、
  `conversation.session.header.actions`；新增的 `workingDirectory` 查找是可选
  的，不改变最低 DSH 版本。
- 安装要求不变：DSH `>= 0.2.0-rc.2`、Node `>= 22.6`、Git 2.13+。
- 旧版本创建的还原点可直接列出、预览与恢复；新代码只会在新快照上应用忽略
  规则修正。

## 7. 发布检查清单

- [x] `package.json`、`CHANGELOG.md`、`verify/preview.mjs` 版本一致为 0.3.0
- [x] `client/client.js` 与 `styles.generated.js` 由构建脚本重新生成
- [x] 38 项测试通过（38/38）
- [x] 16 页离线视觉页面与 4 张文档截图重新生成
- [x] README / DESIGN 更新数据目录、忽略规则、设置页与已知边界
- [x] 审计报告与残余风险记录
- [ ] 真实 DSH Web/桌面端到端复测（本次环境未安装插件，留待发布后验证）
- [ ] 提交并推送远端
