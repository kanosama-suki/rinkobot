# 项目文件结构

以下路径相对于项目根目录 `a/`。当前仓库处于 R1 独立核心服务硬化完成代码与 Windows 自动验收、M5.2.1 作为代码基线的状态：已有 DSH Host 插件、正式独立程序、开发入口、严格配置、版本化事件、纯 reducer、SQLite 主库与独立墓碑库、快照、删除、备份、网页聊天和 SSE、固定高度聊天/审计滚动区、长期记忆与中文检索、提醒/记忆确定性仲裁、候选冷却、单次 JSON 信封、所有者面板、风格检查、上下文预算、独立视觉模型、schema v12 的主动性与提醒闭环，以及聊天/视觉分开的 provider 设置弹窗、只读模型发现、可点选模型卡片、运行时覆盖、环境变量/本地加密 secret store 和第三方端点治理。M5 增加了外部 NapCat/OneBot 11 QQ 渠道、白名单、群 @、连发聚合、多图、去重、限频、重连、发送结果未知不重发和脱敏渠道审计。M5.1 把设置移入原生弹窗，增加 QQ 渠道配置与一次性连接测试，通过 `channel-settings.json` 覆盖 `channels.toml` 的 `qq` 段，并让明确委托的提醒直接生效、模糊委托在聊天里确认。M5.2 增加显式 `owner_qq`：只有所有者 QQ 私聊与网页 `main` 共享上下文和长期记忆，其他私聊、群聊独立存储；网页新增“我们的对话 / 全部对话”，档案按 `messages.seq` 以 50 条游标分页、按日期分组并显示来源徽标。M5.2.1 增加启动时所有者私聊历史幂等回填、缺失所有者警告、消息区顶部历史按钮和非 `main` 会话改名；`conversations.display_name` 使 schema 升到 v12。R1 增加数据目录 OS IPC 单进程锁和 `kanobot.lock` 元数据、stale lock 恢复、未登录最小 health、结构化启动报告、固定关闭顺序、备份 `list/create/restore`、强杀 outbox 终态、DSH 缺席 mock 网页/QQ/提醒/scheduler 验收，以及 Linux systemd 示例和部署手册。真实小号 QQ + NapCat + Magpie 仅完成私聊收发、图片/表情和 owner 合并的部分验收；完整 QQ 矩阵、日常观察、Linux systemd 实机、浏览器 worker、VM、游戏、自进化和公开发送仍未验收。默认形态是“独立核心 + 可选执行器”；DSH 插件保留为可选连接器，独立程序是默认入口，两者共用数据库契约；`src/dev` 仍只是开发工具，不是产品。

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
├── deploy/
│   └── kanobot.service.example       Linux 非 root systemd 示例（未实机验收）
├── config/
│   └── examples/                     可提交的占位 system/identity/life-state/memory/initiative/policy TOML
├── scripts/
│   ├── backup.ts                     主库备份 list/create/restore CLI
│   ├── check-import-case.ts          相对 import 路径大小写检查
│   ├── dev-server.ts                 不经过 DSH 的本地开发网页启动器
│   ├── app-server.ts                 正式独立程序启动器和参数解析
│   ├── login-url.ts                 向运行中实例申请一次性登录链接
│   ├── validate-config.ts            配置目录预检 CLI
│   ├── preflight-runtime.ts          配置、主库、墓碑库的启动前预检
│   └── m1-lifecycle.ts               10 次 apply/dispose 生命周期报告
├── src/
│   ├── plugin/
│   │   ├── index.ts                  DSH Host 插件入口
│   │   ├── lifecycle.ts              定时器生命周期
│   │   ├── models.ts                 旧调用点兼容的 provider 薄导出
│   │   ├── version.ts                插件名和版本
│   │   └── cordis.patch.yml          bundle 默认插入的插件行
│   ├── app/
│   │   ├── index.ts                  正式独立程序公开入口
│   │   ├── backup-command.ts          备份 CLI 共享实现和 restore 互斥
│   │   ├── health.ts                 最小健康响应和 200/503 判定
│   │   ├── runtime-lock.ts            OS IPC 单进程锁、元数据和本地控制通道
│   │   └── server.ts                 显式目录、锁、一次性登录、Cookie 和网页装配
│   ├── model-providers/
│   │   ├── index.ts                  provider 工厂、精确能力和凭据解析
│   │   ├── dsh-chat.ts               DSH ctx.llm 窄适配器、有限重试和错误映射
│   │   ├── dsh-types.ts              DSH 可选服务的本地窄接口
│   │   ├── secret-store.ts           AES-256-GCM 本地密钥存储
│   │   └── url-security.ts           第三方 URL/DNS/私网前置检查
│   ├── settings/
│   │   ├── index.ts                  运行时模型设置公开接口
│   │   ├── model-settings.ts         模型设置视图、测试、保存和运行时覆盖
│   │   └── channel-settings.ts       QQ 设置视图、校验、连接测试和运行时覆盖
│   ├── channels/
│   │   ├── index.ts                  渠道适配层公开导出
│   │   ├── types.ts                  与平台无关的入站/出站契约
│   │   ├── coalescer.ts              按会话和发送者聚合连发消息
│   │   └── qq/
│   │       ├── channel.ts            白名单、回合、拆条、限频和审计编排
│   │       ├── credentials.ts        环境变量/本地 secret 的 QQ token 解析
│   │       ├── events.ts             OneBot 11 消息解析、@ 和图片引用
│   │       ├── format.ts             目标校验、outbox 解析和回复拆条
│   │       ├── gateway.ts             QQ 渠道依赖的最小网关接口
│   │       ├── media.ts              图片三级获取、CDN 白名单和字节校验
│   │       └── onebot.ts             OneBot 11 WebSocket、鉴权、动作和重连
│   ├── core/
│   │   ├── config/
│   │   │   ├── index.ts              配置模块公开导出
│   │   │   ├── loader.ts             TOML 读取、跨文件校验
│   │   │   ├── types.ts              schema 版本和运行时类型
│   │   │   ├── validation.ts         字段、范围、路径和时间校验
│   │   │   └── errors.ts             带文件和字段位置的错误
│   │   ├── chat/
│   │   │   ├── index.ts              聊天领域公开导出
│   │   │   ├── types.ts              模型、SSE、会话目录/时间线和分页视图契约
│   │   │   ├── input.ts              文本/单图输入边界和纯图片占位正文
│   │   │   ├── envelope.ts           单次 JSON 信封解析和 reply 增量提取
│   │   │   ├── context.ts            时间/状态/记忆/历史的分块预算和确定性裁剪
│   │   │   ├── service.ts            校验、模型流、正文/记忆/状态写入、会话目录和只读时间线
│   │   │   ├── owner-history.ts      启动时把 qq-private-<owner> 历史幂等并入 main
│   │   │   ├── style.ts              确定性回复风格检查和违规代码
│   │   │   ├── mock-model.ts         不联网的明确占位模型
│   │   │   ├── magpie-model.ts       Magpie OpenAI-compatible 流式网关
│   │   │   └── model-catalog.ts      OpenAI-compatible 模型列表、能力和价格的共享解析
│   │   ├── memory/
│   │   │   ├── index.ts              长期记忆模块公开导出
│   │   │   ├── types.ts              记忆写入、纠正和检索输入契约
│   │   │   ├── service.ts            候选规则、纠正、候选转正、检索和面板视图
│   │   │   ├── candidate.ts          单条记忆候选的引用、敏感和来源门禁
│   │   │   ├── arbiter.ts            纯提醒、混合提醒和长期记忆的确定性仲裁
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
│   │   │   ├── store.ts              事务、回放、独立墓碑级联、清除、回收站、恢复和消息游标页
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
│   ├── version.ts                    独立程序与插件共享的产品版本
│   └── web/
│       ├── index.ts                  Web 适配层公开导出
│       ├── chat-http.ts              鉴权、聊天/Timeline/会话目录、SSE、记忆和静态资源路由
│       └── assets/
│           ├── index.html            双聊天视图、四个所有者页签、设置弹窗、QQ 配置和图片选择
│           ├── app.js                SSE、档案游标、主动性轮询、设置/QQ API、记忆/审计和 DOM 渲染
│           └── app.css               响应式浅色/深色样式和独立滚动容器
├── tests/
│   ├── unit/                         配置、上下文组装和纯 reducer
│   ├── integration/                  插件、聊天/SSE、视觉、上下文预算、对话信封、记忆面板、存储、清除、备份、强杀和 fail-closed
│   ├── scenarios/                    人格场景规格和脚本化管线验证
│   ├── replay/                       同一事件流快照逐字节一致性
│   ├── fixtures/                     崩溃写入和正式应用生命周期子进程夹具
│   └── helpers/                      临时目录和固定事件工厂
└── docs/
    ├── need.md                       产品需求、状态模型和验收边界
    ├── plan.md                       总体规划书、模块边界和里程碑
    ├── review-brief.md               交给高级模型的外部审查简报和可复制提示
    ├── r0-decision.md                R0 独立核心、可选执行器、真实验收和 Linux 常驻决策
    ├── r1-acceptance.md              R1 服务硬化、恢复、备份、DSH 缺席验收和未验证边界
    ├── r1-deployment.md              R1 Linux systemd 部署步骤和未实机验证声明
    ├── m5.2.1-real-acceptance.md     M5.2.1 真实小号 QQ 部分验收和未验证矩阵
    ├── memory-research.md             记忆插件源码调研和取舍
    ├── m4.0-memory-acceptance.md      M4 第 0 步记忆质量门控验收
    ├── m4-acceptance.md               M4 主动性、提醒、每日整理和 schema v9 验收
    ├── m4.5-acceptance.md             M4.5 双形态、provider、设置页和安全边界验收
    ├── m4.6-acceptance.md             M4.6/M4.6.1 提醒/记忆边界、冷却、模型发现和界面收口验收
    ├── m5-acceptance.md               M5 QQ/NapCat 渠道、schema v11 和自动测试验收
    ├── m5.1-acceptance.md             M5.1 设置弹窗、QQ 配置和低摩擦提醒验收
    ├── m5.2-acceptance.md             M5.2 所有者会话、渠道隔离和多会话档案验收
    ├── m5.2.1-acceptance.md           M5.2.1 所有者历史回填、顶部历史按钮和会话改名验收
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

- `docs/plan.md` 是**执行计划的唯一来源**，描述已确认决定、架构、里程碑和验收；R0 起以独立核心为主线。
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
- `docs/m4.5-acceptance.md` 记录 M4.5 的双形态、provider、设置页、密钥/端点治理、4100 加载回归、241 项自动测试和未验证边界。
- `docs/m4.6-acceptance.md` 记录 M4.6 的提醒/记忆仲裁、候选冷却、schema v10、模型发现、三尺寸浏览器验收、256 项自动测试和未验证边界，以及 M4.6.1 的固定高度滚动区和模型卡片选择修复。
- `docs/m5-acceptance.md` 记录 M5 的 QQ 白名单、群 @、连发聚合、多图、去重、限频、STOP、主动消息同步、schema v11、278 项自动测试和真实 NapCat/账号未验证边界。
- `docs/m5.1-acceptance.md` 记录 M5.1 的设置弹窗、QQ 渠道配置、运行时覆盖、低摩擦提醒、313 项自动测试和三尺寸 Edge 验收。
- `docs/m5.2-acceptance.md` 记录 M5.2 的“我们的对话 / 全部对话”、所有者 QQ 显式合并、其他会话隔离、50 条 `seq` 游标、319 项自动测试和三尺寸 Edge 验收。
- `docs/m5.2.1-acceptance.md` 记录 M5.2.1 的 QQ 缺失所有者提示、启动历史回填、顶部历史按钮、非 `main` 会话改名、schema v12、325 项自动测试和三尺寸 Edge 验收。
- `docs/r0-decision.md` 记录 R0 的独立核心 + 可选执行器决定、Q1～Q4、真实 QQ 部分验收和 Linux 常驻边界。
- `docs/r1-acceptance.md` 记录 R1 的锁、health、启动报告、关闭顺序、备份恢复、强杀恢复、DSH 缺席 mock 验收、342 项测试和未验证边界。
- `docs/r1-deployment.md` 记录 R1 的 Linux systemd 示例、目录/凭据、启动/停止、health、升级/回滚和未实机验证声明；`deploy/kanobot.service.example` 只是待安装模板。
- `docs/m5.2.1-real-acceptance.md` 记录真实小号 QQ + NapCat + Magpie 的已通过主路径和未验证矩阵。

聊天档案的接口边界：

- `GET /kanobot/api/conversation?limit=50&beforeSeq=<seq>` 只读取当前所有者 `main` 会话，返回 `messages/hasMore/nextBeforeSequence`。
- `GET /kanobot/api/conversations` 返回所有者会话 ID 和按最近消息排序的会话摘要，只用于已鉴权页面的来源筛选。
- `GET /kanobot/api/timeline?limit=50&beforeSeq=<seq>&conversationId=<id>` 跨会话只读聚合；`conversationId` 可省略，非法值显式 400。
- 三个接口都使用 `messages.seq` 作为稳定游标；档案查询不复制消息，不写入当前会话，也不改变模型上下文。

## 2. 目标结构

M4.5 的 `src/app`、`src/model-providers`、M4.6 的记忆仲裁/模型发现、M5 的 `src/channels` 和 R1 的锁/health/备份 CLI/systemd 材料已落地；其余目录仍按里程碑逐步出现。目录可以按实际工作量调整，但模块职责和配置归属不能混在一起。

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
├── deploy/                           systemd 等部署模板；不含凭据
├── config/
│   └── examples/                     可提交的脱敏 TOML 模板
├── src/
│   ├── plugin/                       可选 DSH 连接器、生命周期和依赖装配
│   ├── app/                          独立程序正式入口（默认；共享 core，不复用 dev）
│   ├── model-providers/              已落地：DSH ctx.llm、Magpie、OpenAI-compatible、mock
│   ├── dev/                          仅开发用的回环网页入口，不是产品入口
│   ├── core/                         配置、时钟、事件、reducer、快照、存储和迁移
│   ├── identity/                     身份基线和版本
│   ├── relationship/                 关系、边界、受伤和修复
│   ├── memory/                       记忆写入、检索、巩固和删除
│   ├── initiative/                   主动评估、闸门、outbox 和调度
│   ├── channels/                     M5 已落地：QQ/NapCat 适配器；网页仍由 web 层提供
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

M2 之后（当前到 R1）的实际数据布局：

```text
<dataDir>/
├── kanobot.lock                      运行时锁元数据，不是互斥本体；进程退出后由下次启动安全恢复
├── kanobot.sqlite                    主库（schema v12）：事件、快照、正文、对话/消息（含 display_name）、模型调用审计、记忆、记忆边界决策、FTS5、风格检查、所有者审计、紧急状态、主动性状态/计划/提醒/关心/摘要/运行记录、outbox、渠道去重/审计、墓碑投影
├── kanobot.sqlite-wal / -shm         主库运行时 sidecar，不得单独提交或当作备份
├── tombstones.sqlite                 独立墓碑库，不进入主库备份
└── backups/
    └── kanobot-backup-*.sqlite       最近 7 份主库一致性备份
```

restore 的临时/回滚文件使用 `kanobot.sqlite.restore-*`、
`kanobot.sqlite.rollback-*` 和 `kanobot.sqlite.failed-restore-*` 前缀；
它们属于运行时恢复证据，不进入 Git。锁与数据库不进入主库备份。

## 3. 文件放置规则

- 需求、规划、调研和说明放 `docs/`；根目录不再新增散落的 `.md`。
- 可提交的配置模板放 `config/examples/`；人格设定、个人配置、QQ 群号和运行时配置放在仓库外（见上），凭据只放在环境变量或 secret store。
- 业务代码按 `src/<module>/` 放置；模块之间通过明确接口交互，不共享任意全局变量。
- `core` 不导入 DSH 或独立程序专用模块。独立程序是默认宿主，DSH 插件是可选适配器，模型 provider 和渠道都只通过适配器调用 core；新增宿主不能复制人格、记忆或状态逻辑。
- 模型 provider 放在宿主/适配层，不把 Magpie、DeepSeek、Gemini 或某个第三方 URL 写进聊天核心；每次调用的精确 provider、模型、能力和审计由适配器负责。
- `src/dev` 只用于本地调试。正式独立程序已经另建在 `src/app`，补齐显式配置/数据目录、一次性登录、Cookie 鉴权、数据生命周期和发布入口；不能把开发入口换个名字就当产品。
- 独立程序的运行时锁、health 和备份管理只在 `src/app`；锁必须在打开主库、启动 scheduler 和启动 QQ 之前取得，health 不得泄露路径、凭据或聊天正文。
- 一个小型 FSM 只能放在具体流程模块内，例如 `src/channels/` 的投递状态或 `src/evolution/` 的候选生命周期；不得新增“角色总状态机”。
- 单元测试放 `tests/unit/`，跨模块和 DSH 生命周期测试放 `tests/integration/`，回放与迁移测试放 `tests/replay/`。
- 人格场景规格放 `tests/scenarios/`；当前样例使用脚本化占位回复，不能把通过结果当成真实模型行为。
- 运行时数据库、快照、日志、截图和下载放在 DSH 数据目录，不放进仓库，并设置保留期、权限和清理策略。这样复制源码或生成进化候选副本时，私人数据不会被一起复制。`.gitignore` 里的 `data/` 规则保留，作为兜底。
- `kanobot.lock`、PID、SQLite/WAL/SHM、备份和恢复临时文件都是运行时状态，不提交 Git；不能把锁文件当互斥本体，也不能用删除锁文件代替确认 IPC 所有权。
- systemd/部署示例放 `deploy/`，操作手册放 `docs/`；示例只能使用占位用户、路径和 `EnvironmentFile` 变量，不得写入真实 token、QQ 号、SSH 私钥或 API key。
- 临时诊断放 `tmp/`，不把一次性脚本或输出混入正式数据链。
- 第三方调研记录写 `docs/plugin-research.md`；实际引入/替换插件时更新 `docs/mods.md`，说明版本、原因、许可证和回滚方式。

## 4. 配置拆分规则

一个功能模块对应一个配置文件，规则在 `plan.md` 第 10.1 节；文件随对应里程碑逐步出现。M2 需要 `system`、`identity`、`life-state`、`memory`、`policy` 五个文件；M3.0 继续复用它们；M4 新增 `initiative.toml`；M5 新增可选 `channels.toml`：

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

`channels.toml` 是 QQ 开关、群列表、私聊白名单、@ 规则、聚合窗口、图片上限、回复拆条、限频和主动目标 `autonomous_target` 的手写基础配置。设置页保存时写入同目录的 Git 忽略文件 `channel-settings.json`，整体覆盖 `qq` 段；覆盖文件与 TOML 最终都经过同一个 `validateChannels`，不允许两个模块各读一份配置。只有覆盖文件也能启动 QQ。缺失两份文件时 QQ 关闭。本机回环 WebSocket 可用 `ws://`，远程地址必须 `allow_remote = true`、`wss://` 并通过环境变量或本地 secret 提供 token。真实 QQ 号、群号、白名单和 token 不进入仓库。

`system.toml` 的 `[context]` 保存单轮上下文的字符预算和分块上限；`[model]` 保存聊天 provider、精确模型、可选推理档位和凭据引用；`[vision]` 保存独立视觉模型的开关、provider、精确模型名和请求上限。`initiative.toml` 保存 tick、软计划、主动消息、提醒、outbox 和每日整理参数。聊天 provider 支持本机 Magpie、DSH `ctx.llm`、受控 OpenAI-compatible 和 mock；视觉 provider 支持本机 Magpie 或受控 OpenAI-compatible；设置页的只读模型发现复用同一 provider 草稿和端点治理，但不保存配置。`memory.toml` 的 `candidate_archive_days` 保存普通候选冷却期限，`[trash]` 保存回收站期限，`[recall]` 保存相关性和候选上限。`[storage]` 只写相对数据目录的路径；主库、墓碑库和备份目录的实际绝对路径由 `dataDir` 解析并在存储层再次检查目录逃逸。

模型来源、聊天/视觉模型、`separate`/`unified` 视觉模式、人格复核模式、主动渠道、QQ 聚合参数和记忆相关性门槛都属于可配置选项。示例配置只放脱敏默认值；设置页修改配置目录中 Git 忽略的 `model-settings.json` 和 `secrets/`，不回显密钥，不直接改仓库模板。运行时覆盖只允许 `model` 和 `vision` 段，未改配置需要重启宿主才生效。

配置目录中的运行时文件：

```text
<configDir>/
├── system.toml ...                   普通 TOML 配置
├── model-settings.json               设置页写入的聊天/视觉覆盖，含凭据引用
├── channel-settings.json             设置页写入的 QQ 覆盖；不含 token 明文
└── secrets/
    ├── model-secrets.key             AES-256-GCM 主密钥（尽力限制权限）
    └── model-secrets.json            模型和 QQ 的加密凭据条目
```

`model-settings.json`、`channel-settings.json` 和 `secrets/` 不进入 Git。主密钥与密文在同一配置目录，只提供静态加密和文件权限缓解，不是操作系统凭据管理器。QQ 设置页不会回显 token 或 `secret_...` 引用；保存失败时恢复旧覆盖文件和旧 secret。

## 5. 暂时不拆的东西

- 第一版不拆微服务；先做一个模块化单包。
- 不为了“以后可能要用”创建空模块。
- 不在 `src/` 里直接放第三方仓库副本；需要借鉴时重写并记录来源，许可证不明确时只参考思路。
- 不把 VM、浏览器 worker 或 NapCat 进程的私有实现塞进宿主核心；它们通过适配器或受限 API 接入。
