# M1 验收记录

> 日期：2026-11-05
> 结论：M1 第 1～8 项已在本地 Windows 测试环境完成。
> 边界：这是测试 Profile 的插件与工具隔离验收，不是生产部署，也不是操作系统级安全沙箱。

## 1. 环境与位置

| 项目 | 值 |
| --- | --- |
| 系统 | Windows 10 专业工作站版 22H2（10.0.19045） |
| Node | v24.19.0 |
| npm | 11.17.0 |
| DSH | `0.2.1-rc.5` |
| DSH 安装 | `F:\kanobot\dsh`，来源为 npm 官方包 `@deepseek-ai/dsh` |
| 插件源码 | `F:\kanobot\a` |
| 测试 Home | `F:\kanobot\dsh\test-home`，与正式实例隔离 |
| 测试 Profile | `kanobot-test`，监听 `127.0.0.1:4100` |
| 正式实例 | `127.0.0.1:4096`；本次验收未修改、未重启 |

2026-11-05 查询 npm 时，`@deepseek-ai/dsh` 的 `latest` 标签是 `0.2.1-rc.5`。该包没有非 RC 的正式版本；因此本次固定的是官方 `latest`，不把它记成语义化“稳定版”。包的许可证是 MIT，版本和 tarball 完整性由 `F:\kanobot\dsh\package-lock.json` 锁定。

测试 Profile 的 `package.json` 通过 `link:F:/kanobot/a` 链接本仓库，因此测试实例加载的是 `a/src/plugin/index.ts`，不是复制到 DSH 目录的另一份源码。测试 Profile 的依赖、Home 级凭据和测试配置都在 `F:\kanobot\dsh\test-home`，不属于本仓库。

## 2. 八项结果

| # | 要求 | 结果与证据 |
| --- | --- | --- |
| 1 | 安装 DSH 并记录版本、来源、方式和日期 | 已完成：`0.2.1-rc.5`，npm 官方包，依赖和锁文件在 `F:\kanobot\dsh` |
| 2 | 建立只含虚构数据的测试 Profile | 已完成：独立 `DSH_HOME`、`kanobot-test` Profile、占位人格、无真实凭据 |
| 3 | 阅读官方插件文档和源码，记录五类能力 | 已完成：结论和源码位置见第 3 节 |
| 4 | 最小插件、10 次加载/卸载、检查活动资源 | 已完成：真实插件代码执行 10 次 apply/dispose，前后资源列表一致 |
| 5 | 建立脚手架并让 `npm test` 运行 `node --test` | 已完成：`package.json`、`src/`、`tests/`、`config/examples/` |
| 6 | 实现 `system`、`identity`、`policy` 配置加载器 | 已完成：严格类型、范围、未知字段、跨文件规则和错误定位 |
| 7 | 大小写检查脚本和 `.gitattributes` | 已完成：13 个源文件、18 个相对导入检查通过；统一 LF |
| 8 | 把实际开发、测试命令写进 `AGENTS.md` | 已完成 |

## 3. DSH 能力验证

证据来自本机安装的 `0.2.1-rc.5` 源码和文档。更完整的调研原文在 `F:\kanobot\dsh\m1-dsh-findings.md`。

### 3.1 插件入口、加载与卸载

- Host 插件使用 `apply(ctx, config)` 或默认导出的 service class，可以声明 `inject` 和 `Config`。
- 活动资源通过 `ctx.effect`、`ctx.on` 等注册，并在插件卸载时释放。
- 本地最小插件已经实际走通 `apply`、定时器和 `dispose`。

源码位置：

- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\references\host-plugin.md:59-64`

### 3.2 页面与 HTTP 接口

- UI 插件在客户端 slot 注册 React 组件，`sidebar.panellist` 可以增加面板入口。
- Host 插件可以注册具名 HTTP route 和 upgrade route，disposer 可以移除注册。
- 后续网页端可以挂在 DSH 内；M1 只确认能力，尚未实现 Kanobot 页面。

源码位置：

- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\references\practices.md:33-38`
- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh-client-ui-sidebar\README.zh.md:38`
- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh-host-webserver\README.zh.md:59-67`

### 3.3 独立人格和工具白名单

- agent preset 可以挂载独立人格；`dsh-persona` 的 `prefix` 和 `complete: true` 可以让占位人格成为完整系统提示词。
- `ctx.tools.restrict(filter)` 可以限制某个 agent 继承的工具；`ctx.tools.schemas(scope)` 能读取实际模型可见 schema。
- preset 不是安全沙箱；YAML 和插件仍然能在 Host 上执行代码。
- 另一条退路是插件直接调用 `ctx.llm.stream(...)`，不经过 DSH 的 agent loop。

源码位置：

- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh-persona\README.zh.md:12`、`:28`、`:40-43`、`:49`
- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh-agent\README.zh.md:63`、`:157`
- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh-tools\README.zh.md:83-85`
- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh-tools\lib\types\index.d.ts:639-645`、`:666-671`、`:706-712`
- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh-llm\README.zh.md:50-54`、`:84`

`restrict` 只过滤继承来的工具，不删除 agent 作用域自己注册的工具。因此以后新增 Kanobot 自己的工具时，仍要逐个设置 allowlist、policy 和审计，不能只依赖 preset。

### 3.4 数据目录与配置

- 主目录优先级是显式配置、`$DSH_HOME`、`~/.dsh`。
- 插件通过自己的 `Config` 接收参数；配置树由 bundle patch、Profile patch、Home patch 和 `--patch` overlay 叠加。
- Kanobot 以 `DSH_HOME/kanobot/config` 为默认配置目录；测试实例的实验目录是 `F:\kanobot\dsh\test-home\kanobot\config`。

源码位置：

- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh-home-paths\README.zh.md:34`、`:39`
- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh\README.zh.md:11`、`:35-46`
- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh-settings\README.zh.md:12`、`:33`

### 3.5 DeepSeek 与 Gemini 官方接口

- DeepSeek 有官方适配器，路由名 `deepseek-official`，默认官方根地址为 `https://api.deepseek.com/anthropic`。
- Gemini 可通过官方 `@deepseek-ai/dsh-llm-pi-ai` 的 `google` 路由接入，端点默认是 Google Generative Language API；运行时探测成功列出了 `gemini-3.8-flash`。
- 探测使用临时假 key，只验证路由和模型目录，没有发送真实生成请求。真实账号、计费、限流和输出质量仍未验收。

源码和探测位置：

- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh-llm-deepseek\README.zh.md:53`、`:57`、`:83-89`
- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh-llm-pi-ai\README.zh.md:28`、`:38`、`:77-81`
- `F:\kanobot\dsh\node_modules\@deepseek-ai\dsh-llm-pi-ai\lib\index.js:2667-2669`
- `F:\kanobot\dsh\m1-gemini-probe.json`

## 4. 生命周期验收

命令：

```powershell
npm run test:lifecycle -- --output F:\kanobot\dsh\m1-plugin-lifecycle.json
```

结果：

- `ok = true`
- `cycles = 10`
- 加载前活动资源列表：`[]`
- 第一轮加载期间：包含 `Timeout`
- 10 轮卸载后：`[]`
- 每次加载和卸载都输出了插件名与版本

报告：`F:\kanobot\dsh\m1-plugin-lifecycle.json`。

10 轮测试调用的是插件的真实 `apply`/`dispose` 代码，但宿主上下文是最小 fake context；它不是 DSH 热重载。真实 DSH 进程中的一次成功加载另有启动报告 `F:\kanobot\dsh\m1-plugin-load.json`，其中包含插件名、版本、PID、配置目录、模型路由和身份模式。

## 5. 工具隔离验收

测试 Profile 使用 `tools.mode: native`，禁用继承的工作目录工具和所有内置 coding preset，只保留虚构占位人格的 `kanobot-test` preset。临时审计插件读取 `ctx.tools.schemas(scopeOf(agent.ctx))`，结果：

| 会话 | 模型可见工具数 | 工具 |
| --- | --- | --- |
| 显式 `kanobot-test` | 0 | `[]` |
| 默认 preset | 0 | `[]` |
| 对照 `m1-control` | 1 | `["pwsh"]` |

报告：`F:\kanobot\dsh\m1-runtime-audit.json`。

对照 preset 能看到 `pwsh`，说明审计器确实读到了工具 schema；不是只把列表写死成空。证明范围是模型可见工具为空，不是进程不能执行代码。

## 6. 错误配置验收

把测试配置的 `model.timeout_ms` 临时改成 `999` 后执行测试启动脚本，结果：

```text
Configuration validation failed:
- ...\system.toml [model.timeout_ms]: expected 1000..600000, got 999
Kanobot configuration preflight failed; DSH test profile was not started.
```

同时确认 `127.0.0.1:4100` 没有监听，且没有生成新的 `dsh-test.pid`。随后从备份恢复配置，并对恢复后的目录重新跑预检，得到 `config ok`。

原始输出：`F:\kanobot\dsh\m1-config-preflight.out.log`。

重要边界：DSH 将 bundle 中的 Kanobot 视为 optional 插件。若绕过启动脚本直接启动 DSH，插件激活失败时宿主会打印 `entry did not activate`，但宿主进程继续运行。因此 fail-closed 由 `F:\kanobot\dsh\start-dsh-test.ps1` 的启动前预检提供，而不是由 DSH 自动把整个宿主退出。该启动脚本在创建 DSH 进程之前调用：

```text
F:\kanobot\a\scripts\validate-config.ts
```

## 7. 配置、脚手架与静态检查

- `npm test`：18 项通过。
- `npm run check:case`：13 个文件、18 个相对导入通过。
- `npm run config:check`：`development, deepseek-official/deepseek-flash, identity=placeholder, tools=0`。
- `package-lock.json` 固定 `smol-toml@1.9.1`；版本、许可证和回滚记录在 `docs/mods.md`。
- `.gitattributes` 为 `* text=auto eol=lf`。

复现命令：

```powershell
cd F:\kanobot\a
npm test
npm run check:case
npm run config:check
npm run test:lifecycle -- --output F:\kanobot\dsh\m1-plugin-lifecycle.json
```

## 8. 未完成和后续边界

- 没有用真实 DeepSeek 或 Gemini key 发送生成请求。
- 没有实现 Kanobot 页面、HTTP API、聊天、状态、数据库和记忆。
- 测试 Profile 和工具审计脚本位于 `F:\kanobot\dsh`，不在 `a` 仓库；仓库只提交插件源码、示例配置和测试。
- 插件在 DSH 中是 optional 条目；生产部署前必须把启动预检纳入正式启动脚本，不能依赖“DSH 会因插件错误退出”。
- preset 和零工具只限制模型可见能力，不构成对恶意插件代码的操作系统级隔离。
- 下一步是 M2：事件、状态、快照、SQLite、删除和备份。
