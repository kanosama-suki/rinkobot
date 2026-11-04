# 项目文件结构

以下路径相对于项目根目录 `a/`。当前仓库处于 M0 文档阶段：**只有文档，没有 `src/`、`tests/` 或可运行插件**。本文中的“目标结构”是后续实现的约束，不是已经存在的目录。

## 1. 当前结构

```text
kanobot/a/
├── AGENTS.md                         工程 agent 的操作边界和当前状态
├── README.md                         项目简介、阅读入口和阶段声明
├── structure.md                      本文件：目录和文件放置规则
├── .gitignore                        运行时数据、个人配置和产物忽略规则
└── docs/
    ├── need.md                       产品需求、状态模型和验收边界
    ├── plan.md                       总体规划书、模块边界和里程碑
    ├── plugin-research.md            第三方插件源码调研与取舍
    ├── plugin-catalog.zh.md          第三方 DSH 插件汇总表（只读参考）
    └── mods.md                       第三方插件与改动的记录模板
```

文件性质：

- `docs/need.md` 是**产品需求来源**，描述为什么做、关系是什么、哪些事情不能做。
- `docs/plan.md` 是**详细执行规划**，描述模块、配置、状态、测试和里程碑。
- `docs/plugin-research.md` 是**调研证据**，其中的结论只针对记录的 commit 和快照。
- `docs/plugin-catalog.zh.md` 是第三方目录的本地副本，**不是依赖清单、不是安全背书**，不得据此直接安装插件。
- `docs/mods.md` 记录插件引入、替换和迁移；当前明确没有直接安装第三方插件作为生产依赖。

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
│   └── mods.md
├── config/
│   └── examples/                     可提交的脱敏 TOML 模板
├── src/
│   ├── plugin/                       DSH 入口、生命周期和依赖装配
│   ├── core/                         时钟、事件、配置加载、存储、迁移
│   ├── identity/                     身份基线和版本
│   ├── life-state/                   状态 schema、reducer、衰减和回放
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
│   └── fixtures/                     脱敏测试数据
├── data/                             运行时数据库、快照和日志（不提交）
└── tmp/                              一次性诊断和草稿（不提交）
```

## 3. 文件放置规则

- 需求、规划、调研和说明放 `docs/`；根目录不再新增散落的 `.md`。
- 可提交的配置模板放 `config/examples/`；个人配置、QQ 群号、凭据和运行时配置放 `data/` 或 secret store，不进入 Git。
- 业务代码按 `src/<module>/` 放置；模块之间通过明确接口交互，不共享任意全局变量。
- 一个小型 FSM 只能放在具体流程模块内，例如 `src/channels/` 的投递状态或 `src/evolution/` 的候选生命周期；不得新增“角色总状态机”。
- 单元测试放 `tests/unit/`，跨模块和 DSH 生命周期测试放 `tests/integration/`，回放与迁移测试放 `tests/replay/`。
- 运行时数据库、快照、日志、截图和下载放 `data/`，并设置保留期、权限和清理策略。
- 临时诊断放 `tmp/`，不把一次性脚本或输出混入正式数据链。
- 第三方调研记录写 `docs/plugin-research.md`；实际引入/替换插件时更新 `docs/mods.md`，说明版本、原因、许可证和回滚方式。

## 4. 配置拆分规则

一个功能模块对应一个配置文件，详细字段在 `plan.md` 第 6 节：

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

## 5. 暂时不拆的东西

- 第一版不拆微服务；先做一个模块化单包。
- 不为了“以后可能要用”创建空模块。
- 不在 `src/` 里直接放第三方仓库副本；需要借鉴时重写并记录来源，许可证不明确时只参考思路。
- 不把 VM、浏览器 worker 或 NapCat 进程的私有实现塞进宿主核心；它们通过适配器或受限 API 接入。
