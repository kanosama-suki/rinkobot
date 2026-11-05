# M3 收尾验收：本地开发入口、统一审计与风格重写

> 日期：2026-11-05
> 插件版本：`0.11.0`
> SQLite schema：v8
> 结论：规划书定义的 M3 三项剩余门禁已完成；M3 可以结束，下一步进入 M4。真实模型比较和主模型选型仍按 kano 的决定后置。

## 1. 不经过 DSH 的本地开发入口

入口：

```powershell
npm run dev
```

默认行为：

- 只监听 `127.0.0.1`，默认端口 `4101`。
- 默认使用 `config/examples`、`tmp/dev-data` 和明确标记的 mock 模型。
- 真实路由必须显式传 `--model-mode magpie`；仍只允许回环 Magpie `/v1`。
- 不改用正式数据目录，不操作 `4096` 正式实例。

鉴权边界：

- 启动终端打印一次性登录地址，token 默认 10 分钟过期，成功换取一次后立即作废。
- token 换取 HttpOnly、SameSite=Strict、Path=/kanobot 的短期会话 Cookie；默认 8 小时过期，地址栏随即重定向到不含 token 的 `/kanobot/`。
- 页面、静态资源、聊天、记忆、审计和控制 API 全部经过同一会话检查；未认证一律 401。
- 非预期 Host 和跨源 Origin 一律 403；不接受任意局域网监听地址。
- 会话和 bootstrap token 只存在开发进程内存中，重启即失效。

已验证：

- 真实回环 HTTP 上，未认证页面和 API 均为 401。
- 一次性地址返回 303，`Location` 不含 token，Cookie 带 HttpOnly 和 SameSite=Strict。
- 同一 bootstrap token 第二次使用返回 401。
- 正常 Cookie 下页面、聊天 SSE 和统一审计 API 可用。
- 错误 Origin 返回 403 且没有写入聊天消息。
- 会话过期后页面重新返回 401。
- 测试使用临时目录和 mock，不访问真实模型或正式数据库。

## 2. 跨聊天、记忆、模型的统一审计

`/kanobot/api/audit` 保留原 `events` 所有者字段，同时新增 `timeline`：

- `owner`：记忆新增、纠正、转正、回收站、恢复、彻底清除、紧急停止/恢复。
- `memory`：记忆 ID、类型、状态、来源、敏感级别和重要程度；不读取正文。
- `model`：purpose、provider、精确模型、状态、尝试次数、token、估算费用和错误代码；不含提示词或回复。
- `style`：最终违规代码、是否自动重写、初次违规代码；不含回复正文。
- `chat`：助手消息 ID、关联调用数、调用成功数和风格结论；不 JOIN `bodies`。

页面审计页签改为“统一审计”，可按全部、聊天、记忆、模型、风格或所有者筛选，并按时间倒序合并展示。API 的 `source` 参数只接受这六种值，其他值返回 400。

已验证：

- 混合数据下五种来源都进入同一条时间线，按 `occurredAt` 倒序。
- `limit` 和来源过滤生效。
- 序列化后的时间线不包含测试用户正文、助手正文或记忆正文。
- 未登录访问审计 API 仍返回 401，原有所有者审计字段保持兼容。

## 3. 风格检查失败自动重写一次

流程：

1. 第一版正文仍按原方式逐字流式显示。
2. 完整回复通过确定性风格检查时，直接保存。
3. 不通过且每日模型额度允许时，通过 SSE `retry` 事件通知页面清空临时气泡，再逐字显示第二版。
4. 最终只保存一条助手消息；第一版正文不进入 `bodies`、事件、快照或记忆。
5. 第二版仍不通过时照常发出第二版，并把最终违规代码写入检查记录。
6. 每日额度不足时不做额外调用，保留第一版并记录“额度不足，未自动重写”。

审计与计量：

- 被丢弃的第一版调用记录为 `failed`，错误代码 `style_retry_requested`，保留真实 token/费用。
- 第二版调用作为独立 `chat` 调用记录；`todayCallCount` 计入两次真实调用。
- 最终 `reply_style_checks` 增加 `retry_count` 与 `initial_violation_codes_json`；仍不保存回复正文。
- 重写提示只包含违规代码和说明，不回传第一版正文。
- schema v8 原地增加上述两列；v7 历史行默认迁移为“未重写、无初次违规”。

已验证：

- 第一版违规、第二版通过：SSE 出现一次 `retry`，最终回复通过，数据库只有一条助手消息。
- 两版都违规：第二版被保存，最终检查失败，初次和最终违规代码都可审计。
- 每日额度只够第一版：不重写、不丢第一版，检查记录说明额度原因。
- 第一版丢弃调用和最终调用都可在模型调用审计中看到。
- 无正文复制到风格检查表；v7 → v8 迁移保留旧检查记录。

## 4. 自动测试与预检

```text
npm test
171 tests, 171 passed, 0 failed

npm run check:case
import case check: ok (91 files, 261 relative imports)

npm run config:check
config ok: development, magpie/deepseek/deepseek-flash, identity=placeholder, tools=0
```

新增或扩展的测试覆盖：

- `tests/integration/dev-server.test.ts`
- `tests/integration/audit-timeline.test.ts`
- `tests/integration/style-check.test.ts`
- `tests/integration/storage-v8-migration.test.ts`
- 现有 M2/v2/v3/v6/v7 迁移、聊天 HTTP、控制 HTTP 和存储 fail-closed 回归

## 5. M3 验收对照

- 宿主适配层：DSH 正式入口和独立本地开发入口都存在。
- 网页：聊天、SSE、DSH 登录鉴权、记忆面板、控制面板和统一审计视图存在。
- 模型网关：文本和视觉模型独立、精确匹配、超时/重试/费用/熔断和调用审计存在。
- 对话主链路：单次 JSON 信封、逐字流式、记忆/appraisal/commitments 闭环和一次风格重写存在。
- 记忆：候选规则、中文检索、纠正、回收站和清除存在。
- 风格与场景：确定性检查、脚本化场景和重写审计存在。
- 未登录拒绝：DSH 和本地开发入口的页面/API 都 fail-closed。
- 重启恢复：既有 M2/M3 测试继续通过。

## 6. 未验证项与边界

- 自动测试仍不调用真实模型；本次风格重写和统一审计使用脚本化模型验证。既有 M3.1/M3.3/M3.5/M3.6/M3.7 的真实 4100 路由证据仍然有效。
- 本地开发入口完成真实 HTTP 自动化验收，但没有把浏览器人工点击过程作为门禁；页面和 API 使用与 DSH 相同的静态资源和路由。
- 统一审计只覆盖已有元数据；读取行为、失败的所有者操作和未来主动消息投递仍不是完整审计范围。
- 真实模型比较、主模型选型和正式视觉模型选型继续后置到整个项目完工后。
- `docs/astra/`、`docs/gemini/` 仍是未跟踪草稿，不是本阶段交付。
