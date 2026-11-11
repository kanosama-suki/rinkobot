# 项目文件结构

以下路径相对于仓库根目录。当前形态是 R1.5 独立程序：版本 `0.21.0`，
SQLite schema v12，不包含 DSH 插件入口、DSH model provider 或 DSH 产品 UI。
旧实现可通过 Git 标签 `archive/dsh-plugin-0.20.0` 恢复。

## 1. 顶层结构

```text
rinkobot/
├── .github/workflows/ci.yml         Windows + Ubuntu / Node 24 CI
├── .gitattributes                  LF 换行和文本属性
├── .gitignore                      运行时数据、个人配置和产物忽略规则
├── AGENTS.md                        工程 agent 的操作边界和验证命令
├── CONTRIBUTING.md                  贡献流程、隐私和测试要求
├── LICENSE                          MIT 许可证
├── README.md                        安装、运行、模型、QQ、运维和文档入口
├── SECURITY.md                      漏洞报告、支持范围和部署安全边界
├── structure.md                     本文件
├── icon.svg                         产品图标资源
├── package.json                     npm 包、版本和命令
├── package-lock.json                固定依赖版本
├── config/
│   └── examples/                    可提交的占位配置和 QQ 示例
├── deploy/
│   └── rinkobot.service.example     Linux 非 root systemd 示例
├── docs/                            规划、需求、研究和验收
├── scripts/                         运维和开发 CLI
├── src/                             产品源码
└── tests/                           自动测试
```

`config/` 下除 `config/examples/` 外的个人配置、`data/`、运行时数据库、
备份、secret、日志和 `tmp/` 都被 `.gitignore` 排除。

## 2. 入口和脚本

```text
scripts/
├── app-server.ts                   正式独立程序 CLI
├── backup.ts                       主库备份 list/create/restore
├── check-import-case.ts            相对 import 路径大小写检查
├── dev-server.ts                   只用于调试的本地开发入口
├── login-url.ts                    向运行实例申请一次性登录链接
├── preflight-runtime.ts            配置、主库、墓碑库启动前预检
└── validate-config.ts              配置目录校验 CLI
```

正式入口只接受显式配置目录和数据目录，默认监听 `127.0.0.1:4200`。开发和
测试入口不能替代正式鉴权、TLS、多用户隔离或公网部署。

## 3. `src/app`

```text
src/app/
├── backup-command.ts               备份 CLI 共享实现和恢复互斥
├── health.ts                       最小健康响应和 200/503 判定
├── index.ts                        独立程序公开入口
├── runtime-lock.ts                 OS IPC 单进程锁、元数据和本地控制通道
└── server.ts                       锁、登录、HTTP、渠道和 scheduler 装配
```

一个数据目录只允许一个存活实例。锁必须先于数据库、scheduler 和 QQ 取得；
关闭顺序固定为停止新请求 → scheduler → QQ → HTTP → DB → 释放锁。

## 4. `src/core`

### 配置

```text
src/core/config/
├── errors.ts                       带文件和字段位置的配置错误
├── index.ts                        配置模块公开接口
├── loader.ts                       TOML/JSON 读取、迁移提示和跨文件校验
├── types.ts                        配置 schema 与运行时类型
└── validation.ts                   通用字段、范围、路径和时间校验
```

一个功能模块一个配置文件。运行时 `model-settings.json` 和
`channel-settings.json` 是设置页覆盖层，仍走同一套严格校验。旧配置中的
`provider = "dsh"` 或 `route` 会明确失败，不会静默迁移。

### 聊天、视觉和记忆

```text
src/core/chat/                      聊天主链路
├── budget.ts                       字符预算
├── context.ts                      身份、状态、记忆和历史组装
├── envelope.ts                     单次 JSON 信封和增量 reply 解析
├── input.ts                        文本/单图输入边界
├── magpie-model.ts                 本机 Magpie 流式模型
├── mock-model.ts                   不联网占位模型
├── model-catalog.ts                OpenAI-compatible 模型列表解析
├── owner-history.ts                所有者 QQ 历史幂等并入 main
├── service.ts                      聊天、审计、状态和记忆闭环
├── style.ts                        确定性风格检查
└── types.ts                        ChatModel / SSE / 会话视图契约

src/core/vision/                    独立视觉输入和 Magpie 视觉模型
src/core/memory/                    记忆候选、仲裁、召回、纠正和回收站
```

模型只提交回复、记忆候选和状态候选。正文、记忆、提醒和状态是否写入由
确定性代码决定。图片只在本轮内存中使用，不进入正文、事件、快照或记忆。

### 状态、主动性、策略和审计

```text
src/core/state/                     版本化事件、纯 reducer、快照和规范 JSON
src/core/initiative/                提醒、主动消息、软计划、outbox 和 scheduler
src/core/policy/                    紧急停止和确定性策略
src/core/observability/             所有者审计和统一时间线
```

不使用全局巨型 FSM。全局状态由事件日志、纯 reducer、策略派生和快照组成；
小型状态机只允许存在于局部协议或 outbox 流程。

### 存储

```text
src/core/storage/
├── backup.ts                       主库备份、校验和恢复
├── database.ts                     打开、完整性、schema 和迁移
├── memory-search.ts                FTS5 中文双列索引
├── paths.ts                        数据目录路径约束
├── records.ts                      类型化记录
├── snapshots.ts                    确定性快照读写
├── store.ts                        事务、回放、墓碑、清除和游标分页
└── types.ts                        存储契约
```

主库和独立墓碑库必须成对保留。主库备份不包含墓碑库；恢复旧主库后先重放
墓碑，已清除内容不会复活。

## 5. `src/channels`

```text
src/channels/
├── coalescer.ts                    连发消息聚合
├── types.ts                        与平台无关的入站/出站契约
└── qq/
    ├── channel.ts                  白名单、回合、拆条、限频和审计
    ├── credentials.ts              环境变量/本地 secret 解析
    ├── events.ts                   OneBot 11 消息和 @ 解析
    ├── format.ts                   目标校验、outbox 和拆条
    ├── gateway.ts                  渠道最小网关接口
    ├── media.ts                    图片获取、CDN 白名单和字节校验
    └── onebot.ts                   WebSocket、鉴权、动作和重连
```

渠道只处理平台语义、连接、幂等和投递，不复制人格、记忆、状态或调度逻辑。
只有显式 `owner_qq` 且在白名单内的私聊进入网页 `main`；其他私聊和群聊
使用独立 `conversationId`。

## 6. 模型、设置和网页

```text
src/model-providers/
├── index.ts                        provider 工厂、精确能力和凭据解析
├── secret-store.ts                 AES-256-GCM 本地密钥存储
└── url-security.ts                 第三方 URL/DNS/私网检查

src/settings/
├── channel-settings.ts             QQ 设置、校验、测试和运行时覆盖
├── model-settings.ts               聊天/视觉设置、测试、发现和保存
└── index.ts                        设置模块公开接口

src/web/
├── chat-http.ts                    页面、聊天 SSE、面板和设置 HTTP
├── index.ts                        网页模块公开接口
└── assets/
    ├── app.css                     独立 WebUI 样式
    ├── app.js                      聊天、面板和设置交互
    └── index.html                  独立 WebUI 入口
```

当前聊天 provider 只有 `mock`、`magpie` 和 `openai-compatible`。模型发现
只辅助选择，不构成工具、视觉或 reasoning 能力认证。

## 7. `src/dev`

```text
src/dev/
├── index.ts                        开发入口公开接口
└── server.ts                       mock、临时数据和一次性登录
```

`src/dev` 只是开发工具，不是正式发行形态。

## 8. 配置边界

| 文件 | 职责 |
| --- | --- |
| `system.toml` | 时间、上下文预算、聊天/视觉模型、资源、存储 |
| `identity.toml` | 占位或私有身份；正式人格文件不进 Git |
| `life-state.toml` | 初始状态、衰减和关系变化上限 |
| `memory.toml` | 回收站、召回相关性和候选上限 |
| `initiative.toml` | tick、主动消息、提醒、outbox、软计划和每日整理 |
| `channels.toml` | QQ 开关、白名单、群规则、聚合、图片和限频 |
| `policy.toml` | 工具白名单、权限、发布限制、紧急停止 |

真实人格、QQ 号、群号、token、API key、服务器密码和 SSH 私钥不得进入
仓库、示例、测试、日志、审计或提交信息。

## 9. 测试

```text
tests/
├── unit/                           纯函数、配置、安全、格式和 reducer
├── integration/                    存储、聊天、QQ、设置、HTTP 和恢复
├── replay/                         事件回放和快照确定性
├── scenarios/                      人格场景规格
├── fixtures/                       崩溃 writer 等测试夹具
└── helpers/                        临时工作区和测试信封
```

测试使用 `node:test` 和临时目录，不读取真实人格，不调用真实模型，不连接
真实 NapCat/QQ，也不操作正式数据库。CI 在 Windows 和 Ubuntu、Node 24 上
运行。

## 10. 文档

当前文档：

- `docs/plan.md`：执行计划的唯一来源；
- `docs/need.md`：产品需求、关系边界和变更记录；
- `docs/r0-decision.md`：独立核心 + 可选执行器；
- `docs/r1-acceptance.md`、`docs/r1-deployment.md`：服务硬化和 Linux 部署；
- `docs/r1.5-decoupling.md`：删除 DSH 插件/provider 的契约变化；
- `docs/plugin-research.md`、`docs/memory-research.md`：只读调研；
- `docs/review-brief.md`：外部审查简报；
- `docs/mods.md`：第三方依赖和改动记录。

`docs/m1-*` 到 `docs/m5.2.1-*`、`docs/archive/plugin-catalog.zh.md`、
`docs/replan-*` 属于旧插件时代材料，只作历史证据，不是当前安装或架构依据。

## 11. 文件放置规则

- 新业务能力放进 `src/core/<module>/`，通过 `index.ts` 暴露公开接口；
- 平台协议放进 `src/channels/<platform>/`，不导入其他渠道私有文件；
- 模型实现放进 `src/model-providers/` 或对应 core model 文件；
- HTTP 只放在 `src/web/`，不能把页面逻辑渗入 `core`；
- 正式进程装配只放在 `src/app/`；
- 新配置优先按功能模块拆分，不能把 QQ、人格和模型参数混在一个文件；
- `core` 不依赖 DSH、桌面、编辑器、浏览器 worker 或 VM；
- 未来的 DSH 只能是可选外部执行器/连接器，不能成为插件宿主、第二数据库
  或第二调度器。
