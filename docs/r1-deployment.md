# R1 Linux 常驻部署

> 状态：部署手册和示例已编写；**尚未在真实 Linux 主机上执行 systemd
> 验收**。Windows 上的自动测试不能替代 Linux 实机结果。本文不记录
> 真实 QQ 号、token、API key、SSH 私钥或人格文件。

## 1. 目标与边界

Kanobot Core 是唯一业务进程，拥有网页、QQ、记忆、提醒、主动消息、
Scheduler 和主数据库。DSH 不是启动前置条件，systemd 只监管核心进程。

- 只监听 `127.0.0.1:4200`；默认不暴露公网。
- 以非 root 用户 `kanobot` 运行。
- 配置和数据默认放在 `/var/lib/kanobot`，权限 `0700`。
- 凭据只通过 `EnvironmentFile` 或本地 secret store 提供。
- `kanobot.lock` 是运行时元数据；真正的互斥由操作系统命名管道/
  抽象套接字承担，SIGKILL 后由内核释放。
- Windows 开机自启仍暂缓，本文不覆盖。

## 2. 目录与用户

```bash
sudo useradd --system --home-dir /var/lib/kanobot --shell /usr/sbin/nologin kanobot
sudo install -d -m 0700 -o kanobot -g kanobot /var/lib/kanobot
sudo install -d -m 0700 -o kanobot -g kanobot /var/lib/kanobot/config
sudo install -d -m 0700 -o kanobot -g kanobot /var/lib/kanobot/data
sudo install -d -m 0700 -o root -g root /etc/kanobot
sudo install -m 0600 -o root -g root /dev/null /etc/kanobot/kanobot.env
```

建议布局：

```text
/opt/kanobot/a/                 代码（root 拥有，普通用户只读）
/var/lib/kanobot/config/        system.toml、identity.toml 等配置和设置覆盖
/var/lib/kanobot/data/          kanobot.sqlite、tombstones.sqlite、backups/
/var/lib/kanobot/data/kanobot.lock  运行时锁元数据（不提交 Git）
/etc/kanobot/kanobot.env        EnvironmentFile（0600，不进入 Git）
```

如果配置目录与数据目录分开，必须同时修改 unit 的 `ExecStart` 和
`ReadWritePaths`；配置目录中的 `model-settings.json`、`channel-settings.json`
和 `secrets/` 也需要写入权限。R1 默认把两者都放在 `/var/lib/kanobot`。

安装依赖并准备代码：

```bash
sudo install -d -m 0755 -o root -g root /opt/kanobot
sudo cp -a /path/to/kanobot/a /opt/kanobot/a
cd /opt/kanobot/a
sudo npm ci --omit=dev
```

Node.js 需要 24 或更高版本。示例 unit 假设 Node 在 `/usr/bin/node`；
用 `command -v node` 确认实际路径后再写入 unit。

## 3. 凭据与 EnvironmentFile

`/etc/kanobot/kanobot.env` 只放环境变量形式的凭据，例如：

```text
# 仅示例名称；值由操作员在服务器上填写，不提交仓库。
NAPCAT_ACCESS_TOKEN=replace-with-local-secret
```

```bash
sudo chmod 0600 /etc/kanobot/kanobot.env
sudo chown root:root /etc/kanobot/kanobot.env
```

不要写入或提交：

- SSH 私钥、服务器密码；
- QQ 账号密码、NapCat token；
- 模型 API key；
- Cookie、一次性登录 token；
- 真实人格文件、聊天正文、QQ 号或群号。

优先使用设置页写出的本地 secret store；它位于
`/var/lib/kanobot/config/secrets/`，权限随数据目录。`EnvironmentFile`
适合容器化或运维集中注入；两种来源互斥，不要同时配置同一个 token。

## 4. 安装与启动

```bash
sudo cp deploy/kanobot.service.example /etc/systemd/system/kanobot.service
sudo editor /etc/systemd/system/kanobot.service
sudo systemctl daemon-reload
sudo systemctl enable --now kanobot
sudo systemctl status kanobot --no-pager
```

查看启动报告：

```bash
sudo journalctl -u kanobot -n 100 --no-pager
```

启动报告应包含 `pid`、`version`、`schema`、`lockOwner` 短指纹、
`backups`、`dailyBackup`、`scheduler` 和 `qq` 状态；完整 owner token
只保存在权限受限的锁文件中，不进入 journal。报告不应包含 token、
Cookie、聊天正文或完整私密配置。

### 首次登录（systemd）

非 TTY 的 stdout 会进入 journal，因此核心不会把一次性登录链接写进
journal。使用本地控制通道把链接打印到操作员终端：

```bash
sudo -u kanobot -H /usr/bin/node /opt/kanobot/a/scripts/login-url.ts \
  --data /var/lib/kanobot/data
```

或在代码目录中：

```bash
sudo -u kanobot -H npm run login -- --data /var/lib/kanobot/data
```

链接只输出到当前终端，使用一次即失效。不要把它粘贴到聊天、工单、
截图、shell 历史或仓库。需要再次登录时重新执行上面的命令。

### 健康检查

```bash
curl --fail --silent --show-error \
  http://127.0.0.1:4200/kanobot/api/health
```

正常结果为 HTTP 200，字段只有：

```json
{"ok":true,"status":"ready","uptime":123,"version":"0.20.0","database":"ok","scheduler":"running","qq":"disabled"}
```

数据库不可用、scheduler 未运行或正在关闭时返回 HTTP 503 和
`ok:false`。健康检查要求精确的 `Host: 127.0.0.1:4200`，跨源请求被
拒绝；它不是公网探测入口。远程查看请使用 SSH 隧道，不要直接开放端口。

## 5. 停止、重启与日志

```bash
sudo systemctl stop kanobot
sudo systemctl status kanobot --no-pager
sudo systemctl restart kanobot
sudo journalctl -u kanobot -f
```

`systemctl stop` 发送 `SIGTERM`，核心按以下顺序关闭：

1. 停止接收新 HTTP 请求；
2. 停止唯一 scheduler；
3. 停止 QQ 渠道；
4. 关闭 HTTP 和数据库；
5. 释放数据目录锁。

`TimeoutStopSec=30s` 后 systemd 会强制终止。第二个 `SIGTERM` 也会让
进程记录明确日志并立即退出；残留的锁元数据会在下次启动时通过 IPC
所有权自动恢复。

日志使用 journald，不写应用日志文件。建议在
`/etc/systemd/journald.conf` 设置保留上限，例如：

```ini
SystemMaxUse=500M
SystemMaxFileSize=50M
```

修改后 `sudo systemctl restart systemd-journald`。也可定期执行
`journalctl --vacuum-time=14d`。不要用 shell 重定向把核心 stdout 写入
仓库或数据目录。

## 6. 备份、恢复、升级与回滚

### 备份

在线创建主库一致性备份（只读 `VACUUM INTO`，不会启动第二个核心）：

```bash
cd /opt/kanobot/a
sudo -u kanobot -H npm run backup -- \
  --config /var/lib/kanobot/config \
  --data /var/lib/kanobot/data create
sudo -u kanobot -H npm run backup -- \
  --config /var/lib/kanobot/config \
  --data /var/lib/kanobot/data list
```

主库日备份只包含 `kanobot.sqlite`，**不包含** `tombstones.sqlite`。
迁移整机或做灾难恢复时，应另存整个 `/var/lib/kanobot/data`，包括
独立墓碑库和 `backups/`。

### 恢复

恢复前必须先停服务。restore 会尝试取得同一个数据目录 IPC 锁；存活
实例存在时直接失败：

```bash
sudo systemctl stop kanobot
cd /opt/kanobot/a
sudo -u kanobot -H npm run backup -- \
  --config /var/lib/kanobot/config \
  --data /var/lib/kanobot/data \
  restore --backup kanobot-backup-20261111T000000000Z-abcdef12.sqlite
sudo systemctl start kanobot
curl --fail http://127.0.0.1:4200/kanobot/api/health
```

restore 只替换主库，不覆盖 `tombstones.sqlite`；下次启动会重放墓碑，
恢复出来的旧删除内容不会复活。损坏、quick_check 失败或 schema 与当前
版本不一致的备份会 fail-closed，原主库保留，失败副本留在数据目录供
排查。不要为了“先恢复再说”手动删除墓碑库。

### 升级

```bash
sudo systemctl stop kanobot
sudo -u kanobot -H npm run backup -- \
  --config /var/lib/kanobot/config \
  --data /var/lib/kanobot/data create
sudo cp -a /path/to/new/a/. /opt/kanobot/a/
cd /opt/kanobot/a
sudo npm ci --omit=dev
sudo -u kanobot -H npm run config:check
sudo systemctl start kanobot
sudo journalctl -u kanobot -n 80 --no-pager
curl --fail http://127.0.0.1:4200/kanobot/api/health
```

如果启动报告的 schema 或健康检查失败，立即停止服务并按上面的恢复
步骤回滚到升级前备份。不要自动删除主库、墓碑库或 `kanobot.lock`。

### 回滚

```bash
sudo systemctl stop kanobot
cd /opt/kanobot/a
sudo -u kanobot -H npm run backup -- \
  --config /var/lib/kanobot/config \
  --data /var/lib/kanobot/data list
sudo -u kanobot -H npm run backup -- \
  --config /var/lib/kanobot/config \
  --data /var/lib/kanobot/data restore --backup <回滚备份文件名>
sudo systemctl start kanobot
```

## 7. 故障排查

- `数据目录已被另一个 Kanobot 实例占用`：先确认旧进程是否仍在运行。
  不要用 `rm kanobot.lock` 掩盖问题；IPC 所有者才是权威。
- `LOCK_INVALID`：锁元数据损坏或来自不支持的版本。停止服务后人工
  检查 `kanobot.lock`，确认没有活进程再处理。
- `LOCK_FOREIGN_HOST`：数据目录来自另一台主机或共享文件系统。R1 不
  支持跨主机共享同一个数据目录。
- 健康检查 503：查看 journal 中的数据库/scheduler 错误；不要只重启
  掩盖数据库损坏或 schema 不兼容。
- restore 被拒绝：先 `systemctl stop kanobot`，确认
  `systemctl status kanobot` 不再是 active，再执行 restore。

## 8. 未验证项

- 本文未在真实 Linux 发行版上执行 `systemctl daemon-reload`、
  `enable`、`start`、`stop` 或 journald 轮转；
- Linux 抽象 Unix 套接字锁只由代码路径和文档覆盖，当前实机验收在
  Windows 命名管道上完成；
- 未验证不同发行版的 Node 路径、SELinux/AppArmor 策略和 NapCat
  进程编排；
- 未连接真实 QQ 或生产数据。

这些项目必须在实际 Linux 服务器上按本文逐项执行后，才能把“Linux
常驻”写成已验收。
