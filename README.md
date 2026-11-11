# Rinkobot

一个自托管、具有连续记忆和主动性的陪伴型机器人。她既是家人，也是恋人，
同时可以承担日常小事。项目重点是长期关系的连续性、可恢复性和可审计性，
不是给通用任务代理套一层人格。

> 当前状态：R1.5 独立化完成，版本 `0.21.0`，SQLite schema v12，MIT 许可证。
> 主分支已经是独立程序，不再导出 DSH 插件，也不依赖 DSH 提供模型或登录。
> R1 的单进程所有权、健康检查、备份恢复和 Linux 部署材料保留。自动测试在
> Windows 上通过；Windows 自动验收和 mock QQ 回环已覆盖，真实 QQ 完整矩阵、
> 真实第三方模型选型、Linux `systemd` 实机和一到两周日常观察仍未验收。
>
> 命名口径：对外品牌统一为 Rinkobot，systemd 示例使用 `rinkobot` 服务名；
> `/kanobot/`、`kanobot.sqlite`、`kanobot.lock`、`KANOBOT_*`、内部
> `Kanobot*` 类名和备份文件名暂作为兼容标识保留，避免现有数据、配置和
> 运行实例失联。

## 能做什么

- 网页聊天、流式回复、所有者会话和跨渠道只读档案；
- 版本化状态、纯 reducer、事件日志和确定性快照；
- 长期记忆、候选转正、相关性召回、回收站和彻底清除；
- 提醒、主动消息、安静时段、outbox 和防刷屏熔断；
- 个人 QQ + NapCat/OneBot 11，支持白名单、群 `@`、连发聚合、多图和去重；
- 独立视觉模型、统一审计、紧急停止和回复风格检查；
- 本地或第三方模型接入，支持 `mock`、Magpie 和 OpenAI-compatible；
- 数据目录单进程锁、健康检查、备份恢复和 Linux `systemd` 示例。

人格使用私有配置，正式设定不进入 Git。仓库和测试只使用占位身份。

## 快速开始

要求 Node.js 24 或更新版本。

Windows PowerShell：

```powershell
npm ci
Copy-Item -Recurse config/examples config/local
npm run app -- --config config/local --data data
```

Linux：

```bash
npm ci
cp -R config/examples config/local
npm run app -- --config config/local --data data
```

默认只监听 `127.0.0.1:4200`，可用 `--port` 修改。启动后终端会打印一次性
登录地址；打开后换取短期 HttpOnly Cookie。非交互式常驻服务不会把登录链接
写入 journal，可在管理员终端执行：

```bash
npm run login -- --data data
```

只用于本地开发的入口：

```bash
npm run dev
```

开发入口默认使用 `config/examples`、`tmp/dev-data` 和 mock 模型，只监听回环。

## 模型接入

设置页分别管理聊天模型和视觉模型：

| provider | 用途 | 边界 |
| --- | --- | --- |
| `mock` | 测试和离线开发 | 不联网 |
| `magpie` | 本机 Magpie | 只允许回环 `/v1` |
| `openai-compatible` | 第三方或自建兼容 API | 默认 HTTPS 和公开地址；私网需显式允许 |

设置页可以只读获取模型列表并点选模型。发现结果不等于能力认证；视觉模型
仍必须在保存前通过真实图片能力检查。缺少凭据、模型或必要能力时启动失败，
不会自动降级到 mock 或另一个模型。

密钥可以使用环境变量或配置目录下的本地 AES-256-GCM secret store。页面、
日志、审计、快照和数据库不保存明文密钥。本地 secret store 不是系统凭据
管理器，不能抵御已经取得同一操作系统账号文件访问权的攻击者。

## 个人 QQ / NapCat

QQ 默认关闭，使用外部 NapCat 提供的 OneBot 11 WebSocket。配置入口在网页
“设置 → QQ 渠道”，也可以手写 `channels.toml`。设置页保存到
`channel-settings.json`，整体覆盖 `qq` 段；保存后需要重启才生效。

主要安全边界：

- `owner_qq` 必须显式配置，并同时出现在 `private_allow`；
- 只有所有者 QQ 私聊并入网页 `main`，其他私聊和群聊独立存储；
- 空白名单不会变成“允许所有人”；
- 远程 WebSocket 必须使用 `wss://`，并显式允许远程地址；
- 群聊默认必须 `@` 机器人；
- token 不写入 TOML、SQLite、审计、日志或仓库。

个人 QQ + NapCat 存在平台风控和账号受限风险。本项目的白名单、限频、去重、
重连和 STOP 只能降低工程风险，不能提供平台合规或账号安全保证。

## 运维

健康检查：

```bash
curl --fail http://127.0.0.1:4200/kanobot/api/health
```

备份：

```bash
npm run backup -- --config config/local --data data list
npm run backup -- --config config/local --data data create
npm run backup -- --config config/local --data data restore --backup <备份文件>
```

恢复前必须停止服务并取得同一数据目录锁。主库备份不包含独立的
`tombstones.sqlite`；迁移或恢复时要把主库、墓碑库和备份目录作为一个整体
保留。损坏、校验失败或 schema 不匹配的备份会 fail-closed，原库保留。

Linux 常驻请使用非 root 用户和 `systemd` 或等价进程监管，只监听回环或经过
鉴权的入口，并配置日志轮转、数据权限、备份和崩溃重启。示例见
[R1 Linux 部署](docs/r1-deployment.md)。

## 安全边界

- 当前面向单一可信所有者的本地或受控部署，不是多租户公网服务。
- 网页、聊天、文件和未来的工具结果都是不可信输入。
- 不把 VM、浏览器 worker、worktree 或外部执行器描述成绝对安全沙箱。
- 不伪造模型调用、平台验收、测试结果或“已完成”状态。
- 漏洞和凭据泄露的报送方式见 [SECURITY.md](SECURITY.md)。

## 文档

1. [规划书](docs/plan.md)：当前执行计划、决策和 R 系列里程碑。
2. [需求定义](docs/need.md)：关系、记忆、主动性和自进化的产品需求。
3. [R0 决策](docs/r0-decision.md)：独立核心 + 可选执行器。
4. [R1 验收](docs/r1-acceptance.md)：锁、健康检查、备份和崩溃恢复。
5. [R1.5 解耦记录](docs/r1.5-decoupling.md)：DSH 插件/provider 删除和迁移契约。
6. [R1 Linux 部署](docs/r1-deployment.md)：`systemd` 示例和操作步骤。
7. [文件结构](structure.md)：目录、模块和文件放置规则。
8. [工程规范](AGENTS.md)：agent 和贡献者的操作边界。
9. [第三方源码调研](docs/plugin-research.md)：可借鉴机制和限制。
10. [记忆调研](docs/memory-research.md)：记忆插件研究，不是运行依赖。
11. [外部审查简报](docs/review-brief.md)：审查跑偏、架构和发布阻塞项。

旧的 M1～M5.2.1 验收文档仍在 `docs/`，只作历史证据，不是当前安装或架构
说明；其中的 Kanobot 是当时的旧名，不代表当前品牌口径。R1.5 删除的完整
DSH 插件代码可通过 Git 标签
`archive/dsh-plugin-0.20.0` 恢复。

## 测试

```bash
npm test
npm run check:case
npm run config:check
npm pack --dry-run
```

CI 在 Windows 和 Ubuntu、Node 24 上运行同一组检查。自动测试不读取真实人格，
不调用真实模型，不连接真实 NapCat/QQ，也不操作正式数据库。

## 许可证

本项目使用 [MIT License](LICENSE)。许可证以后可以更换，但已经按 MIT 发布的
版本不能撤回；如果已经有外部贡献者，通常还需要取得他们的同意。当前没有
发布到 npm，仓库包仍是 `private: true`。
