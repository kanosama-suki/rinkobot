# 插件与改动记录

## 当前状态

- 当前没有直接安装或引入第三方 DSH 插件作为生产依赖。
- `docs/plugin-catalog.zh.md` 只是第三方索引；`docs/plugin-research.md` 是源码调研，不是依赖清单。
- 任何后续引入、替换或迁移，都必须记录版本、来源、许可证、用途、验证方式和回滚方案。

## 已记录依赖

### smol-toml

- 名称：`smol-toml`
- 版本：`1.9.1`
- 来源：npm，仓库 `github:squirrelchat/smol-toml`
- 许可证：BSD-3-Clause
- 用途：解析 `system.toml`、`identity.toml`、`life-state.toml`、`memory.toml` 和 `policy.toml`，不自行实现不完整的 TOML 解析器。
- 验证：`npm test` 中的配置加载测试覆盖合法配置、未知字段、类型错误、TOML 语法错误、存储路径和跨文件错误。
- 回滚：删除 `package.json` 中的依赖，换回自研解析器或经审查的替代包，并重跑配置测试。该依赖不进入持久化格式。

### Node 内置 SQLite

- 名称：`node:sqlite` / SQLite `3.53.3`
- 来源：Node v24.19.0 内置模块，不是 npm 第三方依赖
- 许可证：随 Node/SQLite 分发
- 用途：M2 主库、独立墓碑库、事务、快照、备份和完整性检查。
- 验证：50 项测试覆盖 WAL、FULL、`secure_delete`、`VACUUM INTO`、`quick_check`、强杀恢复、文件级清除和 fail-closed。
- 回滚：数据层通过公开接口隔离；若未来必须换驱动，保持表结构和规范 JSON 不变，先做导出/导入与全量回放测试。不要在同一迁移里同时替换 DSH、Node 和数据库版本。

## 记录模板

```text
名称：
版本/commit：
来源：
许可证：
用途：
验证：
回滚：
```
