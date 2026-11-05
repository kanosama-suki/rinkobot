# M3.0 验收记录

> 日期：2026-11-05
> 结论：M3.0 网页聊天骨架已完成本地验收。
> 边界：这只是 M3 的第一个可验收切片；真实模型网关、长期记忆、FTS5、风格检查、场景测试和完整所有者面板仍未完成。
> 后续：M3.1 的 Magpie 模型网关和调用审计已完成，见 [m3.1-acceptance.md](m3.1-acceptance.md)。

## 1. 环境与位置

| 项目 | 值 |
| --- | --- |
| 系统 | Windows 10 专业工作站版 22H2（10.0.19045） |
| Node | v24.19.0 |
| DSH | `0.2.1-rc.5` |
| 插件 | `@kanobot/dsh-plugin@0.3.0` |
| 源码 | `F:\kanobot\a` |
| 测试 Profile | `kanobot-test`，`127.0.0.1:4100` |
| 测试数据 | `F:\kanobot\dsh\test-home\kanobot\data` |
| 正式实例 | `127.0.0.1:4096`；验收期间未修改、未重启 |

测试只使用占位人格和虚构消息，不读取 `F:\kanobot\private\rinko.md`，不调用真实模型 API。

## 2. 已实现内容

### 2.1 宿主与鉴权

- 插件声明 `webServer` 和 `connection` 宿主依赖，通过 `connection.admit()` 复用 DSH 已认证的浏览器 Cookie。
- 未登录访问页面或接口返回 401；DSH 判定为跨来源时返回 403。
- 没有在仓库、数据目录或页面中另建明文登录令牌。
- 页面响应带 CSP、`nosniff`、禁止 iframe 和 `no-referrer` 响应头。
- 卸载时先关闭活动 SSE、注销路由，再停止定时器并关闭数据库。

### 2.2 网页与 SSE

| 路径 | 作用 |
| --- | --- |
| `GET /kanobot/` | 聊天页和最小所有者状态面板 |
| `GET /kanobot/app.js` | 页面脚本 |
| `GET /kanobot/app.css` | 页面样式 |
| `GET /kanobot/api/conversation?limit=40` | 读取最近消息和运行状态 |
| `POST /kanobot/api/chat` | 发送 `{"text":"..."}` 并接收 SSE |

- 成功流的事件顺序为 `ready → delta* → done`；失败发送 `error`。
- 单条消息最多 4000 字符，历史最多读取 100 条，HTTP 请求体最多 64 KiB。
- 页面只用 `textContent` 渲染聊天正文，不把用户输入拼进 HTML。
- 所有者面板目前只展示模型、持久化状态、消息数和事件序号；还没有记忆、停止和审计操作。

### 2.3 模型与持久化

- M3.0 只接受 `modelMode=mock`；非法模式拒绝启动。
- `MockChatModel` 明确标记为 `[M3 mock]`，不访问网络、不读取人格文件，只回显用于验收的虚构文本。
- SQLite schema 从 v1 原地迁移到 v2，新增 `conversations`、`messages` 表；旧事件和正文保留。
- 聊天正文仍只写入 `bodies`，消息、事件和快照只保存 ID。
- 用户消息先持久化，模型完整返回后再保存助手消息；流失败不会留下半截助手消息。
- 一轮完整对话追加一个 `interaction.recorded` 事件，证据引用只包含用户和助手正文 ID。模型失败时保留用户消息，但不写助手消息或互动事件。
- 删除正文通过外键级联删除消息；对应事件在重放时由墓碑 ID 抑制。

## 3. 自动验证

```powershell
cd F:\kanobot\a
npm test
npm run check:case
npm run config:check
npm run test:lifecycle -- --output F:\kanobot\dsh\m1-plugin-lifecycle.json
node scripts/preflight-runtime.ts F:\kanobot\dsh\test-home\kanobot\config F:\kanobot\dsh\test-home\kanobot\data
```

结果：

- `npm test`：57 项通过，0 失败。
- `npm run check:case`：47 个文件、113 个相对导入通过。
- `npm run config:check`：示例配置加载成功。
- 生命周期：10 次加载/卸载通过，卸载后活动资源为 `[]`，版本 `0.3.0`。
- 运行时预检：主库和独立墓碑库通过。
- M2 → M3 schema 迁移、mock 流、失败不落半截回复、正文清除级联、HTTP 401 和重启恢复均有自动测试。

## 4. 真实测试实例

重启隔离的 4100 实例后：

- 未登录访问 `/kanobot/`：401。
- DSH 登录后页面：200，页面标识存在。
- 真实 SSE：`ready,delta,delta,delta,delta,done`。
- 发送前测试库有 2 条旧占位消息；发送一条虚构消息后为 4 条消息、`lastSequence=1`、`eventCount=1`。
- 再次重启后仍为 4 条消息、`lastSequence=1`、`eventCount=1`，stderr 为 0 字节。
- 验收时测试实例 PID 为 36580；正式 4096 实例 PID 10928 未被修改或重启。

## 5. 尚未完成与已知边界

- 完整 M3 仍未完成，不能把本记录当作网页聊天闭环、长期记忆或真实人格验收。
- 尚未接入 DeepSeek/Gemini、超时重试、费用记录、主备模型切换和真实 token 预算。
- 尚未实现 FTS5 双列检索、记忆写入/纠正、风格检查、第一批场景测试和完整面板操作。
- M3.0 的互动事件按“已完成的一轮”记录；完整主链路仍要把入站消息、appraisal、记忆候选和投递结果分别建模。
- 模型输出没有逐 token 的网络背压、断线续传和跨页面并发控制；刷新页面通过会话接口恢复，不恢复未完成的流。
- 复用 DSH 登录态依赖宿主公开的 `connection.admit()`；不经过 DSH 的本地开发入口和短期令牌尚未设计。
- 正文彻底清除目前只有核心 API 与测试，还没有页面删除入口。
- 真实实例验收验证的是本地回环地址、测试 Profile 和虚构数据，不是生产部署或公网暴露测试。
