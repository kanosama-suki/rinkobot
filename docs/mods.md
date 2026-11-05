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
- 用途：解析 `system.toml`、`identity.toml` 和 `policy.toml`，不自行实现不完整的 TOML 解析器。
- 验证：`npm test` 中的配置加载测试覆盖合法配置、未知字段、类型错误、TOML 语法错误和跨文件错误。
- 回滚：删除 `package.json` 中的依赖，换回自研解析器或经审查的替代包，并重跑配置测试。该依赖不进入持久化格式。

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
