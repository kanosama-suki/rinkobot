/**
 * 测试 Profile 的运行时预检。
 *
 * 在创建 Rinkobot 进程之前加载配置、校验路径、打开主库和独立墓碑库并立即关闭。
 * 这样损坏数据库或 schema 不兼容会由启动脚本 fail-closed，而不是等进程
 * 把 optional 插件静默跳过。成功预检可能创建空数据库，但不会写业务事件。
 */

import { KanobotStorage } from '../src/core/storage/index.ts'
import {
  ConfigError,
  formatConfigIssues,
  loadConfigFromDirectory,
} from '../src/core/config/index.ts'

const configDir = process.argv[2]
const dataDir = process.argv[3]
if (configDir === undefined || dataDir === undefined) {
  console.error(
    'usage: node scripts/preflight-runtime.ts <config-directory> <data-directory>',
  )
  process.exitCode = 2
} else {
  try {
    const loaded = loadConfigFromDirectory(configDir)
    const storage = KanobotStorage.openFromConfig(loaded, dataDir)
    try {
      // 同时验证备份目录权限和 VACUUM INTO；插件当日启动会复用这份备份。
      storage.maybeCreateDailyBackup()
      console.log(`storage ok: ${storage.databasePath}`)
      console.log(`tombstones ok: ${storage.tombstonePath}`)
    } finally {
      storage.close()
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(formatConfigIssues(error.issues))
    } else {
      console.error(error instanceof Error ? error.message : String(error))
    }
    process.exitCode = 1
  }
}
