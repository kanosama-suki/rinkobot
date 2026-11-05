/**
 * 配置模块的公开入口。
 *
 * 其他模块只从这里导入，避免把 TOML 解析、字段校验等内部实现变成公共 API。
 */

export { ConfigError, ConfigFieldError, formatConfigIssues } from './errors.ts'
export type { ConfigIssue } from './errors.ts'
export { loadConfigFromDirectory } from './loader.ts'
export type {
  Environment,
  IdentityConfig,
  IdentityMode,
  LifeStateConfig,
  LoadedConfig,
  MemoryConfig,
  PolicyConfig,
  SystemConfig,
  VisionConfig,
} from './types.ts'
export { CONFIG_SCHEMA_VERSION } from './types.ts'
