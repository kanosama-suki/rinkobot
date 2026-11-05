/**
 * 配置预检 CLI。
 *
 * 退出码约定：0 表示合法，1 表示配置错误，2 表示用法错误。
 * DSH 测试启动脚本依赖非零退出码实现 fail-closed。
 */

import { formatConfigIssues, loadConfigFromDirectory, ConfigError } from '../src/core/config/index.ts'

const configDir = process.argv[2]
if (configDir === undefined) {
  console.error('usage: node scripts/validate-config.ts <config-directory>')
  process.exitCode = 2
} else {
  try {
    const config = loadConfigFromDirectory(configDir)
    console.log(
      `config ok: ${config.system.environment}, ` +
        `${config.system.model.provider}/${config.system.model.name}, ` +
        `identity=${config.identity.mode}, tools=${config.policy.tools.allow.length}`,
    )
  } catch (error) {
    if (error instanceof ConfigError) {
      // ConfigError 已经包含文件和字段；直接打印，避免丢失定位信息。
      console.error(formatConfigIssues(error.issues))
      process.exitCode = 1
    } else {
      throw error
    }
  }
}
