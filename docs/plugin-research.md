# DSH 陪伴插件源码调研

> 调研日期：2026-11-04
> 调研方式：从 GitHub 浅克隆候选仓库，静态阅读源码、测试、设计文档和许可证；没有安装、启动或执行任何候选插件。
> 结论用途：为自研陪伴核心筛选可借鉴的机制，不代表对任何候选插件做过完整安全审计。

## 1. 方法与边界

- 以 `git clone --depth 1` 获取源码，记录当时的 commit hash。
- 对照 `README`、设计文档、实际源文件和测试目录；优先相信代码结构，不把宣传文案当成已验证事实。
- “测试数量”是仓库中名称像测试的文件数量，不等于测试全部通过，也不等于真实平台验收。
- 没有运行第三方代码，没有连接真实 QQ、浏览器账号或生产 DSH。
- 第三方插件拥有与宿主相同的机器权限；目录收录、星标或 README 都不能替代供应链安全审计。

## 2. 总体结论

**不建议直接安装任何候选插件作为产品底座。**

原因是这些插件各自解决的是“通用任务 Agent 的某个功能”，而本产品需要：

- 长期稳定的身份和关系连续性；
- 可回放、可审计的状态；
- 跨网页和 QQ 的同一人格；
- 对数字生活、公开发送和代码进化的分层治理；
- 未来可迁移到不同 DSH 版本和部署环境。

最值得借鉴的不是它们的完整实现，而是几个边界清楚的做法：

1. **主动联系**：调度器、安静时段、随机抖动、每日预算、崩溃恢复和确定性闸门。
2. **状态**：纯函数状态转移、情绪半衰期、关系多维化、虚拟身体和驱动力。
3. **记忆**：候选经验、来源证据、人工采纳、遗忘和复习。
4. **渠道**：统一出站接口、白名单、fail-closed、去重、限频和连接恢复。
5. **进化**：候选版本、基线对比、影子试用、审批和回滚。
6. **浏览器**：独立浏览器上下文、审批策略和“页面内容不可信”的明确边界。

## 3. 候选仓库快照

以下路径相对于各自仓库根目录。commit 是本次浅克隆的版本，后续上游可能变化。

| 仓库 | commit | 许可 | 可核验的工程量 | 结论 |
| --- | --- | --- | --- | --- |
| `john-walks-slow/dsh-proactive` | `cae01f36b8aa` | `package.json` 声明 MIT，但快照根目录未发现 `LICENSE` 文件 | 148 个文件；17 个测试类文件 | **重点借鉴调度和闸门**；不要直接复制代码，先确认许可文件缺失问题 |
| `Kanadego/dsh-heartbeat` | `b2c0ac793a1e` | MIT | 216 个文件；47 个测试类文件；设计文档自称 378 个测试 | **借鉴静默/闸门/素材池**；不作为跨平台底座，README 与 DESIGN 的平台描述存在冲突 |
| `icyaaaww/dsh-soul` | `382d8072f057` | MIT | 86 个文件；26 个测试类文件 | **借鉴候选/基线成对验证、影子试用、回滚**；Git worktree 不是安全沙箱 |
| `Anarrogantcat/dsh-identity` | `8591899e972f` | MIT | 400 个文件；196 个测试类文件 | **借鉴心情衰减和关系维度**；体量大、默认人格强，不直接采用 |
| `m-rui001/dsh-mate-companion` | `a6d715c1bfa6` | MIT | 26 个文件；没有测试类文件 | **借鉴状态维度和纯函数 affective kernel**；理论模型很重，无测试，不能直接依赖 |
| `wld12314/dsh-mind` | `b088cf9cd478` | MIT | 20 个文件；没有测试类文件 | **只借鉴时间衰减和状态注入**；关键词心情判断和测试缺口明显 |
| `john-walks-slow/dsh-simulated-life` | `c7f0abf67a15` | MIT | 30 个文件；5 个测试类文件 | **借鉴 `.life/<yymmdd>/events.json` 生活事件协议**；适合作为数据格式参考 |
| `anweat/dsh-browser` | `673c8bb90675` | MIT | 502 个文件；98 个测试类文件 | **借鉴 Playwright、审批和权限边界**；`allowedDomains` 不是网络隔离 |
| `arrow1031-dev/dsh-qq-bot` | `960b5ab3297d` | MIT | 172 个文件；51 个测试类文件 | **借鉴 OneBot/多适配器、白名单、fail-closed、限频和恢复**；不直接作为底座 |
| `Applepinea/dsh-qq-access` | `ee0a708c6e07` | MIT | 32 个文件；实际只有 `tests/smoke.test.mjs`，其中 8 个 `test()` | **仅参考外部 NapCat 接入和配置校验**；文档声称的 36 项测试与快照实际内容不吻合，不能当真实验收 |
| `aureth-labs/dsh-aurabot-qq` | `b3301f6b0140` | MIT | 193 个文件；52 个测试类文件 | **借鉴模块热重载、统一 send hook 和权限分层**；产品绑定强，不直接采用 |
| `kenz1117/dsh-engram` | `532f1ed3d82b` | MIT | 234 个文件；54 个测试类文件 | **借鉴来源审计、证据门、FTS + 向量检索**；第一版偏重 |
| `STARDUSTLC666/dsh-dream` | `9358c1103682` | MIT | 142 个文件；37 个测试类文件 | **重点借鉴候选经验、来源核验、人工采纳和记忆复习** |
| `Britneycode/dsh-fish-soul` | `125d63876485` | README 和 `package.json` 声明 MIT，但根目录未发现 `LICENSE` 文件 | 120 个文件；38 个测试类文件 | **借鉴虚拟时钟、作息、失败重发和日记**；单体较大，不直接采用 |
| `Anmulzhao/DSH-AGINT` | `1d850839cc0a` | MIT | 1393 个文件；455 个测试类文件；41 个 Cordis 插件 | **借鉴进化治理概念**；复杂度和自述缺口都很高，不适合做底座 |
| `xmanrui/dsh-im` | `c826bfa415d7` | MIT | 943 个文件；314 个测试类文件 | **重点借鉴渠道抽象、访问策略和主动投递**；QQ 使用官方 Bot SDK，不是个人 QQ/NapCat 路径 |
| `FeatherHunter/dsh-im-companion` | `8ccc2c30bddd` | MIT | 680 个文件；没有传统 `test/` 目录，但有大量 `tools/verify` 脚本 | **只借鉴 IM 管理界面和助理/渠道绑定模型**；不是接入核心 |

## 4. 关键源码证据

### 4.1 主动联系与调度

#### `dsh-proactive`

证据：

- `packages/dsh-proactive/src/scheduler.ts`
- `packages/dsh-proactive/src/config.ts`
- `packages/dsh-proactive/README.en.md`

可借鉴点：

- 单序列化调度循环，避免多个定时器同时触发；
- `quiet hours`、每小时唤醒上限、每日投递预算的顺序化闸门；
- 随机抖动预先生成到下一次触发时间，避免整点同时触发；
- 启动时恢复 `in-flight` 任务；
- 忙碌/失败有有界重试，不会无限循环；
- 每次唤醒都有运行记录和原因。

风险：

- `package.json` 声明 MIT，但快照里没有 `LICENSE` 文件；
- 它是宿主级唤醒，不是“陪伴判断”本身；
- 不能直接用它的时间表决定是否联系，必须在其前面加入用户状态、关系状态和内容价值判断。

适合做法：把它的“调度器”当作执行层参考，把“是否值得开口”放在我们自己的策略层。

#### `dsh-heartbeat`

证据：

- `DESIGN.md`
- `src/gate/gate.ts`
- `README.md`

可借鉴点：

- 表达前最后一道确定性闸门；
- 安静时段、忙闲、每日上限、冷却；
- 闸门每个拒绝原因都能审计；
- 失败投递不应消耗发送额度或冷却；
- 静默不产生付费调用；
- 素材池和投递前复查。

关键限制：

- `DESIGN.md` 明确写旧版是 Windows 专属、依赖 PowerShell 探针和 DPAPI；
- 当前 README 声称 v2.1.0 起 Linux/macOS 可运行，但若干探针仍不可用；
- 这是“平台描述需要核对”的典型例子，不能只看 README 的跨平台标签；
- 加密数据不跨平台迁移。

适合做法：借鉴 `evaluateGate` 的纯决策核心和“拒绝原因必须可审计”，不照搬其 Windows 环境探测。

### 4.2 心情、关系与状态

#### `dsh-identity`

证据：

- `lib/moodv2.js`
- `README.md`

可借鉴点：

- 情绪有基线，随时间向基线衰减；
- 负面情绪的半衰期可以比正面更长；
- 心情只影响语气和表达，不改变事实、边界和安全规则；
- 关系、精力、承诺、自我模型等分开建模；
- 有审计和纠错入口。

不采用原因：

- 代码体量大，功能面很广；
- 默认人格和 QQ 场景绑定较强；
- 直接采用会把我们的产品变成另一个“拼装人格插件”，而不是自研核心。

适合做法：借鉴数值边界、半衰期和关系维度，自己定义更小、更可测试的 schema。

#### `dsh-mate-companion`

证据：

- `packages/mate/src/types.ts`

可借鉴点：

- 明确把情绪、PAD、人格、角色、关系、驱动力、信念、注意力、虚拟疲劳和昼夜节律分开；
- 注释反复强调“每个字段必须有读取者或写入者”，避免无意义的装饰性状态；
- 关系不是单一好感度，而是信任、依恋、尊重、挫败、熟悉度等维度；
- 纯函数转移，不调用 LLM。

风险：

- 26 个文件但没有测试；
- 理论模型偏重，情绪矩阵和复杂数学不适合作为第一版最小核心；
- 没有测试的“精妙模型”不能直接生产化。

适合做法：借鉴字段边界和“不要存没人读的字段”的原则，砍掉大部分理论层，只保留可解释、可用测试覆盖的维度。

#### `dsh-mind`

证据：

- `README.md`

可借鉴点：

- 心情、记忆、日记等模块独立开关；
- 按时间衰减；
- 日记只保存当时发生了什么，不强行编造因果关系。

风险：

- 快照只有 20 个文件，没有测试类文件；
- 心情主要依赖关键词，容易误判；
- README 自己说明了模板式日记、开关复用等问题。

适合做法：只借鉴“心情有时间和来源，不要把后来解释写成当时事实”，不采用其关键词判定。

### 4.3 生活事件

#### `dsh-simulated-life`

证据：

- `src/types.ts`
- `README.en.md`

可借鉴点：

- `.life/<yymmdd>/events.json` 的简单事件协议；
- 事件有 `id/time/type/title/description/actors/location/importance/impact`；
- 她的反应写回同一事件，而不是另起一个不可追溯的状态；
- 按时间窗注入、会话级去重、原子写回；
- 事件创建、事件读取和事件反应解耦。

适合做法：把它的文件协议作为“生活事件”接口参考，但我们的核心存储应使用结构化数据库和 schema 版本，而不是直接长期依赖散落 JSON 文件。

#### `dsh-fish-soul`

证据：

- `lib/clock.js`
- `lib/life.js`
- `lib/outbox.js`
- `README.md`

可借鉴点：

- 虚拟业务时钟和真实调度时钟分离；
- 日程、作息和可用性分段；
- 未发送回复进入 outbox，退避重试，重启不丢；
- 记忆、人格、心情和平台适配有相对清楚的源码分层。

风险：

- README 和 `package.json` 声明 MIT，但快照根目录没有 `LICENSE` 文件；
- 代码量很大且单角色、平台绑定强；
- 抖音/QQ 等真实平台适配需要单独验收；
- 大量功能集中在一个插件里，阅读和迁移成本高。

适合做法：借鉴“虚拟时钟”和“outbox”，但不要直接把它的单体作为我们的架构。

### 4.4 记忆与反思

#### `dsh-dream`

证据：

- `src/evidence.ts`
- `src/automatic.ts`
- `src/memory.ts`
- `docs/VALIDATION.md`
- 37 个测试类文件

可借鉴点：

- 任务结束后生成**候选经验**，而不是直接写进长期规则；
- 候选必须带来源、适用范围、条件和例外；
- 只有人类明确采纳的候选才算正式可用经验；
- 证据核验会读取实际会话记录，模型提供的 hash/verification 不可信；
- 自动整理有预算、队列、冷却和失败状态；
- 记忆有复习期限、冲突处理和来源链。

适合做法：这是我们第一版记忆巩固最值得参考的仓库。我们不需要复制它的全部 UI，但应保留“候选、证据、人工采纳、复习”的数据流。

#### `dsh-engram`

证据：

- `src/retrieve/evidence.ts`
- `README.en.md`
- 54 个测试类文件

可借鉴点：

- FTS5 + 本地向量 + RRF 融合；
- 检索批次和证据引用；
- 模型必须提交证据引用才能声称“足够回答”；
- 来源、会话、事件序号、替代链和操作日志；
- 遗忘、复习和矛盾候选。

风险：

- 功能非常完整，但第一版直接采用会引入较大依赖和复杂度；
- 本地 embedding 模型、SQLite schema、面板和管理工具都需要维护；
- 证据门能减少“凭空记忆”，但不能消除模型对证据的错误解释。

适合做法：第一版用简单 FTS + 来源字段；等核心稳定后再评估是否引入向量检索和更强的证据门。

### 4.5 自进化

#### `dsh-soul`

证据：

- `src/evolve.js`
- `src/validation.js`
- `README.md`

可借鉴点：

- 先产生候选，不直接替换生产版本；
- 同一固定提交、同一任务、同一路由和同一验收定义下做基线与候选成对重跑；
- 通过后才进入 shadow；
- shadow 中出现用户纠正、未完成、工具错误高于基线时自动回滚；
- 回滚后保留经验状态，避免同一失败无限重试；
- 验收路径有保护，agent 不能随便改测试给自己放行。

关键限制：

> README 明确说明：**Git worktree 不是安全沙箱**，宿主工具仍有正常权限；它不能对抗恶意代码，也不能代替独立 VM/进程隔离。

适合做法：借鉴“候选基线对比、影子期、失败回滚”的流程。我们的代码执行必须在独立 VM/容器中进行，不能把 worktree 当安全边界。

#### `DSH-AGINT`

证据：

- `docs/evolution-framework.md`
- `plugins/agint-mutator/README.md`
- `plugins/agint-quality-sandbox/README.md`
- `AGENTS.md`
- `docs/known-limitations/`

可借鉴点：

- 静态准入、沙箱、集成评估、灰度发布的分段思路；
- 变更提案要求预期效果和回滚条件；
- 影子期、预算对齐、退化探测；
- “安全 > 效率”的硬约束；
- 变更必须带审计和 kill-switch。

为什么不适合直接作为底座：

- 41 个 Cordis 插件、1400 多个文件，复杂度远超第一版需求；
- 仓库自己的 `AGENTS.md` 承认 L0 变更没有事前审批，技术上任何人都可以执行；
- `docs/known-limitations/` 明确记录了事件总线影子发布、主链未完全通电等缺口；
- 它更像一个长期实验平台，不是可直接嵌入陪伴产品的稳定内核。

适合做法：借鉴“候选、评估、灰度、回滚”的词汇和阶段划分，用更小的实现完成第一版。

### 4.6 渠道与 QQ

#### `dsh-im`

证据：

- `README.md`
- `PROACTIVE_DELIVERY.md`
- `src/channels/`
- `test/`（314 个测试类文件）

可借鉴点：

- 把不同 IM 渠道抽象成适配器；
- 统一 `ctx.dshIm.send(botId, targetId, text, options)` 出站接口；
- 主动投递只依赖稳定的 `botId + targetId`，不暴露会话内部 ID；
- 访问策略、白名单、owner 识别和群聊身份边界；
- 主动投递默认关闭、失败可审计；
- 连接恢复、消息去重和平台适配测试。

关键区别：

- 它的 QQ 路径使用腾讯官方 QQ Bot SDK，不是个人 QQ + NapCat；
- 官方 Bot 的稳定性、账号模型和平台条款，不能直接迁移到 NapCat；
- 但它的渠道抽象、访问模式和主动投递 API 很值得参考。

#### `dsh-qq-bot`

证据：

- `lib/config.js`
- `lib/gateway/inbound-limits.js`
- `README.md`
- 51 个测试类文件

可借鉴点：

- 多适配器（OneBot 等）统一入口；
- `auth.owners` 为空时 fail-closed，不驱动任何会话；
- 白名单而不是黑名单；
- 限频、消息去重和自身回声过滤；
- 网关重连和发送失败处理；
- 有较完整的测试目录。

风险：

- 功能面广，配置复杂；
- OneBot 适配通过不等于个人 QQ 账号安全；
- 需要确认具体适配器与目标 NapCat 版本兼容。

#### `dsh-qq-access`

证据：

- `README.md`
- `docs/VALIDATION.md`
- `tests/smoke.test.mjs`

可借鉴点：

- 个人 QQ 通过 NapCat 的配置思路；
- 私聊/群聊白名单；
- 管理员与登录号分离；
- 事件签名、消息去重和发送幂等；
- 发送失败/结果不明确时不盲目重试；
- 托管进程的下载、校验、所有权和退出清理。

必须注意：

- README 明确写 Windows x64 托管模式；Linux/macOS/Windows ARM 走外部 NapCat 模式；
- `docs/VALIDATION.md` 声称 36 项核心测试，但实际快照只有 `tests/smoke.test.mjs` 一个测试文件，文件内只有 8 个 `test()`；
- 文档还明确写真实 Windows QQ 登录、真实 QQ 收发和空间操作**未执行**；
- 因此它只能作为设计参考，不能当作已验证的个人 QQ 方案。

#### `dsh-aurabot-qq`

证据：

- `README.md`
- `src/core/modules.js`
- `src/modules/API.md`
- 52 个测试类文件

可借鉴点：

- 功能模块化：配置、网关、聊天、人格、权限、面板和业务功能分开；
- 用户模块放在数据目录，升级不覆盖；
- 模块注册的工具、事件、定时任务可以随模块停止一起撤销；
- 聊天主流程保留“最终发送”挂钩，所有出站消息可以统一审查；
- 默认总开关关闭、试运行开启，先验证明再上线；
- 权限按会话和操作细分。

风险：

- 与 SnowLuma/Aurabot 人格和产品绑定很强；
- 功能非常多，直接采用会有大量不需要的依赖和行为；
- 其“模块系统”是优秀参考，但不等于我们的领域边界已经设计好。

#### `dsh-im-companion`

证据：

- `README.md`
- `package.json`
- `src/host/`
- `tools/verify/`

定位：

- 它不是 IM 接入本体，而是 `dsh-im` 的管理界面和增强层；
- 主要价值是“助理/家/渠道/在线状态”的管理模型；
- 没有传统的 `test/` 目录，但有约 40 个 verify 脚本；
- 不适合作为我们的核心或渠道实现。

### 4.7 浏览器

#### `dsh-browser`

证据：

- `README.en.md`
- `AUDIT.md`
- 98 个测试类文件

可借鉴点：

- Playwright 浏览器工具；
- 每个会话独立 browser context；
- `read-only / standard / autonomous / unrestricted` 自动化等级；
- 写操作审批、下载校验、域名登录态隔离；
- 使用策略、并发上限和 burst 限制；
- 页面内容作为不可信输入。

关键限制：

`AUDIT.md` 明确说明：

> `allowedDomains` 只是登录态选择/装载过滤，不是网络隔离，也不是 SSRF 沙箱。对不可信网页仍需要独立浏览器、独立账号以及 OS/代理层网络控制。

适合做法：

- 借鉴其工具接口和审批层级；
- 我们的浏览器执行放在独立 worker/VM，设置真实网络出口策略；
- 第一版禁止页面触发的 shell、下载执行和宿主文件访问。

## 5. 对本项目的取舍

### 5.1 可以直接借鉴

- 主动联系：`dsh-proactive` 的调度器状态机、安静时段、抖动、预算、崩溃恢复；
- 表达闸门：`dsh-heartbeat` 的纯决策核心和可审计拒绝原因；
- 状态：`dsh-mate-companion` 的维度划分和 `dsh-identity` 的衰减规则；
- 生活事件：`dsh-simulated-life` 的事件协议；
- 记忆：`dsh-dream` 的候选经验、来源核验、人工采纳和复习；
- 检索：`dsh-engram` 的证据引用和来源审计，后续再引入向量；
- 进化：`dsh-soul` 的候选/基线对比、shadow、自动回滚；
- 渠道路由：`dsh-im` 的适配器抽象和主动投递 API；
- 个人 QQ 风险控制：`dsh-qq-bot`、`dsh-qq-access` 的白名单、去重、限频和 fail-closed；
- 出站收口：`dsh-aurabot-qq` 的统一 send hook；
- 浏览器：`dsh-browser` 的工具层级、审批和隔离警告。

### 5.2 只作为概念参考

- `DSH-AGINT` 的 D-QAF / HARM 命名和阶段划分：概念完整，但实现过重；
- `dsh-fish-soul` 的虚拟时钟和 outbox：思路好，但单体太大；
- `dsh-im-companion` 的“家/渠道/在线状态”管理界面：只适合后续 UI 参考。

### 5.3 明确不直接采用

- 不把任何候选插件作为生产底座；
- 不直接复制没有根目录 `LICENSE` 文件的代码；
- 不把 README 声称的测试数、跨平台能力或安全隔离当作事实；
- 不把 Git worktree、`allowedDomains` 或宿主插件进程当成 VM；
- 不把个人 QQ/NapCat 当成官方稳定 QQ Bot 通道。

## 6. 工程建议

如果要把调研结论落到实现，建议按以下顺序：

1. 先写本项目的 `StateEvent` / `StateSnapshot` / `Policy` schema 和纯 reducer，不先接任何第三方插件。
2. 用 `dsh-proactive` 的调度概念实现自己的 initiative scheduler，但把“是否值得开口”做成独立策略。
3. 用 `dsh-dream` 的候选/证据模式实现第一版记忆，不直接引入其全部工具和 UI。
4. 用 `dsh-im` 的 adapter 概念实现网页和 QQ 统一出站接口；QQ 先做外部 NapCat adapter。
5. 用 `dsh-browser` 的工具层级实现只读浏览器 worker；第一版不做页面驱动的宿主 shell。
6. 用 `dsh-soul` 的候选/基线/shadow 概念实现进化，但代码隔离必须使用独立 VM/容器。
7. 给每个模块建立接口契约、schema 版本和测试；第三方仓库只作为设计证据。

## 7. 未完成的安全工作

本次没有进行：

- npm 依赖供应链审计；
- 许可证全文逐项核验；
- 第三方代码漏洞扫描；
- 真实 QQ、浏览器、DSH 宿主上的运行验证；
- 对恶意网页、提示注入和插件提权的对抗测试；
- 个人 QQ 账号风控和平台条款的法律评估。

在进入生产前，这些工作必须补齐。尤其是 QQ、浏览器和自进化代码三条路径，不能用“插件目录里有”或“README 说支持”代替验收。

## 8. 参考链接

- [dsh-proactive](https://github.com/john-walks-slow/dsh-proactive)
- [dsh-heartbeat](https://github.com/Kanadego/dsh-heartbeat)
- [dsh-soul](https://github.com/icyaaaww/dsh-soul)
- [dsh-identity](https://github.com/Anarrogantcat/dsh-identity)
- [dsh-mate-companion](https://github.com/m-rui001/dsh-mate-companion)
- [dsh-mind](https://github.com/wld12314/dsh-mind)
- [dsh-simulated-life](https://github.com/john-walks-slow/dsh-simulated-life)
- [dsh-browser](https://github.com/anweat/dsh-browser)
- [dsh-qq-bot](https://github.com/arrow1031-dev/dsh-qq-bot)
- [dsh-qq-access](https://github.com/Applepinea/dsh-qq-access)
- [dsh-aurabot-qq](https://github.com/aureth-labs/dsh-aurabot-qq)
- [dsh-engram](https://github.com/kenz1117/dsh-engram)
- [dsh-dream](https://github.com/STARDUSTLC666/dsh-dream)
- [dsh-fish-soul](https://github.com/Britneycode/dsh-fish-soul)
- [DSH-AGINT](https://github.com/Anmulzhao/DSH-AGINT)
- [dsh-im](https://github.com/xmanrui/dsh-im)
- [dsh-im-companion](https://github.com/FeatherHunter/dsh-im-companion)
