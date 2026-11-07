# 项目文件结构

以下路径相对于项目根目录 `a/`。当前仓库处于 M4 自动化实现与测试已完成、等待真实模型试用和日常观察的状态：已有 DSH Host 插件和不经过 DSH 的本地开发入口、严格配置、版本化事件、纯 reducer、SQLite 主库与独立墓碑库、快照、删除、备份、网页聊天和 SSE、精确模型网关和调用审计、长期记忆与中文检索、单次 JSON 信封、所有者记忆/控制/审计面板、风格检查、上下文预算、独立视觉模型，以及 schema v9 的单一调度循环、软性生活计划、主动消息、outbox、提醒、一次性关心、每日摘要、回收站到期清除和浏览器通知。真实模型 M4 内容质量、真实浏览器后台通知、M4.5、QQ、浏览器 worker、VM、游戏、自进化和公开发送仍不存在。已确认的双形态是“同一核心 + DSH 插件 + 独立程序”，M4 先只做网页渠道，M4.5 才收口发行基础、模型 provider 设置页和独立正式入口；`src/dev` 仍只是开发工具，不是产品。本文中的“目标结构”是后续实现的约束，不是已经存在的目录。

## 1. 当前结构

```text
kanobot/a/
├── .gitattributes                    LF 换行和文本属性
├── .gitignore                        运行时数据、个人配置和产物忽略规则
├── AGENTS.md                         工程 agent 的操作边界、命令和当前状态
├── README.md                         项目简介、阅读入口和阶段声明
├── structure.md                      本文件：目录和文件放置规则
├── icon.svg                          插件图标资源
├── locale/
│   ├── en.json                       插件英文元数据
│   └── zh.json                       插件中文元数据
├── package.json                      npm 包、DSH bundle 入口和开发命令
├── package-lock.json                 固定依赖版本
├── config/
│   └── examples/                     可提交的占位 system/identity/life-state/memory/initiative/policy TOML
├── scripts/
│   ├── check-import-case.ts          相对 import 路径大小写检查
│   ├── dev-server.ts                 不经过 DSH 的本地开发网页启动器
│   ├── validate-config.ts            配置目录预检 CLI
│   ├── preflight-runtime.ts          配置、主库、墓碑库的启动前预检
│   └── m1-lifecycle.ts               10 次 apply/dispose 生命周期报告
├── src/
│   ├── plugin/
│   │   ├── index.ts                  DSH Host 插件入口
│   │   ├── lifecycle.ts              定时器生命周期
│   │   ├── models.ts                 Host 与开发入口共用的精确模型工厂
│   │   ├── version.ts                插件名和版本
│   │   └── cordis.patch.yml          bundle 默认插入的插件行
│   ├── core/
│   │   ├── config/
│   │   │   ├── index.ts              配置模块公开导出
│   │   │   ├── loader.ts             TOML 读取、跨文件校验
│   │   │   ├── types.ts              schema 版本和运行时类型
│   │   │   ├── validation.ts         字段、范围、路径和时间校验
│   │   │   └── errors.ts             带文件和字段位置的错误
│   │   ├── chat/
│   │   │   ├── index.ts              聊天领域公开导出
│   │   │   ├── types.ts              模型、SSE 事件和会话视图契约
│   │   │   ├── input.ts              文本/单图输入边界和纯图片占位正文
│   │   │   ├── envelope.ts           单次 JSON 信封解析和 reply 增量提取
│   │   │   ├── context.ts            时间/状态/记忆/历史的分块预算和确定性裁剪
│   │   │   ├── service.ts            校验、视觉/聊天模型流、正文/记忆/appraisal/承诺写入
│   │   │   ├── style.ts              确定性回复风格检查和违规代码
│   │   │   ├── mock-model.ts         不联网的明确占位模型
│   │   │   └── magpie-model.ts       Magpie OpenAI-compatible 流式网关
│   │   ├── memory/
│   │   │   ├── index.ts              长期记忆模块公开导出
│   │   │   ├── types.ts              记忆写入、纠正和检索输入契约
│   │   │   ├── service.ts            候选规则、纠正、候选转正、检索和面板视图
│   │   │   ├── candidate.ts          单条记忆候选的引用、敏感和来源门禁
│   │   │   ├── explicit.ts           显式“记住这个”的识别和确定性提取
│   │   │   └── recall.ts             问题意图、主题相关性、排序和重复抑制
│   │   ├── state/
│   │   │   ├── types.ts              事件、快照、记忆和墓碑契约
│   │   │   ├── events.ts             数据契约严格校验
│   │   │   ├── reducer.ts            纯状态转移和数值夹紧
│   │   │   ├── canonical.ts          确定性 JSON 和哈希
│   │   │   ├── clock.ts              唯一真实时钟接口
│   │   │   └── index.ts              状态模块公开导出
│   │   ├── observability/
│   │   │   ├── index.ts              可观测性模块公开导出
│   │   │   ├── owner-audit.ts        所有者操作审计的时间来源和接口
│   │   │   └── audit-timeline.ts     所有者/记忆/模型/风格/聊天的统一时间线
│   │   ├── policy/
│   │   │   ├── index.ts              策略模块公开导出
│   │   │   └── emergency.ts          紧急停止数据库状态和 STOP 文件
│   │   ├── initiative/
│   │   │   ├── index.ts              主动性模块公开导出
│   │   │   ├── types.ts              计划、主动草稿、提醒、关心和视图契约
│   │   │   ├── time.ts               时区、安静时段和本地日边界
│   │   │   ├── policy.ts             主动闸门、节奏和 outbox 状态转换
│   │   │   ├── brain.ts              mock 与模型适配器、严格 JSON 解析和内部调用审计
│   │   │   ├── service.ts            计划、主动消息、提醒、每日整理、维护和 outbox
│   │   │   └── scheduler.ts          唯一后台 tick、重入保护和停用清理
│   │   ├── storage/
│   │   │   ├── database.ts           打开、完整性、迁移和表 schema
│   │   │   ├── store.ts              事务、回放、独立墓碑级联、清除、回收站和恢复
│   │   │   ├── snapshots.ts          快照构造、写入和严格读取
│   │   │   ├── backup.ts             VACUUM INTO、quick_check、保留和恢复
│   │   │   ├── paths.ts              数据目录内的安全路径解析
│   │   │   ├── records.ts            正文/outbox 壳记录校验
│   │   │   ├── memory-search.ts      中文分词、单字列和 FTS5 查询构造
│   │   │   ├── errors.ts             带 code 和 path 的存储错误
│   │   │   ├── types.ts              存储公开类型
│   │   │   └── index.ts              存储模块公开导出
│   │   ├── vision/
│   │   │   ├── index.ts              视觉领域公开导出
│   │   │   ├── types.ts              视觉模型、输入和能力声明契约
│   │   │   ├── input.ts              格式、大小、base64 和魔数校验
│   │   │   └── magpie-vision.ts       Magpie 精确视觉模型转述驱动
│   ├── dev/
│   │   ├── index.ts                  本地开发入口公开导出
│   │   └── server.ts                 回环监听、一次性 token、会话鉴权和网页装配
│   └── web/
│       ├── index.ts                  Web 适配层公开导出
│       ├── chat-http.ts              DSH 鉴权、聊天 API、SSE、记忆 API 和静态资源路由
│       └── assets/
│           ├── index.html            聊天页、状态/主动性/记忆/审计页签、提醒操作和图片选择
│           ├── app.js                SSE、主动性轮询/操作/通知、记忆/审计 API 和 DOM 渲染
│           └── app.css               响应式浅色/深色样式
├── tests/
│   ├── unit/                         配置、上下文组装和纯 reducer
│   ├── integration/                  插件、聊天/SSE、视觉、上下文预算、对话信封、记忆面板、存储、清除、备份、强杀和 fail-closed
│   ├── scenarios/                    人格场景规格和脚本化管线验证
│   ├── replay/                       同一事件流快照逐字节一致性
│   ├── fixtures/                     崩溃写入子进程等测试夹具
│   └── helpers/                      临时目录和固定事件工厂
└── docs/
    ├── need.md                       产品需求、状态模型和验收边界
    ├── plan.md                       总体规划书、模块边界和里程碑
    ├── review-brief.md               交给高级模型的外部审查简报和可复制提示
    ├── memory-research.md             记忆插件源码调研和取舍
    ├── m4.0-memory-acceptance.md      M4 第 0 步记忆质量门控验收
    ├── m4-acceptance.md               M4 主动性、提醒、每日整理和 schema v9 验收
    ├── m1-acceptance.md              M1 八项验收、证据和已知边界
    ├── m2-acceptance.md              M2 五项验收、运行证据和已知边界
    ├── m3-acceptance.md              M3.0 聊天骨架验收、证据和未完成项
    ├── m3.1-acceptance.md            M3.1 Magpie 网关、调用审计和资源熔断验收
    ├── m3.2-acceptance.md            M3.2 长期记忆、纠正和 FTS5 检索验收
    ├── m3.3-acceptance.md            M3.3 记忆召回、抽取和面板验收
    ├── m3.4-acceptance.md            M3.4 风格检查、所有者审计和紧急停止验收
    ├── m3.5-acceptance.md            M3.5 单次对话信封、状态与承诺闭环验收
    ├── m3.6-acceptance.md            M3.6 上下文预算、时间/状态注入和相对时间验收
    ├── m3.7-acceptance.md            M3.7 独立视觉模型、单图输入和失败闭环验收
    ├── m3-completion-acceptance.md   M3 收尾：本地开发入口、统一审计、风格重写和 schema v8
    ├── plugin-research.md            第三方插件源码调研与取舍
    ├── plugin-catalog.zh.md          第三方 DSH 插件汇总表（只读参考）
    ├── mods.md                       第三方插件与改动的记录模板
    ├── astra/                        未跟踪草稿，取舍见 plan.md 第 13 节
    └── gemini/                       未跟踪草稿，取舍见 plan.md 第 13 节
```

文件性质：

- `docs/plan.md` 是**执行计划的唯一来源**，描述已确认决定、架构、里程碑和验收。
- `docs/need.md` 是**产品需求和设计理由**，描述为什么做、关系是什么、哪些事情不能做；与 plan.md 冲突时以 plan.md 为准。
- `docs/astra/` 和 `docs/gemini/` 是两份未跟踪的草稿，不作为执行依据。
- `docs/plugin-research.md` 是**调研证据**，其中的结论只针对记录的 commit 和快照。
- `docs/plugin-catalog.zh.md` 是第三方目录的本地副本，**不是依赖清单、不是安全背书**，不得据此直接安装插件。
- `docs/mods.md` 记录插件引入、替换和迁移；当前明确没有直接安装第三方插件作为生产依赖。
- `docs/m1-acceptance.md` 记录 M1 的八项结果；其中零工具审计、真实 DSH 加载和坏配置预检报告放在仓库外的 `F:\kanobot\dsh`。
- `docs/m2-acceptance.md` 记录 M2 的事件回放、强杀恢复、文件级清除、旧备份恢复和 fail-closed 边界。
- `docs/m3-acceptance.md` 记录 M3.0 的 DSH 鉴权、网页/SSE、mock 模型、schema v2 迁移、重启恢复和尚未实现的 M3 项。
- `docs/m3.1-acceptance.md` 记录 M3.1 的 Magpie 精确模型、流式解析、超时/重试、schema v3 调用审计、资源熔断和真实路由验收边界。
- `docs/m3.2-acceptance.md` 记录 M3.2 的记忆候选规则、纠正、FTS5 双列中文检索、schema v4 迁移和清除边界。
- `docs/m3.3-acceptance.md` 记录 M3.3 的记忆召回注入、结构化抽取、schema v5 `purpose` 审计、面板 API/UI 和真实路由验收边界。
- `docs/m3.4-acceptance.md` 记录 M3.4 的确定性风格检查、7 个场景规格、schema v6 所有者审计/紧急状态、控制页面和真实 4100 验收边界。
- `docs/m3.5-acceptance.md` 记录 M3.5 的单次 JSON 信封、逐字正文、记忆/appraisal/commitments 写入、自动测试和真实 4100 验收边界。
- `docs/m3.6-acceptance.md` 记录 M3.6 的上下文分块预算、时间/星期/沉默时长、定性状态、相对时间 `dueAt`、自动测试和真实 4100 验收边界。
- `docs/m3.7-acceptance.md` 记录 M3.7 的独立视觉模型、图片输入校验、视觉调用审计、失败闭环、不落库保证、自动测试和真实 4100 验收边界。
- `docs/m3-completion-acceptance.md` 记录 M3 收尾的本地开发入口、一次性 token/Cookie 边界、统一审计、风格自动重写、schema v8 和 171 项自动测试结果。
- `docs/memory-research.md` 记录 `dsh-mnemon`、`dsh-engram`、`dsh-memento`、`dsh-meow-memory` 和 `dsh-dream` 的调研快照、许可证边界和可借鉴机制。
- `docs/m4.0-memory-acceptance.md` 记录 M4 第 0 步的问题意图、相关性门槛、显式记忆兜底、配置和 181 项自动测试结果。
- `docs/m4-acceptance.md` 记录 M4 的单一调度、软计划、主动消息、outbox、提醒、每日整理、浏览器通知、schema v9、201 项自动测试和未验证边界。

## 2. 目标结构

后续实现按下面的边界扩展。目录可以按实际工作量调整，但模块职责和配置归属不能混在一起。

```text
kanobot/a/
├── AGENTS.md
├── README.md
├── structure.md
├── .gitignore
├── docs/
│   ├── need.md
│   ├── plan.md
│   ├── plugin-research.md
│   ├── plugin-catalog.zh.md
│   ├── mods.md
│   └── ...
├── config/
│   └── examples/                     可提交的脱敏 TOML 模板
├── src/
│   ├── plugin/                       DSH 入口、生命周期和依赖装配
│   ├── app/                          独立程序正式入口（M4.5；共享 core，不复用 dev）
│   ├── model-providers/              模型适配器：DSH ctx.llm、Magpie、OpenAI-compatible、mock
│   ├── dev/                          仅开发用的回环网页入口，不是产品入口
│   ├── core/                         配置、时钟、事件、reducer、快照、存储和迁移
│   ├── identity/                     身份基线和版本
│   ├── relationship/                 关系、边界、受伤和修复
│   ├── memory/                       记忆写入、检索、巩固和删除
│   ├── initiative/                   主动评估、闸门、outbox 和调度
│   ├── channels/                     网页与 QQ/NapCat 适配器
│   ├── digital-life/                 浏览器、阅读、媒体和游戏
│   ├── evolution/                    候选、测试、影子、审批和回滚
│   ├── policy/                       权限、敏感信息和紧急停止
│   ├── observability/                审计、指标和脱敏
│   └── ui/                           所有者面板和最小展示
├── tests/
│   ├── unit/                         reducer、policy、schema、config
│   ├── integration/                  插件启停、渠道和恢复
│   ├── replay/                       事件回放和迁移
│   ├── scenarios/                    人格场景测试（只用占位人格）
│   └── fixtures/                     脱敏测试数据
└── tmp/                              一次性诊断和草稿（不提交）
```

仓库外的位置：

```text
F:\kanobot\private\                   私有文件（不在任何 Git 仓库里）
├── rinko.md                          燐子的人格设定
└── config\                           正式实际配置
F:\kanobot\dsh\                       本地 DSH 安装、测试脚本和证据（不在 a 仓库）
├── home\                             正式实例的 DSH Home
└── test-home\                        隔离测试 Home，含 kanobot-test Profile 和测试配置
DSH 数据目录                          M2 之后：数据库、快照、日志和备份
```

M2/M3 的实际数据布局：

```text
<dataDir>/
├── kanobot.sqlite                    主库（schema v9）：事件、快照、正文、对话/消息、模型调用审计、记忆、FTS5、风格检查、所有者审计、紧急状态、主动性状态/计划/提醒/关心/摘要/运行记录、outbox、墓碑投影
├── tombstones.sqlite                 独立墓碑库，不进入主库备份
└── backups/
    └── kanobot-backup-*.sqlite       最近 7 份主库一致性备份
```

## 3. 文件放置规则

- 需求、规划、调研和说明放 `docs/`；根目录不再新增散落的 `.md`。
- 可提交的配置模板放 `config/examples/`；人格设定、个人配置、QQ 群号和运行时配置放在仓库外（见上），凭据只放在环境变量或 secret store。
- 业务代码按 `src/<module>/` 放置；模块之间通过明确接口交互，不共享任意全局变量。
- `core` 不导入 DSH 或独立程序专用模块。DSH 插件、独立程序、模型 provider 和渠道都只通过适配器调用 core；新增宿主不能复制人格、记忆或状态逻辑。
- 模型 provider 放在宿主/适配层，不把 Magpie、DeepSeek、Gemini 或某个第三方 URL 写进聊天核心；每次调用的精确 provider、模型、能力和审计由适配器负责。
- M3 的 `src/dev` 只用于本地调试。M4.5 的独立程序必须另建正式入口，补齐鉴权、配置、数据生命周期、安装和发布；不能把开发入口换个名字就当产品。
- 一个小型 FSM 只能放在具体流程模块内，例如 `src/channels/` 的投递状态或 `src/evolution/` 的候选生命周期；不得新增“角色总状态机”。
- 单元测试放 `tests/unit/`，跨模块和 DSH 生命周期测试放 `tests/integration/`，回放与迁移测试放 `tests/replay/`。
- 人格场景规格放 `tests/scenarios/`；当前样例使用脚本化占位回复，不能把通过结果当成真实模型行为。
- 运行时数据库、快照、日志、截图和下载放在 DSH 数据目录，不放进仓库，并设置保留期、权限和清理策略。这样复制源码或生成进化候选副本时，私人数据不会被一起复制。`.gitignore` 里的 `data/` 规则保留，作为兜底。
- 临时诊断放 `tmp/`，不把一次性脚本或输出混入正式数据链。
- 第三方调研记录写 `docs/plugin-research.md`；实际引入/替换插件时更新 `docs/mods.md`，说明版本、原因、许可证和回滚方式。

## 4. 配置拆分规则

一个功能模块对应一个配置文件，规则在 `plan.md` 第 10.1 节；文件随对应里程碑逐步出现。M2 需要 `system`、`identity`、`life-state`、`memory`、`policy` 五个文件；M3.0 继续复用它们；M4 新增 `initiative.toml`。完整网页渠道和 QQ 群配置仍按后续里程碑引入 `channels.toml`：

```text
system.toml
identity.toml
life-state.toml
relationship.toml
memory.toml
initiative.toml
channels.toml
digital-life.toml
evolution.toml
policy.toml
observability.toml
ui.toml
```

`channels.toml` 是群列表、私聊白名单、@ 规则和投递策略的唯一配置来源。配置加载器统一做 schema 校验、默认值、跨文件引用检查和 fail-closed，不把参数散落到各模块。

`system.toml` 的 `[context]` 保存单轮上下文的字符预算和分块上限；`[model]` 保存聊天模型和可选推理档位；`[vision]` 保存独立视觉模型的开关、精确模型名和请求上限。`initiative.toml` 保存 tick、软计划、主动消息、提醒、outbox 和每日整理参数。M3 基线仍只连接本机回环 Magpie `/v1`；M4.5 通过 provider 适配层增加 DSH `ctx.llm` 和受控的第三方 OpenAI-compatible 端点。`memory.toml` 的 `[trash]` 保存回收站期限，`[recall]` 保存相关性和候选上限。`[storage]` 只写相对数据目录的路径；主库、墓碑库和备份目录的实际绝对路径由 `dataDir` 解析并在存储层再次检查目录逃逸。

模型来源、聊天/视觉模型、`separate`/`unified` 视觉模式、人格复核模式、主动渠道、QQ 聚合参数和记忆相关性门槛都属于可配置选项。示例配置只放脱敏默认值；M4.5 的 Web UI 修改 Git 忽略的运行时配置和 secret 引用，不回显密钥，不直接改仓库模板。

## 5. 暂时不拆的东西

- 第一版不拆微服务；先做一个模块化单包。
- 不为了“以后可能要用”创建空模块。
- 不在 `src/` 里直接放第三方仓库副本；需要借鉴时重写并记录来源，许可证不明确时只参考思路。
- 不把 VM、浏览器 worker 或 NapCat 进程的私有实现塞进宿主核心；它们通过适配器或受限 API 接入。
