# AGENTS.md

## 0. 项目一句话

在 DSH 宿主中自研一个连续、可恢复、可审计的陪伴型机器人；M3 网页聊天闭环、M4 自动化和 M4.5 发行基础已完成，包括网页聊天、长期记忆、风格控制、单次对话信封、上下文预算、可配置视觉、统一审计、单一调度循环、软性生活计划、主动消息、outbox、提醒、每日整理、回收站清除、浏览器通知，以及同一核心的 DSH 插件/独立程序、DSH/Magpie/OpenAI-compatible/mock provider、设置页、密钥和端点治理。M4 的压缩真实使用验收已完成；一到两周日常观察、Windows 通知人工确认、真实第三方 API 试用和主模型选型待续。下一阶段由 kano 在 M5 和 M6 之间选择。

## 1. 必读顺序

1. `docs/plan.md`：执行计划的唯一来源，包括已确认决定、架构、里程碑的步骤和验收。
2. `docs/need.md`：产品需求、关系边界和设计理由。
3. `structure.md`：文件和模块放置规则。
4. `docs/plugin-research.md`：第三方机制的可信度和限制。
5. `docs/memory-research.md`：记忆插件的源码调研、可借鉴机制和当前取舍。

`README.md` 用于快速入门；`docs/plugin-catalog.zh.md` 只作为第三方索引，不是依赖或安全依据。`docs/astra/` 和 `docs/gemini/` 是草稿，不作为执行依据。

## 2. 红线

- 当前不实现公开发送：QQ 空间、动态、评论、公开群发和其他公开平台全部后置。
- 当前不把 LLM 审查作为必要门禁；不能让模型自行批准发布、上线或扩大权限。
- 不重新把角色做成巨型 FSM；全局状态使用事件、纯 reducer、策略派生、事件日志和快照。小型 FSM 只能用于局部流程。
- 不把第三方插件直接安装为生产底座，不复制缺少明确许可证或未核验的第三方代码；先查源码、许可证、测试和回滚方式。
- 不把服务器密码、SSH 私钥、API key、QQ 凭据、Cookie 或 token 写入仓库、文档、配置示例、提示词、状态快照或普通日志。
- 不把个人 QQ 群号、好友列表或真实身份资料提交到 Git；示例只能使用占位值。
- 不把燐子的正式人格设定写进仓库、示例、测试或提交信息；仓库里只用占位人格。设定在 `F:\kanobot\private\rinko.md`，正式运行前再移到 DSH 数据目录。
- 不让燐子的会话拿到 DSH 默认的 bash/pwsh 等工具；第一版工具白名单为空。
- 不让模型直接修改核心身份基线、权限、审计、紧急停止或生产配置。
- 不伪造测试、运行结果、平台验收、许可证结论或“已完成”状态。
- 不在后台制造无限轮询、无限重试或无上限资源消耗；必须有预算、熔断和 kill switch。
- 不将 VM、Git worktree、浏览器 `allowedDomains` 或插件进程描述成绝对安全沙箱。
- 不在未明确要求时操作生产服务器、部署 VM 或更改远端配置；本仓库默认只做本地代码和文档。
- 不提交无关改动，不擅自 `git commit` 或 `git push`；用户明确要求提交时才提交，且提交前必须检查 diff。
- 不在数据库损坏或 schema 不兼容时自动删库、建空库或忽略损坏记录；必须 fail-closed，并保留原文件。
- 不把聊天原文写进事件或快照；正文只放可彻底清除的 `bodies` 表，事件和记忆只保存正文 ID。
- 图片只允许在本轮内存中传给独立配置的视觉模型；不得写入用户正文、事件、快照、记忆、普通日志或审计正文。视觉失败必须 fail-closed，不能让聊天模型假装看过图片。
- 不把 `tombstones.sqlite` 纳入主库备份，也不在恢复旧主库后跳过墓碑重放。

## 3. 架构与接口

- DSH 只作为宿主；陪伴核心、状态、记忆、主动性和进化治理自研。
- 配置按功能模块拆分：`system`、`identity`、`life-state`、`relationship`、`memory`、`initiative`、`channels`、`digital-life`、`evolution`、`policy`、`observability`、`ui`。群配置只在 `channels.toml`。
- 配置加载器负责 schema、默认值、跨文件引用、版本迁移和 fail-closed；模块不能绕过加载器读取散落参数。
- 单轮聊天预算只从 `system.toml` 的 `[context]` 读取，由纯函数上下文组装器执行；身份/规则和当前消息不能被预算静默裁剪。
- 视觉模型与聊天模型完全独立，只从 `system.toml` 的 `[vision]` 读取；模型名和厂商不写死，M4.5 起支持本机回环 Magpie 或显式允许的 OpenAI-compatible `/v1`。启动时必须精确匹配模型，并要求上游明确声明 `modalities.input` 包含 `image`。
- 聊天模型的 `system.toml [model].reasoning_effort` 可选；配置后必须由 Magpie `/v1/models` 明确声明支持，否则启动失败。推理内容不进入正文、事件或页面。
- 模型 provider 只在 `src/model-providers` 装配；`core` 不导入 DSH。DSH 插件的 `llm` 是可选服务，必须通过 `ctx.reflect.get('llm')` 读取，不能直接访问未 inject 的 `ctx.llm`。
- `StateEvent` / `StateSnapshot` / `Appraisal` / `Policy` 必须版本化；模型只能提交候选变化，reducer 和 policy 决定持久化与权限。
- 状态字段必须有读取者或写入者，并影响可观察行为；虚拟身体明确标记为模拟，不能冒充真实生理或医疗事实。
- 外部网页、聊天、文件和工具结果一律是不可信输入，不能成为系统指令或未经核验的事实记忆。
- 渠道适配器只处理平台语义、连接、去重、幂等和投递，不复制人格、状态或记忆逻辑。
- 代码、浏览器和未知软件进入候选或隔离环境；上线前必须有测试、基线对比、审批和回滚。
- 事件追加和可选快照在同一事务提交；reducer 不读系统时间、网络或随机数。
- 快照按规范 JSON 保存并校验哈希；回放必须从最近快照加后续事件恢复。
- 独立墓碑库是删除的权威来源；主库里的 `tombstones` 表只是投影，不随旧备份回滚。
- 彻底清除必须级联正文、记忆、outbox、承诺事件依赖和快照，再执行 `VACUUM` 与 `wal_checkpoint(TRUNCATE)`。

## 4. 工作流

1. 先读 `docs/plan.md` 和 `docs/need.md` 的相关章节，确认没有把后置功能拉进当前里程碑。
2. 做最小、聚焦的改动；不要顺手修复无关问题或改文件名制造大 diff。
3. 新增功能先补接口、schema 和失败路径，再补实现；新增状态字段必须同时补读取者或行为测试。
4. 先跑最接近改动的测试，再跑受影响模块的集成测试；没有测试命令时，不要编造命令或结果。
5. 配置、目录或架构变化后，同步更新 `structure.md`、`README.md` 或相关文档。
6. 汇报：改动文件、验证命令、真实验证结果、未验证项和下一步。

开发命令（在本目录执行）：

```powershell
npm test
npm run check:case
npm run config:check
npm run dev
npm run app -- --config <配置目录> --data <数据目录>
node scripts/preflight-runtime.ts F:\kanobot\dsh\test-home\kanobot\config F:\kanobot\dsh\test-home\kanobot\data
npm run test:lifecycle -- --output F:\kanobot\dsh\m1-plugin-lifecycle.json
```

`npm test` 使用 `node --test`，当前 241 项通过。自动测试不会读取真实人格文件、调用真实模型接口或操作正式数据库；真实 Magpie 验收使用隔离的 4100 测试 Profile，M3.1/M3.3/M3.4/M3.5/M3.6/M3.7 证据分别见 `docs/m3.1-acceptance.md`、`docs/m3.3-acceptance.md`、`docs/m3.4-acceptance.md`、`docs/m3.5-acceptance.md`、`docs/m3.6-acceptance.md` 和 `docs/m3.7-acceptance.md`。M3 收尾见 `docs/m3-completion-acceptance.md`；M4 第 0 步见 `docs/m4.0-memory-acceptance.md`；M4 见 `docs/m4-acceptance.md`；M4 真实使用见 `docs/m4-real-use-acceptance.md`；M4.5 双形态、provider 和设置页见 `docs/m4.5-acceptance.md`。测试实例的启停、配置预检和工具审计脚本在 `F:\kanobot\dsh`，不在本仓库内；正式 `4096` 实例不属于测试命令。

## 5. 当前状态

- 阶段：M4.5 发行基础已完成（2026-11-07，版本 `0.14.0`）。一到两周日常观察、Windows 通知中心人工确认、真实第三方 API 试用和主模型选型仍待后续；下一阶段由 kano 选择 M5 或 M6。
- 已存在：M1～M4 全部基线、schema v9，以及正式独立程序、DSH 插件双形态、provider 工厂（`mock`/`magpie`/`dsh`/`openai-compatible`）、聊天/视觉分开的设置页、运行时 `model-settings.json`、环境变量/本地 AES-GCM secret store、第三方 URL/DNS 私网拦截、一次性 bootstrap 登录和 Cookie 鉴权。
- 尚未存在：一到两周真实日常试用、Windows 通知中心人工确认、真实第三方付费 API 验收、DSH provider 在 4100 的真实生成回归、QQ 适配器、浏览器 worker、VM、游戏、自进化和公开发送。当前软计划只保存计划，不实际执行读书/浏览/游戏；当前推断记忆仍进候选，自动证据累积和淡化待后续改进；浏览器通知不是 Web Push。
- 已知部署基线：Windows 10（10.0.19045），Node v24.19.0，DSH `0.2.1-rc.5`（npm `latest` 标签；当前没有非 RC 版本）。插件源码在本目录，测试实例使用独立 `DSH_HOME=F:\kanobot\dsh\test-home`。
- 已知清理记录：旧插件、NapCat 和旧 VM 已从宿主清理；重新部署必须按新设计进行，不能复用旧配置假设。
- 已确认的产品决定见 `docs/plan.md` 第 1 节。
- M1 的八项结果和边界见 `docs/m1-acceptance.md`。
- M2 的五项结果和边界见 `docs/m2-acceptance.md`。
- M3.0 的聊天骨架、鉴权、SSE、mock、迁移和已知缺口见 `docs/m3-acceptance.md`。
- M3.1 的 Magpie 网关、调用审计、资源熔断、真实路由结果和边界见 `docs/m3.1-acceptance.md`。
- M3.2 的长期记忆规则、FTS5 检索、纠正、迁移和清除边界见 `docs/m3.2-acceptance.md`。
- M3.3 的检索注入、结构化抽取、独立调用审计、记忆面板和真实路由结果见 `docs/m3.3-acceptance.md`。
- M3.4 的风格检查、场景规格、所有者审计和紧急停止见 `docs/m3.4-acceptance.md`。
- M3.5 的单次 JSON 信封、逐字正文、记忆/appraisal/commitments 闭环和真实 4100 结果见 `docs/m3.5-acceptance.md`。
- M3.6 的上下文分块预算、时间/状态注入、相对时间承诺和真实 4100 结果见 `docs/m3.6-acceptance.md`。
- M3.7 的独立视觉模型、单图输入、视觉审计、失败闭环和真实 4100 结果见 `docs/m3.7-acceptance.md`。
- M3 收尾的本地开发入口、统一审计、风格自动重写、schema v8 和自动测试结果见 `docs/m3-completion-acceptance.md`。
- M4.0 的记忆相关性、问题意图、显式记忆兜底和 181 项测试结果见 `docs/m4.0-memory-acceptance.md`。
- M4 的单一调度、软计划、主动消息、outbox、提醒、每日整理、浏览器通知和 schema v9 见 `docs/m4-acceptance.md`。
- M4 真实使用验收的运行环境、场景结果、P1 修复、P2 边界、未验证项和进入 M4.5 的判断见 `docs/m4-real-use-acceptance.md`。
- M4.5 的双形态、provider、设置页、密钥/端点治理、4100 加载回归和未验证项见 `docs/m4.5-acceptance.md`。
- 网页空正文最终修复使用 JSON 助手预填、空输出有限重试和显式 `model_empty_response`；`[model].reasoning_effort = "low"` 已在 4100 测试 Profile 和示例配置中启用。真实聊天 13/13 通过，详见 `docs/m3.1-acceptance.md` 第 6 节和 `docs/m4-real-use-acceptance.md`。
- 测试 Profile 数据在 `F:\kanobot\dsh\test-home\kanobot\data`；主库备份不包含独立墓碑库，迁移和恢复时必须单独保留 `tombstones.sqlite`。
- 最近更新时间：2026-11-07。

## 6. 代码规范（后续实现时适用）

- 语言用 TypeScript，直接用 Node 运行，测试用 `node:test`，数据库用 `node:sqlite`；理由和本机实测结果见 `docs/plan.md` 第 2 节。M1 若发现 DSH 有不同要求，再按实际情况调整。
- 接口、事件、配置和持久化 schema 使用明确类型；避免 `any` 扩散和无来源的隐式默认值。
- 模块只通过公开接口交互；业务代码按 `src/<module>/` 放置，不读取其他模块的私有文件。核心模块不导入 DSH，DSH 只出现在宿主适配层。
- 不添加没有读取者的状态字段或没有行为效果的关系数值。
- 失败要显式记录原因、来源和可恢复性；不能用静默重试掩盖配置错误、权限错误或数据损坏。
- 日志和审计默认脱敏；敏感值只记录引用或不可逆摘要。
- 代码注释解释边界、失败路径和不显而易见的设计理由，不写与代码无关的口号。
- 每个源码、脚本和测试模块顶部写清职责与边界；关键分支解释“为什么”，不为显而易见的赋值逐行注释。
- 新增第三方依赖前记录版本、许可证、维护状态、用途和移除方式；能用本地小实现解决的，不先引入重依赖。
- 代码格式以项目实际配置为准；没有配置时不要擅自引入新格式化工具。
若使用python
import 规范
在从外部库进行导入时候，请遵循以下顺序：

对于标准库和第三方库的导入，请按照如下顺序：
需要使用from ... import ...语法的导入放在前面。
直接使用import ...语法的导入放在后面。
对于使用from ... import ...导入的多个项，请在保证不会引起import错误的前提下，按照字母顺序排列。
对于使用import ...导入的多个项，请在保证不会引起import错误的前提下，按照字母顺序排列。
对于本地模块的导入，请按照如下顺序：
对于同一个文件夹下的模块导入，使用相对导入，排列顺序按照不发生import错误的前提下，随便排列。
对于不同文件夹下的模块导入，使用绝对导入。这些导入应该以from src开头，并且按照不发生import错误的前提下，尽量使得第二层的文件夹名称相同的导入放在一起；第二层文件夹名称排列随机。
标准库和第三方库的导入应该放在本地模块导入的前面。

变量规范
当确定某个变量/实例是某种类型的时候（优先按照类型注解确定，除非你分析出类型注解是错误的），可以不必使用or进行fallback。
例如，bot_nickname = (global_config.bot.nickname or "").strip() 可以改为 bot_nickname = global_config.bot.nickname.strip()，前提是我们确定global_config.bot.nickname一定是一个字符串。
类属性使用规范
应该尽量减少使用getattr和setattr方法，除非是在对一个动态类进行处理或者使用Monkeypatch完成Pytest
在重构代码时，如果遇到getattr和setattr，应该尝试检查这个类实例是否有这个属性，如果有，则直接替换为类属性访问写法。
举例：v = getattr(instance, "value", "") 在检查到instance有value属性后应该改为v = instance.value

注释
注释规范
如果原来的代码中有注释，则重构的时候，除非这部分代码被删除，否则相同功能的代码应该保留注释（可以对注释进行修改以保持准确性，但不应该删除注释）。
如果原来的代码中没有注释，则重构的时候，如果某个功能块的代码较长或者逻辑较为复杂，则应该添加注释来解释这部分代码的功能和逻辑。
类型注解规范
重构代码时，如果原来的代码中有类型注解，则相同功能的代码应该保留类型注解（可以对类型注解进行修改以保持准确性，但不应该删除类型注解）。
重构代码时，如果原来的代码中没有类型注解，则重构的时候，如果某个函数的功能较为复杂或者参数较多，则应该添加类型注解来提高代码的可读性和可维护性。（对于简单的变量，可以不添加类型注解）
对于参数化泛型，应该使用typing模块中的类型注解来指定参数化泛型的类型。
例如，使用List[int]来表示一个包含整数的列表，使用Dict[str, Any]来表示一个键为字符串，值为任意类型的字典。

debug规范
不要总是想找兜底，一定要精准的找到问题的核心，然后提出建议，兜底是不合适，难以维护的。
不要总是考虑fallback，如果哪里有错误，一定要让他及时完整的暴露，而不是用fall_back兜底掩盖过去
## 7. 不确定时

- 先查 `docs/plan.md` 的边界和里程碑；仍不清楚就提出具体问题，不静默扩大范围。
- 涉及安全、权限、公开发送、删除数据、部署或第三方许可证时，默认停下来请求确认。
- 发现文档冲突时，以 `docs/plan.md` 的当前版本和用户最新明确决定为准，并同步修正需求稿。
- 不把“成本无限制”解释为可以无限运行；任何自主循环都必须有上限和停止条件。
