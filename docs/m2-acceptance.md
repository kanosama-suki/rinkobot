# M2 验收记录

> 日期：2026-11-05
> 结论：M2 的事件、状态、SQLite 持久化、快照恢复、删除、墓碑和备份已完成本地验收。
> 边界：这是测试 Profile 与独立临时数据库的验收；不是网页聊天、检索、生产部署或物理介质擦除验收。

## 1. 环境与位置

| 项目 | 值 |
| --- | --- |
| 系统 | Windows 10 专业工作站版 22H2（10.0.19045） |
| Node | v24.19.0 |
| SQLite | 3.53.3，来自 Node 内置 `node:sqlite` |
| DSH | `0.2.1-rc.5` |
| 插件 | `@kanobot/dsh-plugin@0.2.0` |
| 源码 | `F:\kanobot\a` |
| 测试 Profile | `kanobot-test`，`127.0.0.1:4100` |
| 测试数据 | `F:\kanobot\dsh\test-home\kanobot\data` |
| 正式实例 | `127.0.0.1:4096`；未修改、未重启 |

测试数据目录包含：

- `kanobot.sqlite`：事件、快照、正文、记忆、outbox、墓碑投影和 schema 版本。
- `tombstones.sqlite`：独立墓碑库，不随主库备份回滚。
- `backups/kanobot-backup-*.sqlite`：当日主库一致性备份。

## 2. 已实现内容

### 2.1 数据契约与 reducer

- 实现了版本化的 `StateEvent`、`StateSnapshot`、`Appraisal`、`PolicyDecision`、`MemoryRecord` 和 `Tombstone`。
- 第一版状态包含 `activity`、`affect`、`energy`、`socialBattery`、`relationship`、`attention.busyUntil` 和 `commitments`。
- reducer 是纯函数，不读系统时间、网络或随机数；Tick 使用事件中的时间和作息标记。
- 数值夹紧到合法区间；单次关系变化受配置上限约束；非法来源、未知字段、重复承诺、越界时间和损坏事件都会拒绝。
- 事件和快照只保存正文 ID；`bodies` 表是普通存储中唯一保存原文的地方。

### 2.2 SQLite 与恢复

- 主库表：`events`、`snapshots`、`bodies`、`memories`、`tombstones`、`outbox`、`schema_migrations`。
- PRAGMA：`journal_mode=WAL`、`secure_delete=ON`、`foreign_keys=ON`、`synchronous=FULL`。
- 每 100 个事件或每小时先到者触发快照；测试可注入固定时钟。
- 启动时验证 SQLite header、`quick_check`、迁移版本和必需表/列，再从最近快照加后续事件恢复。
- 快照 JSON 使用稳定键排序；读取时校验规范字节、快照 ID、状态哈希和数据库冗余列。

### 2.3 删除与备份

- 记忆默认软删除进入回收站，保留 30 天，可按配置恢复。
- 彻底清除级联正文、记忆、outbox、承诺事件及其后续依赖事件；删除并重建快照。
- 墓碑只保存目标类型、目标 ID 和清除时间，写在独立 `tombstones.sqlite`。
- 打开主库前先应用墓碑；从旧主库备份恢复后同样先应用墓碑，再开放服务。
- 清除后执行 `VACUUM` 和 `wal_checkpoint(TRUNCATE)`，并再次运行 `quick_check`。
- 每天用 `VACUUM INTO` 生成主库备份，只读校验后保留最近 7 份。

### 2.4 插件接入

- 插件在注册定时器之前加载配置、打开主库和墓碑库。
- 数据库损坏、schema 不兼容、路径逃逸或日备份失败都会阻止插件激活。
- 卸载时先停止定时器，再关闭两个数据库。
- 新增 `scripts/preflight-runtime.ts`；测试启动脚本在创建 DSH 进程前分别做配置预检和数据库预检。

## 3. 五项验收

| # | 要求 | 结果与证据 |
| --- | --- | --- |
| 1 | 同一串事件回放两次，快照逐字节相同 | 通过：`tests/replay/snapshot-replay.test.ts` 用 130 个事件写入两个独立库，第 100 个事件自动快照、第 130 个事件强制快照；最终 JSON 的 UTF-8 Buffer 完全相等，重启后仍相等 |
| 2 | 强制杀进程后重启，状态与杀掉前一致 | 通过：`tests/integration/crash-recovery.test.ts` 启动真实写入子进程，提交事件和快照后由父进程 `SIGKILL`；重启后的状态规范 JSON、序号和快照字节一致 |
| 3 | 彻底清除后直接扫描数据库文件搜不到原文 | 通过：`tests/integration/purge.test.ts` 使用唯一正文，级联删除正文/记忆/outbox/承诺及其完成事件，关闭后扫描主库、墓碑库和 SQLite sidecar，未找到原始 UTF-8 字节 |
| 4 | 从旧备份恢复后，墓碑仍生效 | 通过：`tests/integration/backup-restore.test.ts` 先备份含正文的旧库，再彻底清除；恢复旧备份并重开后正文、记忆、outbox 和承诺状态均不复活，当前主库也搜不到原文 |
| 5 | 数据库损坏或 schema 不兼容时拒绝启动 | 通过：`tests/integration/storage-fail-closed.test.ts` 覆盖损坏 header、不兼容迁移版本、无本插件 schema 的 SQLite、损坏快照、损坏事件和主库/墓碑库只缺一个；原文件保留，不自动建空库 |

## 4. 回归与运行证据

### 4.1 自动测试

```powershell
cd F:\kanobot\a
npm test
npm run check:case
npm run config:check
```

结果：

- `npm test`：50 项通过，0 失败。
- `npm run check:case`：38 个文件、92 个相对导入通过。
- `npm run config:check`：示例配置加载成功。

M1 的 18 项测试仍在 50 项总回归中；插件 10 次 apply/dispose 生命周期测试通过。

### 4.2 生命周期

```powershell
npm run test:lifecycle -- --output F:\kanobot\dsh\m1-plugin-lifecycle.json
```

结果：`ok = true`，`cycles = 10`；加载前活动资源为 `[]`，第一轮包含 `Timeout`，10 轮卸载后仍为 `[]`。报告版本为 `0.2.0`。

### 4.3 真实测试 Profile

启动脚本先完成配置和存储预检，再启动 4100：

```text
config ok: development, deepseek-official/deepseek-flash, identity=placeholder, tools=0
storage ok: F:\kanobot\dsh\test-home\kanobot\data\kanobot.sqlite
tombstones ok: F:\kanobot\dsh\test-home\kanobot\data\tombstones.sqlite
DSH test profile is running (PID 36852).
```

启动报告 `F:\kanobot\dsh\m1-plugin-load.json` 记录插件版本 `0.2.0`、配置目录、数据目录、主库、墓碑库、备份目录、模型路由和占位身份。测试实例监听 `127.0.0.1:4100`，stderr 为空；正式 `4096` 实例保持原进程。

另用临时目录放入 1024 字节非 SQLite 文件后运行 `preflight-runtime.ts`，退出码为 1，输出 `invalid SQLite file header`；这证明测试启动脚本会在创建 DSH 进程前拒绝损坏数据库。

## 5. 已知边界

- M2 没有创建 FTS5 表，也没有实现检索；检索属于 M3。M3 建索引时必须同时启用并实测 FTS5 的 `secure-delete` 配置。
- 回收站、恢复、彻底清除和备份目前只有核心 API 与测试，没有所有者面板或聊天入口。
- 备份只包含主库；`tombstones.sqlite` 必须单独保留。旧备份中的正文会保留到该备份按 7 份策略过期；恢复时会由当前墓碑清理。
- 文件扫描证明的是当前主库、WAL/sidecar 和墓碑库不再包含测试正文；不证明 SSD 磨损均衡、文件系统快照、云备份或已经发送给模型服务商的数据被物理擦除。
- 每日备份由插件启动和心跳触发，不依赖 Windows 计划任务；电脑长期关机时不会产生新的每日备份。
- 崩溃测试杀死的是真实写入 Node 进程，不是 DSH 宿主进程；插件没有公开的 M2 状态写入入口，因此没有从 DSH UI 注入事件。
- 真实模型的 appraisal、记忆整理和对话主链路尚未实现。
- 所有测试只使用占位身份和虚构数据。

## 6. 复现命令

```powershell
cd F:\kanobot\a
npm test
npm run check:case
npm run config:check
node scripts/preflight-runtime.ts F:\kanobot\dsh\test-home\kanobot\config F:\kanobot\dsh\test-home\kanobot\data
npm run test:lifecycle -- --output F:\kanobot\dsh\m1-plugin-lifecycle.json
```
