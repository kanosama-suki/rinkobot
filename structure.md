# 项目文件结构

以下路径相对于项目根目录 `a/`。当前仓库处于 M2 完成、M3 未开始的状态：已有 DSH Host 插件、严格配置、版本化事件、纯 reducer、SQLite 主库与独立墓碑库、快照、删除和备份；FTS5 检索、网页聊天、模型网关和主动消息仍不存在。本文中的“目标结构”是后续实现的约束，不是已经存在的目录。

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
│   └── examples/                     可提交的占位 system/identity/life-state/memory/policy TOML
├── scripts/
│   ├── check-import-case.ts          相对 import 路径大小写检查
│   ├── validate-config.ts            配置目录预检 CLI
│   ├── preflight-runtime.ts          配置、主库、墓碑库的启动前预检
│   └── m1-lifecycle.ts               10 次 apply/dispose 生命周期报告
├── src/
│   ├── plugin/
│   │   ├── index.ts                  DSH Host 插件入口
│   │   ├── lifecycle.ts              定时器生命周期
│   │   ├── version.ts                插件名和版本
│   │   └── cordis.patch.yml          bundle 默认插入的插件行
│   └── core/
│       ├── config/
│       │   ├── index.ts              配置模块公开导出
│       │   ├── loader.ts             TOML 读取、跨文件校验
│       │   ├── types.ts              schema 版本和运行时类型
│       │   ├── validation.ts         字段、范围、路径和时间校验
│       │   └── errors.ts             带文件和字段位置的错误
│       ├── state/
│       │   ├── types.ts              事件、快照、记忆和墓碑契约
│       │   ├── events.ts             数据契约严格校验
│       │   ├── reducer.ts            纯状态转移和数值夹紧
│       │   ├── canonical.ts          确定性 JSON 和哈希
│       │   ├── clock.ts              唯一真实时钟接口
│       │   └── index.ts              状态模块公开导出
│       └── storage/
│           ├── database.ts           打开、完整性、迁移和表 schema
│           ├── store.ts              事务、回放、独立墓碑级联、清除、回收站和恢复
│           ├── snapshots.ts          快照构造、写入和严格读取
│           ├── backup.ts             VACUUM INTO、quick_check、保留和恢复
│           ├── paths.ts              数据目录内的安全路径解析
│           ├── records.ts            正文/outbox 壳记录校验
│           ├── errors.ts             带 code 和 path 的存储错误
│           ├── types.ts              存储公开类型
│           └── index.ts              存储模块公开导出
├── tests/
│   ├── unit/                         配置和纯 reducer
│   ├── integration/                  插件、存储、清除、备份、强杀和 fail-closed
│   ├── replay/                       同一事件流快照逐字节一致性
│   ├── fixtures/                     崩溃写入子进程等测试夹具
│   └── helpers/                      临时目录和固定事件工厂
└── docs/
    ├── need.md                       产品需求、状态模型和验收边界
    ├── plan.md                       总体规划书、模块边界和里程碑
    ├── m1-acceptance.md              M1 八项验收、证据和已知边界
    ├── m2-acceptance.md              M2 五项验收、运行证据和已知边界
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

M2 的实际数据布局：

```text
<dataDir>/
├── kanobot.sqlite                    主库：事件、快照、正文、记忆、outbox、墓碑投影
├── tombstones.sqlite                 独立墓碑库，不进入主库备份
└── backups/
    └── kanobot-backup-*.sqlite       最近 7 份主库一致性备份
```

## 3. 文件放置规则

- 需求、规划、调研和说明放 `docs/`；根目录不再新增散落的 `.md`。
- 可提交的配置模板放 `config/examples/`；人格设定、个人配置、QQ 群号和运行时配置放在仓库外（见上），凭据只放在环境变量或 secret store。
- 业务代码按 `src/<module>/` 放置；模块之间通过明确接口交互，不共享任意全局变量。
- 一个小型 FSM 只能放在具体流程模块内，例如 `src/channels/` 的投递状态或 `src/evolution/` 的候选生命周期；不得新增“角色总状态机”。
- 单元测试放 `tests/unit/`，跨模块和 DSH 生命周期测试放 `tests/integration/`，回放与迁移测试放 `tests/replay/`。
- 运行时数据库、快照、日志、截图和下载放在 DSH 数据目录，不放进仓库，并设置保留期、权限和清理策略。这样复制源码或生成进化候选副本时，私人数据不会被一起复制。`.gitignore` 里的 `data/` 规则保留，作为兜底。
- 临时诊断放 `tmp/`，不把一次性脚本或输出混入正式数据链。
- 第三方调研记录写 `docs/plugin-research.md`；实际引入/替换插件时更新 `docs/mods.md`，说明版本、原因、许可证和回滚方式。

## 4. 配置拆分规则

一个功能模块对应一个配置文件，规则在 `plan.md` 第 10.1 节；文件随对应里程碑逐步出现。M2 需要 `system`、`identity`、`life-state`、`memory`、`policy` 五个文件：

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

`system.toml` 的 `[storage]` 只写相对数据目录的路径。主库、墓碑库和备份目录的实际绝对路径由 `dataDir` 解析并在存储层再次检查目录逃逸。

## 5. 暂时不拆的东西

- 第一版不拆微服务；先做一个模块化单包。
- 不为了“以后可能要用”创建空模块。
- 不在 `src/` 里直接放第三方仓库副本；需要借鉴时重写并记录来源，许可证不明确时只参考思路。
- 不把 VM、浏览器 worker 或 NapCat 进程的私有实现塞进宿主核心；它们通过适配器或受限 API 接入。
