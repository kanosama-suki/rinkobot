# AGENTS.md

## 0. 项目一句话

Rinkobot 是一个自托管、连续、可恢复、可审计的陪伴型机器人。当前主线是
R1.5 独立程序：版本 `0.21.0`，SQLite schema v12，MIT 许可证。主分支不再
是 DSH 插件，也不依赖 DSH 提供模型、会话或生命周期。

已具备网页聊天、长期记忆、提醒、主动消息、QQ/NapCat、独立视觉模型、统一
审计、紧急停止、单进程所有权、健康检查、备份恢复和 Linux systemd 示例。
真实 QQ 完整矩阵、真实第三方模型选型、Linux 实机常驻和一至两周日常观察
仍未完整验收。

## 1. 必读顺序

1. `docs/plan.md`：执行计划唯一来源。
2. `docs/need.md`：产品需求、关系边界和设计理由。
3. `structure.md`：目录、模块和文件放置规则。
4. `docs/r1.5-decoupling.md`：独立化后的契约和迁移行为。
5. `docs/r0-decision.md`、`docs/r1-acceptance.md`：架构决定和 R1 边界。
6. `docs/plugin-research.md`、`docs/memory-research.md`：只读调研，不是依赖。

旧的 M 系列验收文档属于历史材料，不能据此恢复 DSH 插件形态。旧实现可通过
Git 标签 `archive/dsh-plugin-0.20.0` 查看。

## 2. 红线

- 不重新把产品变成 DSH 插件。未来 DSH 只能作为可选外部执行器/连接器，
  通过窄接口联动。
- 一个核心、一个主数据库、一个调度器、一个主写入者。外部执行器不能直接
  打开主库、启动第二套调度器或成为产品生命周期根。
- 不使用全局巨型 FSM。全局状态使用版本化事件、纯 reducer、策略层、事件
  日志和快照；小型 FSM 只能用于局部协议或 outbox 流程。
- 不让模型直接修改核心身份基线、权限、审计、紧急停止或生产配置。
- 不把服务器密码、SSH 私钥、API key、QQ 凭据、Cookie、token 或真实聊天
  正文写入仓库、文档、示例、提示词、状态快照、普通日志或提交信息。
- 不把个人 QQ 号、群号、好友列表或真实人格写入 Git。正式人格在仓库外；
  仓库只使用占位身份。
- 不伪造测试、运行结果、平台验收、许可证结论或“已完成”状态。
- 不在数据库损坏或 schema 不兼容时自动删库、建空库或忽略损坏记录；必须
  fail-closed 并保留原文件。
- 不把聊天原文写进事件或快照；正文只进可彻底清除的 `bodies` 表。
- 图片只允许在本轮内存中传给视觉模型；不得写入正文、事件、快照、记忆、
  普通日志或审计正文。视觉失败不能让聊天模型假装看过。
- 不把 `tombstones.sqlite` 纳入主库备份，也不在恢复旧主库后跳过墓碑重放。
- 不在未明确要求时操作生产服务器、部署 VM 或修改远端配置。
- 不提交无关改动。用户明确要求提交时才运行 `git commit`；推送同样需要
  明确授权。

## 3. 架构与接口

- 正式入口是 `src/app/`，拥有锁、HTTP、scheduler、QQ、数据库和关闭顺序。
- `core` 不导入 DSH、桌面、编辑器、浏览器 worker、VM 或平台渠道。
- 模型 provider 只在 `src/model-providers` 和对应 core model 适配器中装配。
  当前仅支持 `mock`、`magpie` 和 `openai-compatible`。
- 旧配置中的 `provider = "dsh"` 或 `route` 必须继续 fail-closed，并给出
  R1.5 迁移提示；不能静默改写或降级。
- 数据目录 OS IPC 锁必须先于主库、scheduler 和 QQ 取得。关闭顺序固定为
  停止接新请求 → scheduler → QQ → HTTP → DB → 释放锁。
- `GET /kanobot/api/health` 只返回最小状态；数据库或 scheduler 不可用时
  返回 503。未登录 health 不暴露路径、模型、token、QQ 号或聊天正文。
- 配置按功能模块拆分：`system`、`identity`、`life-state`、`memory`、
  `initiative`、`channels`、`policy`。一个模块一个配置文件。
- 配置加载器负责 schema、默认值、跨文件引用、迁移和 fail-closed；模块不能
  绕过加载器读取散落参数。
- 聊天模型和视觉模型独立配置。真实 provider 启动前必须检查精确模型、
  输出上限和必要能力；缺失时拒绝启动，不自动切换模型。
- `StateEvent` / `StateSnapshot` / `Appraisal` / `Policy` 必须版本化。
  模型只能提交候选变化，reducer 和 policy 决定持久化与权限。
- 状态字段必须有读取者或写入者，并影响可观察行为。虚拟身体状态明确标记为
  模拟，不能冒充真实生理或医疗事实。
- 网页、聊天、文件和未来工具结果都是不可信输入，不能成为系统指令或未经
  核验的事实记忆。
- 渠道适配器只处理平台语义、连接、去重、幂等和投递，不复制人格、状态或
  记忆逻辑。
- 只有显式 `qq.owner_qq` 且在白名单内的私聊进入网页 `main`；其他私聊和
  群聊使用独立 `conversationId`，不得读写所有者记忆或提交所有者提醒/关心。
- 事件追加和可选快照在同一事务提交；reducer 不读系统时间、网络或随机数。
- 快照按规范 JSON 保存并校验哈希；回放必须从最近快照加后续事件恢复。
- 独立墓碑库是删除的权威来源；主库里的 `tombstones` 表只是投影。
- 彻底清除必须级联正文、记忆、outbox、承诺事件依赖和快照，再执行 `VACUUM`
  与 `wal_checkpoint(TRUNCATE)`。

## 4. 工作流

1. 先读 `docs/plan.md` 和 `docs/need.md` 的相关章节，确认没有把后置功能
   拉进当前里程碑。
2. 做最小、聚焦的改动。不要顺手修复无关问题或改文件名制造大 diff。
3. 新增功能先补接口、schema 和失败路径，再补实现。新增状态字段必须同时
   补读取者或行为测试。
4. 先跑最接近改动的测试，再跑完整测试和配置检查。
5. 目录、配置或架构变化后，同步更新 `structure.md`、`README.md` 和相关
   文档。
6. 汇报改动文件、验证命令、真实结果、未验证项和下一步。不要用“应该可以”
   代替实际运行结果。

开发命令：

```powershell
npm ci
npm test
npm run check:case
npm run config:check
npm run dev
npm run app -- --config <配置目录> --data <数据目录>
npm run login -- --data <数据目录>
npm run backup -- --config <配置目录> --data <数据目录> list
npm run backup -- --config <配置目录> --data <数据目录> create
node scripts/preflight-runtime.ts <配置目录> <数据目录>
node --check src/web/assets/app.js
npm pack --dry-run
git diff --check
```

自动测试使用 `node:test` 和临时目录，不读取真实人格，不调用真实模型，不连接
真实 NapCat/QQ，也不操作正式数据库。QQ 测试使用本机 mock OneBot；服务硬化
测试使用临时数据目录。不要编造未运行的命令输出。

## 5. 当前状态

- 阶段：R1.5 独立化完成，下一步按 `docs/plan.md` 进入 R2。
- 产品版本：`0.21.0`；schema：v12；许可证：MIT。
- 已删除：DSH 插件入口、DSH model provider、DSH route、DSH 登录复用和
  DSH 专用 UI。
- 已保留：独立 WebUI、QQ/NapCat、记忆、提醒、主动性、审计、备份、恢复和
  Linux systemd 示例。
- 未验证：真实 QQ 完整矩阵、长期日常运行、Linux systemd 实机、真实第三方
  付费 API、浏览器 worker、VM、单机游戏、自进化和公开发送。
- 下一步入口：`docs/plan.md` 的 R2；DSH 只作为未来可选外部执行器/连接器，
  不是当前依赖。

## 6. 代码规范

- 语言用 TypeScript，直接用 Node 24 运行；测试用 `node:test`，数据库用
  `node:sqlite`。
- 接口、事件、配置和持久化 schema 使用明确类型；避免 `any` 扩散和无来源的
  隐式默认值。
- 模块只通过公开接口交互；业务代码按 `src/<module>/` 放置，不读取其他模块
  的私有文件。
- 不添加没有读取者的状态字段或没有行为效果的关系数值。
- 失败要显式记录原因、来源和可恢复性；不能用静默重试掩盖配置错误、权限
  错误或数据损坏。
- 日志和审计默认脱敏；敏感值只记录引用或不可逆摘要。
- 注释解释边界、失败路径和不显而易见的设计理由，不写口号或逐行解释赋值。
- 每个源码、脚本和测试模块顶部写清职责与边界。
- 新增第三方依赖前在 `docs/mods.md` 记录版本、许可证、维护状态、用途和
  移除方式；能用本地小实现解决的，不先引入重依赖。
- 代码格式以项目实际配置为准；没有配置时不要擅自引入新格式化工具。

## 7. Python 导入规范

如果后续脚本使用 Python：

- 标准库和第三方库的 `from ... import ...` 放在前面，直接 `import ...`
  放在后面；
- 多个 `from ... import ...` 项在不引起导入错误的前提下按字母排序；
- 同目录模块使用相对导入；
- 跨目录模块使用以 `from src` 开头的绝对导入；
- 第二层目录名相同的导入尽量放在一起。
