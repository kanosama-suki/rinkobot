/**
 * 配置模块的公开入口。
 *
 * 其他模块只从这里导入，避免把 TOML 解析、字段校验等内部实现变成公共 API。
 */

export { ConfigError, ConfigFieldError, formatConfigIssues } from './errors.ts'
export type { ConfigIssue } from './errors.ts'
export {
  loadConfigFromDirectory,
  validateChannels,
  validateModelBaseUrl,
} from './loader.ts'
export type {
  ChatProvider,
  ChannelsConfig,
  Environment,
  IdentityConfig,
  IdentityMode,
  InitiativeConfig,
  LifeStateConfig,
  LoadedConfig,
  MemoryConfig,
  PolicyConfig,
  QqChannelConfig,
  QqTargetConfig,
  SystemConfig,
  VisionConfig,
  VisionProvider,
} from './types.ts'
export {
  CONFIG_SCHEMA_VERSION,
  RUNTIME_CHANNEL_SETTINGS_FILENAME,
  RUNTIME_MODEL_SETTINGS_FILENAME,
} from './types.ts'
