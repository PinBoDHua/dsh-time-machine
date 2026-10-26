# 时光机 0.2.0 前后端审计报告

- 日期：2026-10-26
- 平台：Windows 10.0.26300（x64）
- Node：`v24.19.0`
- Git：`2.54.0.windows.1`
- 版本：`dsh-time-machine 0.1.0` → `0.2.0`
- 范围：`lib/`（宿主）、`shared/protocol.js`、`src/client/`（浏览器）、`client/client.js` 产物、
  `scripts/`、`tests/`、`docs/`
- 结论：**未发现可越界写入、越界删除或绕过控制密钥的高危漏洞**；发现并修复 16 项
  正确性、一致性与可用性问题，其中 2 项 P1（数据目录自我快照、自动 GC 失效）、
  6 项 P2。数据格式（store version 1）与宿主 API 依赖不变，已有还原点无需迁移。

## 1. 范围与方法

| 层 | 文件 | 审查重点 |
|---|---|---|
| 宿主引擎 | `lib/engine.js`、`lib/restore.js`、`lib/git.js`、`lib/store.js` | 快照范围、恢复状态机、路径与符号链接、回滚/日志、保留与回收、失败路径 |
| 宿主接线 | `lib/index.js`、`lib/surfaces.js`、`lib/server.js`、`lib/config.js` | 会话事件、命令/工具、HTTP 鉴权与回环限制、配置收敛 |
| CLI | `lib/bin.js`、`scripts/install.mjs` | 参数校验、确认门槛、安装/回滚 |
| 浏览器 | `src/client/*`、`client/client.js` | 状态轮询、竞态、错误映射、可访问性、构建契约 |
| 共享/测试 | `shared/protocol.js`、`tests/*` | 常量一致性、真实 Git 回归覆盖 |

方法：

1. 逐文件静态审查，重点走「输入 → 路径 → Git 命令 → 文件写入」和「失败 → 回滚 → journal」两条数据流；
2. 对可疑点写临时复现脚本（真实 Git、真实工作区），确认问题可复现后再修复；
3. 修复后补回归测试，跑完整测试、构建、离线视觉验收；
4. 复核版本号、CHANGELOG、文档与构建产物的一致性。

## 2. 架构与安全结论

- **影子仓库隔离成立**：`GIT_DIR`/`GIT_WORK_TREE`/临时 index 全为插件私有；用户仓库的
  index、objects、HEAD、refs 不被写。`tests/engine.test.mjs` 有逐字节对比。
- **路径校验是双层的**：计划阶段 `buildRestorePlan` 做 scope、逃逸、`.git`、目录冲突、
  大小写冲突、祖先符号链接与大小预检；执行阶段 `applyEntries` 逐条重做路径与祖先检查。
  `insidePath()` 拒绝绝对路径、`..`、空段、NUL 与 `.git` 段，未发现绕过。
- **恢复失败可收敛**：安全点 → journal → 写入/删除 → 逐 blob 复核 → 失败按安全点回滚 →
  回滚失败保留 journal，`recover` 幂等。本次只修了缓存与状态一致性，没有改变状态机。
- **HTTP 写接口有进程内控制密钥**，且所有路由只接受回环请求；`Host`/`Origin`/
  转发头检查在路由入口统一执行。时序比较使用 `timingSafeEqual`，请求体有 1 MiB 上限。
- **Git 调用不经过 shell**，参数全部由插件构造；环境变量做了白名单式清洗。
- **未发现**：任意路径写入/删除、`..` 逃逸、`.git` 改写、未授权写接口调用、
  journal 路径穿越（planId 只来自内部生成或已扫描到的日志）。

## 3. 发现与处置

严重度：P1 = 会造成持续数据/磁盘问题；P2 = 会造成错误状态或用户可见错误；P3 = 健壮性/一致性问题。

| ID | 级别 | 位置 | 问题 | 处置 | 回归 |
|---|---|---|---|---|---|
| F-01 | P1 | `lib/git.js` `writeExcludes` | `DSH_TIME_MACHINE_DATA_DIR` 指到工作区内时，影子仓库会快照自己（含临时 index 锁）；`binding.json` 每次刷新 `seenAt`，导致每轮都产生伪变化、磁盘持续膨胀 | 数据目录位于 `workTree` 内时按真实相对路径强制排除 | `数据目录位于工作区内时会自动排除` |
| F-02 | P1 | `lib/engine.js` `maybeGc` | 稳态下每次只淘汰 1 个旧引用，`removedCount < 10` 永远成立，自动 GC 实际从不运行，旧对象只增不减 | 改为累计淘汰数触发 + 每小时一次 + 经串行链排队，避免与 snapshot 并发 | `自动 gc 按累计淘汰数触发` |
| F-03 | P2 | `lib/engine.js` `appendCheckpoint`、`lib/store.js` | 标签未清洗：HTTP/工具/命令可写入 1 MiB 级、含换行的标签；`sanitizeLabel` 是死代码 | 统一截断到 80 字符、清除控制字符，存储层再兜底一次 | `还原点标签会截断…`、Host 长标签 |
| F-04 | P2 | `lib/store.js` `append` | 元数据写盘失败时内存时间线已变更，`latest()` 指向随后被删除引用的点 | 写盘失败回滚内存状态，事务化 `append` | `元数据写盘失败时 append 回滚内存状态` |
| F-05 | P2 | `lib/engine.js` `init` | 一次瞬时读取失败会把 rejected promise 永久缓存在 `ready`，引擎直到重启都不可用 | 失败时清空 `ready`，下一次事件/请求重试 | `init 失败后下一次调用会重新加载` |
| F-06 | P2 | `lib/engine.js` journal 生命周期 | `journalCache` 2 秒缓存未在写入/删除时失效；回滚失败后面板可能显示“没有未完成的恢复日志” | journal 写入、删除、回滚失败时全部失效缓存 | `回滚失败会保留恢复日志…` 增加预热断言 |
| F-07 | P2 | `src/client/panel.js` `refresh` | quiet 刷新被 `view !== 'timeline'` 挡住；恢复成功/返回时间线时 `viewRef` 仍是旧值，刷新被吞掉，界面最多陈旧 5 秒 | 移除视图门禁；轮询在确认/结果/设置页也保持状态新鲜 | 客户端 bundle 契约测试 |
| F-08 | P2 | `src/client/panel.js` 会话切换 | 切换会话时未使在途 `status`/`plan` 请求失效，旧会话响应可能写回新面板 | 会话切换时递增两个序号并复位 loading/planning | 客户端 bundle 契约测试 |
| F-09 | P3 | `lib/git.js` `writeExcludes` | 强制排除项原本排在用户规则之前，`!` 否定规则在语义上可重新包含 `.git/` 或数据目录 | 强制项统一排到最后（后匹配者胜），并去重 | `排除规则始终保护 .git 与插件数据目录` |
| F-10 | P3 | `lib/git.js` `scrubEnv` | 未清洗 `GIT_COMMON_DIR`、`GIT_NAMESPACE`、`GIT_PREFIX`、`GIT_QUARANTINE_PATH` | 加入清洗列表，避免外部 Git 上下文污染影子仓库 | 由既有快照/恢复测试覆盖 |
| F-11 | P3 | `lib/restore.js` | `targetEntry.type !== 'blob'` 先命中通用分支，子模块永远得到“无法恢复的条目”而非“跳过子模块” | 先区分 gitlink/commit 再给通用告警 | 手工构造子模块计划可复现 |
| F-12 | P3 | `lib/git.js` `treeEntries` | 正则无 `s` 标志，含换行的 Git 路径被静默跳过 | 加 `s` 标志 | 由引擎路径测试覆盖 |
| F-13 | P3 | `lib/bin.js` | `--limit abc` 得到 `NaN`，列表静默为空；`recover` 遇到一个不可用工作区会整体中止 | 限幅到 1–500；`recover` 跳过并告警 | CLI 非法 `--limit` 断言 |
| F-14 | P3 | `lib/util.js`、`lib/git.js` | 原子写/排除文件在 rename 失败时可能残留临时文件 | 失败路径统一清理 temp | 代码审查 |
| F-15 | P3 | `README.md` | `maxCheckpoints` 写“最少 5”，实现与 UI 都是 10 | 文档改为 10 | 文档审查 |
| F-16 | P3 | `src/client/format.js`、`locales.js` | 英文界面下 `NOTHING_TO_RESTORE`、`PLAN_EXPIRED` 等常见错误回退为服务器中文 | 补齐 4 个错误码的中英文案并映射 | 格式化测试断言 |

### 3.1 数据目录自我快照（F-01）

复现（修复前）：把数据目录放到工作区 `.custom-data/`，首次快照 tree 就包含
`.custom-data/repos/<key>/binding.json`、`empty.gitconfig`、`tmp/index-*.lock`；
第二次快照统计到 5 个文件变化。修复后同一场景 tree 只有 `a.txt`，第二次自动快照
正确判定为无变化。该问题不会越界写文件，但会持续制造伪还原点并让影子仓库膨胀。

### 3.2 自动 GC 失效（F-02）

`appendCheckpoint()` 在达到 `maxCheckpoints` 后每次只删 1 条旧引用，而
`maybeGc(removed.length)` 要求 `removedCount >= 10`。两者组合使稳态下 GC 条件永远不成立，
只有批量淘汰（改小上限、按天清理）才会触发。现在累计 `pendingDeletes`，达到 10 且距上次
GC 超过 1 小时才排队；GC 通过 `enqueue` 串行执行，避免与快照/恢复并发。

### 3.3 标签边界（F-03）

标签来自三处不受信输入：`time_machine` 工具参数、HTTP `POST /checkpoint` body、
`/rewind snapshot` 文本。修复前 129 字符含换行的标签会原样进入 metadata 与 CLI 输出；
现在统一走 `sanitizeLabel()`（控制字符替换、trim、80 字符截断），引擎返回值与落盘值一致。

### 3.4 前端刷新门禁（F-07 / F-08）

`refresh({quiet:true})` 原来在 `view !== 'timeline'` 时直接返回。恢复成功路径在
`setView('result')` 后立刻调用刷新，而 `viewRef` 仍为 `confirm`，于是不刷新；点“回到时间线”
时同理，只能等下一次 5 秒轮询。移除门禁后，确认页也能及时看到 `busy`/journal 变化。
会话切换时同时在 reset effect 中递增 `refreshSeq`/`planSeq`，旧会话响应不会再落到新面板。

## 4. 未修复 / 残余风险

这些是本次审计确认存在、但按 0.2.0 范围不修改或属于设计取舍的项：

1. **目录 ↔ 文件互换仍拒绝恢复**：计划以 `PATH_CONFLICT` 拒绝，不做递归删除或隐式覆盖。
   这是保守选择，避免半删除状态；已写入 README「目录与文件互换」。
2. **恢复与新轮次并发**：引擎只串行快照/恢复操作，不锁工作区写入。恢复开始后若新轮次
   启动并写文件，恢复后复核会失败并按安全点回滚，但理论上可能覆盖该轮次的部分写入。
   UI 在 `busy` 时锁定恢复；工具恢复只允许在自己的轮次内。
3. **多进程共享同一工作区**：CLI 与宿主各持一个引擎，没有跨进程文件锁；元数据是
   last-writer-wins。CLI 文档定位为宿主不可用/排障入口，不建议与宿主同时恢复。
4. **Windows 符号链接**：含符号链接写入/删除的计划直接拒绝；POSIX 支持。
5. **LFS / 子模块内部 / 特殊文件**：按 gitlink 或指针字节记录，不保证内容级恢复。
6. **面板可访问性**：`role="dialog"` 但没有焦点陷阱与打开时聚焦；`aria-modal="false"`。
   键盘用户仍可通过 Tab 到达面板，但焦点顺序不是模态语义。
7. **控制密钥经回环 GET 下发**：本机进程可以读取 `GET /status` 的 `key`。浏览器侧受
   `Host`/`Origin`/自定义头限制，不能跨站读取或写；本机恶意进程本就有文件权限。
8. **工具恢复依赖模型自觉**：`time_machine` 工具的 `restore` 只开放覆盖模式且总是先建安全点，
   但宿主没有额外的人类确认令牌；提示注入可能诱导模型发起回滚。需要更强保证时建议增加
   用户确认或策略开关。
9. **本次未复测真实 DSH Web 宿主**：本报告验证的是构建、真实 Git 集成、Host 接线（fake
   webServer）、CLI 与离线视觉；真实桌面/Web 端到端证据仍是 `docs/VERIFICATION.md` 的 0.1.0
   记录。依赖的宿主 API 未在 0.2.0 中变化。

## 5. 验证结果

```text
node scripts/build.mjs
  插件 id : dsh-time-machine
  样式    : 23.6 KB
  模块    : 10 个
  产物    : client/client.js (88.2 KB)

node --test tests/*.test.mjs
  tests 25
  pass  25
  fail  0
  duration_ms ≈ 16.8s

node verify/preview.mjs   # 16 页 HTML（4 视图 × 中英 × 深浅色）
node verify/capture.mjs   # 4 张 1.5x PNG，面板标题显示 v0.2.0
```

新增/加强的回归覆盖：

- 工作区内数据目录不被快照；
- 强制排除优先级与 `!` 否定规则；
- 标签截断与控制字符清洗（引擎 + HTTP 两条入口）；
- 元数据写盘失败的事务回滚；
- `init()` 瞬时失败后的重试；
- 回滚失败后 journal 不被 2 秒缓存遮蔽；
- 自动 GC 在稳态淘汰后确实运行；
- 全部四个写接口在缺少控制密钥时 403；
- CLI 非法 `--limit` 不产生空列表。

## 6. 版本与兼容

- `package.json` → `0.2.0`；CHANGELOG 增加 `0.2.0` 条目；构建脚本强制版本与
  CHANGELOG 首条一致。
- 元数据 `version` 仍为 `1`，无迁移步骤；影子仓库布局、refs、journal 结构不变。
- 宿主依赖不变：`session/event`、`agent/turn-stopping`、`tools/pre-execute`、
  `ctx.commands`、`ctx.tools`、`ctx.webServer`、`conversation.session.header.actions`。
- 安装要求不变：DSH `>= 0.2.0-rc.2`、Node `>= 22.6`、Git 2.13+。
