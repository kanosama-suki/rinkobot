# M5 验收记录：个人 QQ + NapCat 渠道

> 结论：M5 的渠道代码、schema 迁移和自动测试完成，自动测试 278/278 通过。实现只经过本地 fake gateway 和本机回环 WebSocket 验证；**没有连接真实 NapCat，没有使用真实 QQ 账号，也没有完成平台风控、真实图片和真实重连验收**。

## 1. 范围与环境

- 仓库：`F:\kanobot\a`
- 基线：`ea803a5 feat: 完成 M4.6 记忆、模型发现与界面修复`
- 版本：`0.16.0`
- SQLite schema：v11
- Node：v24.19.0
- 测试对象：内存 fake OneBot gateway、本机 `127.0.0.1` 临时 WebSocket 服务
- 隐私边界：没有读取或提交正式人格、真实 QQ 凭据、token、Cookie、聊天正文或图片；测试内容全部是虚构占位数据
- 未操作：正式 `4096`、现有 `4100`、正式 NapCat、正式 QQ 账号

## 2. 实现结果

### 2.1 适配层边界

新增 `src/channels/`，QQ/OneBot 字段只存在于渠道层。`src/core/` 不导入 `ws`、OneBot 或 NapCat 类型，渠道只通过聊天、主动性、紧急停止和存储的公开接口进入核心。

- `types.ts`：与平台无关的 `InboundTurn`、图片引用和发送结果契约。
- `coalescer.ts`：只做时间窗口、文本/图片合并和上限检查。
- `qq/events.ts`：OneBot 11 消息事件、白名单、群 @ 和图片段解析。
- `qq/format.ts`：QQ 目标、outbox 目标、白名单检查和回复拆条。
- `qq/media.ts`：图片三级获取、CDN 白名单、魔数和字节限制。
- `qq/onebot.ts`：OneBot 11 WebSocket、Bearer 鉴权、动作请求、ping 和重连。
- `qq/channel.ts`：入站回合、核心调用、拆条发送、限频、STOP 和审计编排。

### 2.2 `channels.toml`

QQ 配置独立放在 `channels.toml`，示例见 `config/examples/channels.toml`。

- 配置文件缺失时使用默认配置，QQ 处于关闭状态；不会因为升级而自动连接外部账号。
- `[qq]` 保存开关、WebSocket 地址、远程连接许可、token 环境变量名、超时、重连、去重保留期、私聊/群白名单、群 @ 规则和 `autonomous_target`。
- `[qq.coalesce]` 默认静默窗口 2500 ms、最大等待 10000 ms、最多 4 张图、总图片 12 MiB。
- `[qq.images]` 保存图片下载超时；`[qq.outbound]` 保存拆条长度、最多条数和发送间隔；`[qq.limits]` 保存每分钟入站回合和出站分片上限。
- 本机回环地址可以使用 `ws://`。远程地址必须 `allow_remote = true`、使用 `wss://`，并通过 `access_token_env` 引用进程环境变量中的 token；配置里不保存真实 token。
- `autonomous_target` 必须出现在对应私聊或群白名单中；它是主动消息和提醒的目标，不是公开发送开关。

### 2.3 入站、去重与连发聚合

- 仅处理 `message` 事件中的私聊和白名单群；机器人自己的消息、白名单外私聊/群和非消息事件直接忽略。
- 群聊默认必须 @ 机器人。第一次被 @ 后，同一连发窗口内的后续碎片可以继续合并；窗口结束后再次发言仍需重新 @。
- 平台消息 ID 在进入聚合器前写入 `channel_inbound` 去重表，跨关闭/重开和断线重连仍有效。
- 聚合键是“平台会话 + 发送者”，群内不同成员不会合成同一轮。
- 默认 2.5 秒静默窗口、最多 10 秒最大等待；3 条文字 + 2 张图片只形成一个 `InboundTurn`。
- 超过文本、图片数量或总图片字节上限时拒绝整个逻辑回合，不把部分内容送入模型。
- 每个 QQ 会话使用独立 conversation ID，但共享同一人格、数据库、记忆和模型预算。

### 2.4 图片

- 单轮最多 4 张，单图上限沿用 `system.toml [vision].max_image_bytes`，总字节上限来自 `channels.toml`。
- 获取顺序：NapCat `get_image` 本机缓存路径 → `get_file` → `get_msg` 刷新 QQ CDN 地址。
- 不信任事件里的本地路径，只使用 NapCat 动作返回的绝对路径；读取前后都检查文件类型、大小和实际字节数。
- CDN 仅允许 QQ 图片域名后缀，拒绝 URL 内嵌凭据、非标准端口和非 HTTP(S) 地址；当前允许 `.qq.com`、`.qq.com.cn`、`.qpic.cn` 和 `.gtimg.cn`。
- 只接受 PNG、JPEG 和 WebP，并用魔数校验真实类型。
- 任意图片获取、大小、类型或下载失败都会拒绝整轮；不会调用聊天模型假装看懂，也不会静默丢图。
- 图片只在本轮内存中传给视觉模型，不写入正文、事件、快照、记忆、渠道审计或日志。
- 图片 HTTP 下载按实际流字节截断，不信任缺失或撒谎的 `content-length`；超过单图上限立即取消响应。

### 2.5 核心调用与共享预算

- 一个 QQ 逻辑回合只产生一次聊天回合和一个连贯回复。
- 多张图片分别调用独立视觉模型，最后由主聊天模型生成一次回复；视觉模型未配置时，带图回合在核心调用前拒绝。
- 新增 `ChatModelBudget`，网页和所有 QQ 私聊/群聊共享同一个并发槽与每日调用预留，不能通过增加会话绕过 `system.toml` 的资源上限。
- 多图轮次在开始任何模型调用前预留“图片数 + 1”次调用；失败时释放未消费预留。

### 2.6 出站、主动消息和 STOP

- 模型只生成一次回复；适配器按配置拆成最多 4 条，默认每片最多 1200 字、间隔 350 ms。
- 回复目标只能是当前白名单会话；`deliver` 也只接受配置声明的 `autonomous_target`。
- 入站回合和出站分片都有分钟级限流。
- 每次发送前重新检查紧急停止；如果在生成期间触发 `STOP`，已经生成的回复也不会发出。
- OneBot 返回有效 `message_id` 才记为成功。超时、连接中断或响应缺少 ID 时标记 `unknown`，不自动重发。
- 主动消息和提醒可发往 QQ；成功后同步写入网页 `main` 会话。没有配置 QQ 主动目标时继续只投递到网页。
- 群主动消息只允许白名单目标，不实现 QQ 空间、动态、评论或公开群发。

### 2.7 schema v11 与审计

- SQLite schema 从 v10 升到 v11。
- 新增 `channel_inbound`：只保存渠道、平台消息键、会话键、接收时间和过期时间，用于去重。
- 新增 `channel_audit`：只保存时间、渠道、方向、事件类型、结果、目标 ID 和错误码，不保存正文、图片、图片路径、昵称或 token。
- 渠道审计接入网页统一审计时间线，新增“渠道”来源和“结果未知”状态。
- v10 数据库原地迁移到 v11；新增 `storage-v11-migration` 测试，迁移后渠道去重和审计数据可跨重开读取。

### 2.8 生命周期

- 独立程序和 DSH 插件都只在 QQ 启用时创建渠道；启动顺序是网页表面、调度器、QQ。
- 关闭时先停止调度器，再关闭 QQ、WebSocket、聚合器和活动回合，最后关闭存储。
- WebSocket 事件处理有防御性边界；单条不可信事件或数据库异常不会击穿连接事件循环。

## 3. 自动测试证据

QQ 渠道集成测试 7/7 通过：

- `accepts only whitelisted QQ messages and merges a mentioned group burst`
- `coalesces three texts and two images into one core turn`
- `image resolution failure never calls the chat or vision model`
- `a duplicate message id survives closing and recreating the channel`
- `STOP prevents a reply that was already being generated from being sent`
- `a delivered QQ proactive outbox also appears in the web conversation`
- `an unknown QQ send result is never retried as a new message`

OneBot 客户端测试通过：

- `authenticates, sends with message_id, and reports unknown on a missing id`

其余定向覆盖包括：

- 私聊/群白名单、自我消息、群 @、CQ 字符串和消息段解析。
- 回复按 Unicode code point 拆条，超过条数上限时显式失败。
- QQ 图片 CDN 伪装域名拒绝、本地缓存实际字节复查。
- 图片下载流在超过上限时取消，不先缓存完整响应。
- 缺失 `channels.toml` 时 QQ 关闭、远程 WS 强制 `wss://`、主动目标必须属于白名单。
- 网页与 QQ 聊天服务共享并发预算。
- 渠道审计不包含消息正文、图片 base64 或本地图片路径。
- v10 → v11 迁移。

## 4. 验证命令

```powershell
npm test
npm run config:check
npm run check:case
node --check src/web/assets/app.js
git diff --check
```

结果：

- `npm test`：278 项通过，0 失败。
- `npm run config:check`：示例配置通过。
- `npm run check:case`、前端语法检查和 `git diff --check` 通过。

## 5. 本轮修复

- `ws` 成功发送时回调参数可能是 `null`；原判断只会接受 `undefined`，会把已发送动作误报为 `send_failed`。
- 远程 NapCat WebSocket 强制 `wss://`，避免 Bearer token 明文经过网络。
- QQ 图片 CDN 白名单补充 `.qq.com.cn`，覆盖 `multimedia.nt.qq.com.cn`。
- 本地图片 `stat` 与 `readFile` 之间可能变化，读取后再次按实际字节检查上限。
- 图片下载改为有界流式读取；缺失或错误的 `content-length` 不能绕过单图上限。
- QQ WebSocket 事件处理增加防御性捕获，单条异常不会击穿事件循环。
- 示例配置中 `autonomous_target` 原误放在 `[qq.limits]`，已移到 `[qq]`。
- 网页与每个 QQ 会话原先各自维护并发/每日预留，可能绕过资源上限；现在共享同一个 `ChatModelBudget`。

## 6. 未验证项与范围边界

- **没有连接真实 NapCat，没有登录真实 QQ 账号。**
- 没有验证目标 NapCat 的版本差异、真实事件格式、真实图片缓存路径、真实 CDN 地址、断线重连时序和平台限流表现。
- 没有用真实 QQ 做私聊、群 @、连发、多图、主动消息、提醒和 STOP 的端到端验收。
- 连接断开和重连会写入日志/渠道审计，并可在所有者审计页看到，但当前没有浏览器通知或外部推送告警。
- 用户已接受个人 QQ 的风控、限制和封号风险；工程上的白名单、限频、去重、STOP 和未知结果不重发不等于平台不会封号。
- 没有实现 QQ 语音、视频、表情包、文件、撤回、戳一戳或原生多模态直连；当前图片是“独立视觉模型逐张转述后再交给聊天模型”。
- 没有实现 QQ 空间、动态、评论、公开群发或其他公开发送路径。
- 没有引入 LLM 违禁词审查；渠道审计和隐私边界不等于平台内容合规审核。
- 没有提交或读取真实 QQ 号、群号、NapCat token、API key、Cookie 或正式人格文件。

实现时参考了 `dsh-napcat-bridge@0.3.2`（MIT）的连接鉴权、消息去重、图片本机缓存优先、发送结果未知不重发等思路；没有把它作为生产依赖，也没有复制其业务代码。

## 7. 真实账号验收清单

进入 M6 前，应使用隔离小号、独立 NapCat 和 Git 外 `channels.toml` 完成：

1. 私聊白名单接收，确认审计不保存正文。
2. 单条发送和回复拆条，确认收件人、内容和 `message_id`。
3. 2 秒内 3 条文字 + 2 张图片只产生一次聊天调用和一个逻辑回合。
4. 群白名单、默认 @ 和后续碎片聚合。
5. 停止 NapCat 后重连，确认不重复处理或重复发送。
6. 发送超时/缺 ID 时进入 `unknown`，重启后不自动补发。
7. `STOP` 阻断正在生成或正在拆条发送的 QQ 回复。
8. 主动消息和提醒送达 QQ，并在网页 `main` 会话同步出现。
9. 全程检查日志、数据库和审计中不含 token、图片或正文。

完成以上真实账号验收后，才能把 M5 标记为“真实环境完成”；当前只能标记为“代码与自动测试完成”。
