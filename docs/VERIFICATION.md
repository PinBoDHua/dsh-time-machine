# 时光机 0.1.0 验证报告

- 日期：2026-10-25
- 平台：Windows 10.0.26300（x64）
- DSH：`0.2.1-rc.3`（桌面安装版运行时 / Web 表层）
- Node：`v24.19.0`
- Git：`2.54.0.windows.1`
- 插件：`dsh-time-machine 0.1.0`

## 结论

0.1.0 通过：

- 19 项自动化测试（真实 Git、临时工作区、Host 接线、客户端 bundle、CLI）；
- 16 页离线视觉验收（真实组件 + 真实 CSS + 深浅色 + 中英文）；
- 真实 DSH Web 宿主上的加载、面板、设置保存，以及一次完整的
  **创建还原点 → 修改文件 → 再建还原点 → 预览 → 恢复** 端到端流程。

Web 验证环境在结束后已卸载插件、恢复 profile 清单并删除测试还原点。
随后用同一个安装脚本把 0.1.0 装入 desktop profile（`--status` 显示已安装、
客户端产物一致）；本次验证没有重启正在运行的桌面应用，因此桌面端的实际加载
发生在用户下一次完全重启 DSH 时。

## 1. 自动化测试

命令：

```bash
node scripts/build.mjs
node --test tests/*.test.mjs
```

结果：**19 / 19 通过**（约 9.6 秒）。

| 文件 | 覆盖 |
|---|---|
| `tests/engine.test.mjs` | 快照、覆盖/精确恢复、CRLF、忽略文件、子目录范围、用户仓库 index/HEAD 不变、预览后变化拒绝、注入失败自动回滚、回滚失败 journal + 新引擎 recover、工具在自身轮次恢复、其他会话忙拒绝、保留策略、路径逃逸、大小写重命名、配置归一化、node_modules 排除 |
| `tests/host.test.mjs` | 真实插件入口、`session/event`、`tools/pre-execute`、`agent/turn-stopping`、`/rewind` 命令、`time_machine` 工具、五个 HTTP 路由、控制密钥、非回环拒绝、配置保存、卸载清理 |
| `tests/client.test.mjs` | 中英文键集一致、时间/统计/标签格式化、设置草稿互转、client bundle 加载与挂载点注册、样式/词典注入、关闭态组件树、共享协议常量 |
| `tests/cli.test.mjs` | CLI snapshot/list、未加 `--yes` 拒绝恢复、加 `--yes` 恢复、status/doctor |

关键断言：

- 用户仓库的 `.git/index`、`HEAD`、分支 ref 在快照与恢复后逐字节不变；
- CRLF 文件恢复后仍是 CRLF；`ignored/` 与 `*.log` 内容不被改动；
- 子目录会话只记录该子树，计划展示工作区相对路径；
- 恢复前安全点与恢复后快照都会被记录；
- 注入第 2 次 `git cat-file blob` 失败时，已写文件按安全点回滚；
- 让回滚读取也失败时，journal 保留，新引擎 `recoverJournal()` 可回到安全点；
- 工具恢复在自身轮次中允许，但有其他会话运行时返回 `SESSION_BUSY`。

## 2. 客户端构建与离线视觉

命令：

```bash
node scripts/build.mjs
node verify/preview.mjs
```

产物：

- `client/client.js`：87.1 KB，10 个模块，经典脚本；
- 样式：23.6 KB；
- 构建期校验：挂载点、API 前缀、控制密钥头、关键类名、词条、导出、版本一致性、模块重名、残留 ESM、越权 require。

离线视觉覆盖：

| 视图 | 中文浅色 | 中文深色 | 英文浅色 |
|---|---|---|---|
| 时间线 | √ | √ | √ |
| 设置 | √ | √ | √ |
| 精确恢复确认 | √ | √ | √ |
| 恢复结果 | √ | √ | √ |

离线合成截图已入库：`docs/images/`。检查点：

- 420px 面板、毛玻璃表面、焦点环、按钮/开关/输入与宿主令牌一致；
- 时间线区分自动/手动/安全点/恢复后，显示轮次、文件数与行数、最新/其他会话标记；
- 精确恢复有独立红色模式、确认勾选、影响统计、文件样例、警告与安全点说明；
- 设置页在 420px 下无横向溢出；
- 深色主题无硬编码浅色残留。

## 3. 真实 DSH Web 验证

### 环境与步骤

1. 在 `profiles/web` 上安装插件（安装脚本自动备份并写入依赖 + bundle）；
2. `dsh web --no-open --port 8099`；
3. 使用一次性 Chrome profile + 启动 URL token 打开页面；
4. 打开一个测试会话（工作区为临时目录）。

### 加载与界面

- 页面样式表中出现 `style[data-plugin="dsh-time-machine"]`；
- 会话标题栏出现「时光机」按钮；
- 点击后出现 420px 面板，状态接口返回当前工作区 `D:\Projects\demo`；
- 空状态文案与「创建第一个还原点」按钮正确；
- 设置页正确读取宿主配置：自动记录、轮前/轮后、保留 120/14 天、30s 超时、默认排除；
- 控制台无异常、无插件报错。

### HTTP 安全

| 请求 | 结果 |
|---|---|
| `GET /plugins/dsh-time-machine/status`（无 sessionId） | `400 BAD_REQUEST` + JSON |
| `GET /plugins/dsh-time-machine/status?sessionId=<非活动会话>` | `404 SESSION_NOT_FOUND` + JSON |
| POST 无控制密钥 | Host 测试中返回 `403` |
| 非回环请求 | Host 测试中返回 `403` |

### 设置保存

在真实面板中把「自动记录」关闭 → 保存 → 再开启 → 保存：

- 两次保存均显示「已保存」；
- `$DSH_HOME/.dsh-time-machine/settings.json` 的 `auto` 依次为 `false` / `true`；
- 写入带 `updatedAt`，配置结构完整。

### 端到端快照与恢复

为避免触碰用户的大工作区，临时把排除规则限定为：

```text
.git/
node_modules/
.dsh-time-machine/
*
!_scratch/
!_scratch/tm-live-ws/
!_scratch/tm-live-ws/**
```

在临时子目录中放 `a.txt = "one\n"`、`sub/b.txt = "nested\n"`，然后：

1. 面板「创建第一个还原点」→ 1 个还原点，显示「初始快照」；
2. 磁盘改为 `a.txt = "two\n"`、`sub/b.txt = "nested changed\n"`；
3. 面板「新建还原点」→ 2 个还原点，第二条显示 `2 个文件 · +2 −2`；
4. 选中最旧的还原点 → 恢复确认 → 默认覆盖模式；
5. 计划显示：写入 2、删除 0、+2 −2；
6. 确认恢复 → 结果页显示安全点与恢复后快照；
7. 磁盘校验：
   - `a.txt` = `"one\n"`
   - `sub/b.txt` = `"nested\n"`
8. 复原设置与测试数据。

现场截图：`verify/shots/live-*.png`。这些截图包含真实会话/账号信息，只保留在本地验证环境，**未提交到仓库**；仓库内的 `docs/images/` 是使用合成数据的离线视觉验收截图。

### 验证后清理

- 在 `profiles/web` 上执行卸载，`package.json` 恢复为只含 `dsh-base` / `dsh-web-app`；
- 停止测试 Web 进程；
- 删除测试工作区、测试还原点数据与安装备份；
- 移除测试 Chrome profile（未触碰用户浏览器）。

## 4. 未覆盖 / 风险

- 未在 macOS / Linux 上运行；路径大小写、符号链接与文件模式在 POSIX 的测试仅由代码路径与单元测试覆盖。
- 未在真实桌面 Electron 窗口中验证；本次使用同一套 Web 客户端与宿主接口。
- 未在超大仓库（>10 万文件）上做性能基准；默认 30s 快照超时会以错误结束该轮记录。
- 未实测「精确恢复」在真实 UI 中的删除流程；该模式由引擎测试与离线确认页覆盖。
- 未验证 DSH 未来版本的 API 漂移；插件只依赖稳定的
  `session/event`、`agent/turn-stopping`、`tools/pre-execute`、`ctx.commands`、`ctx.tools`、
  `ctx.webServer` 与 header actions slot。
- 恢复不改变对话上下文；这是 0.1.0 的明确边界，不是缺陷。

## 5. 复现命令

```bash
node scripts/build.mjs
node --test tests/*.test.mjs
node verify/preview.mjs
node scripts/install.mjs --profile <profile> --apply
# 启动 DSH Web 后按上文步骤操作
node scripts/install.mjs --profile <profile> --uninstall --apply
```
