# R1 独立核心服务与常驻部署硬化验收

> 日期：2026-11-11
> 分支：`r1/standalone-core`
> 代码基线：`b4f6b6e`（R0 文档冻结，M5.2.1 代码基线 `973cd5d`）
> 产品版本：`0.20.0`；SQLite schema：v12（未修改）
> 结论：**Windows 自动验收通过；R1 的服务硬化代码和部署材料已完成。
> Linux systemd、真实 NapCat/QQ、真实模型和正式数据仍未实机验收。**
>
> R1.5 补充（2026-11-11）：产品升到 `0.21.0` 并删除 DSH 插件/provider/UI；
> 本页记录的 R1 服务能力、schema v12 和未验证边界继续有效，历史测试数量
> 不代表 R1.5 的最终测试数量。

## 1. 验收环境

| 项目 | 实际值 |
| --- | --- |
| 操作系统 | Windows 10（10.0.19045） |
| Node.js | v24.19.0 |
| npm | 11.17.0 |
| 运行方式 | `node --test`、临时配置目录、临时数据目录、本机回环服务和 mock provider |
| 真实凭据 | 未读取、未连接 |
| 正式实例 | 未操作 |

测试只使用虚构消息、`127.0.0.1`、临时 SQLite 和 mock OneBot WebSocket；
没有连接真实 DSH、NapCat、QQ、Magpie、第三方模型或生产数据库。

## 2. 实现与证据

| 项目 | 实现 | 自动证据 |
| --- | --- | --- |
| 单进程所有权 | 数据目录 OS IPC 锁 + `kanobot.lock` 只读元数据；锁先于 SQLite、scheduler、QQ 获取 | `runtime-lock.test.ts`、`app-lifecycle.test.ts` |
| 第二实例拒绝 | 库入口拒绝；真实 `scripts/app-server.ts` 子进程非零退出 | `app-lifecycle.test.ts` |
| 强杀与 stale lock | SIGKILL 后 IPC 自动释放，旧元数据被新 owner 安全替换；PID 复用不参与所有权判断 | `runtime-lock.test.ts`、`app-lifecycle.test.ts` |
| 优雅关闭 | SIGINT/SIGTERM 停止接新请求 → scheduler → QQ → HTTP → DB → 释放锁；`close()` 可重入 | `app-lifecycle.test.ts` |
| 健康检查 | `GET /kanobot/api/health`，未登录回环可读，只含最小字段；HTTP 200；测试内注入 DB/scheduler 故障时为 HTTP 503 | `app-health.test.ts` |
| 健康检查边界 | Host/Origin 校验先于路由；非 GET 405；无 Cookie、路径、模型名、token 或正文 | `app-health.test.ts` |
| 启动报告 | pid、版本、schema、锁 owner 短指纹、备份数/当日备份、scheduler、QQ | `app-health.test.ts` |
| 备份 CLI | `list/create/restore`；online create 使用现有 `VACUUM INTO` | `backup-cli.test.ts` |
| 恢复互斥 | restore 先取得同一数据目录 IPC 锁，活实例存在时拒绝 | `backup-cli.test.ts` |
| 恢复失败保护 | 损坏或旧 schema 备份 fail-closed；原主库保留，损坏/失败副本保留 | `backup-cli.test.ts`、`backup-restore.test.ts` |
| 墓碑独立 | restore 只替换主库及 WAL/SHM，不覆盖 `tombstones.sqlite`；下次启动重放墓碑 | `backup-cli.test.ts`、`backup-restore.test.ts` |
| outbox 强杀恢复 | 陈旧外部发送进入 `unknown` 终态，不再由 scheduler 认领；本地网页目标可安全重试 | `outbox-crash-recovery.test.ts` |
| 单调度循环 | 唯一 scheduler timer；`start()` 幂等，`dispose()` 后报告 stopped | `scheduler-singleton.test.ts` |
| DSH 缺席 | mock 聊天、记忆、提醒、主动消息、scheduler 和 mock QQ 入站/回复均工作 | `standalone-core.test.ts` |
| 登录链接 | TTY 直接打印；非 TTY 不进入 stdout/journal；`npm run login` 通过本地 owner token 重新签发 | `app-health.test.ts`、`runtime-lock.test.ts` |

## 3. 真实验收命令与结果

在 `F:\kanobot\a` 执行：

```powershell
npm test
```

结果：**342 项通过，0 失败，0 取消，0 跳过**（约 14 秒）。

```powershell
npm run check:case
```

结果：`import case check: ok (170 files, 524 relative imports)`。

```powershell
npm run config:check
```

结果：`config ok: development, magpie/dsdsdsds/deepseek-flash,
identity=placeholder, tools=0`。

```powershell
node --check src/web/assets/app.js
node --check scripts/app-server.ts
node --check scripts/backup.ts
node --check scripts/login-url.ts
git diff --check
```

结果：四个语法检查均以 exit code 0 结束；`git diff --check` 无输出、
exit code 0。

最接近改动的定向测试也分别通过：

```powershell
node --test tests/integration/app-health.test.ts `
  tests/integration/app-lifecycle.test.ts `
  tests/integration/runtime-lock.test.ts `
  tests/integration/backup-cli.test.ts `
  tests/integration/outbox-crash-recovery.test.ts `
  tests/integration/scheduler-singleton.test.ts `
  tests/integration/standalone-core.test.ts
```

结果：**17 项通过，0 失败**。

其中真实子进程场景包括：

- 第二个 `scripts/app-server.ts` 进程以 exit code 1 退出，stderr 包含
  “已被另一个 Rinkobot 实例占用”，第一个实例 health 仍为 200；
- SIGTERM 和 SIGINT 路径关闭后锁元数据消失，可立即重启；
- SIGKILL 后数据库可重新打开、锁 owner 更换、health 为 200；
- restore 在存活实例运行期间被拒绝，实例仍保持 health 200。

## 4. 已验证与未验证

### 已验证

- Windows 命名管道的 OS 级单进程所有权，以及 PID 复用不影响锁判断；
- 有效 stale lock 的恢复；损坏锁和跨主机锁 fail-closed；
- 第二实例库入口和真实 CLI 拒绝；
- 正常关闭、SIGKILL 恢复、锁释放和重启；
- health HTTP 200；测试内注入 `healthCheck` 失败和 scheduler 未启动时
  HTTP 503，并覆盖纯响应判定；Host/Origin、非 GET、最小字段和敏感信息
  不泄露；
- 启动报告不打印完整 owner token、配置/数据路径、模型名或登录 token；
- `list/create/restore`、运行中拒绝 restore、损坏/旧 schema 备份拒绝、
  原库保留、失败副本保留、墓碑库不被覆盖；
- 陈旧外部 outbox 不重复发送；
- scheduler 幂等；
- DSH 缺席时 mock 网页聊天、记忆、提醒、主动消息、scheduler 和 QQ
  回环收发工作。

### 未验证

- 当前主机是 Windows，无法把普通 `child.kill('SIGTERM'/'SIGINT')`
  当作 POSIX 优雅信号投递。自动测试在 Windows 使用与两个处理器相同的
  stdin 触发路径；POSIX `SIGTERM`/`SIGINT` 分支只做代码审查，未在
  Linux 实机执行。
- Linux systemd 的 `daemon-reload/enable/start/stop/restart`、journald、
  非 root 用户、`ProtectSystem`、`ProtectHome`、`ReadWritePaths` 和
  抽象 Unix 套接字锁均未在真实 Linux 主机执行。
- 未连接真实 NapCat 或 QQ，未验证真实协议差异、断线重连和平台风控。
- 未调用真实模型，未读取正式人格文件或正式配置。
- HTTP 503 使用测试内故障注入，没有制造真实数据库损坏或真实 scheduler
  崩溃；真实故障路径只做代码审查。
- 未操作正式实例，未在真实长期运行中观察内存、日志轮转和磁盘增长。
- 没有伪造 Linux 常驻验收；`docs/r1-deployment.md` 与示例 unit 是待执行
  的部署材料，不是实机通过记录。

## 5. 边界

- R1 不修改 schema，不新增第二个调度循环。
- R1 不恢复 DSH Session、`paused_native`、M6.7/M6.8 WIP 或旧 DSH-first
  主线。
- 不把 `kanobot.lock`、SQLite、日志、token、QQ 号或临时配置提交到 Git。
- 不以删除锁文件、自动重建数据库或静默重试掩盖真实错误。
- Windows 开机自启仍暂缓；R1 只提供 Linux systemd 示例和说明。
- 下一步进入 R2 前，应先安排真实 Linux 主机执行部署验收；这不阻塞
  R1 代码基线提交。
