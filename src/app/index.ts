/**
 * 正式独立程序公开入口。
 */

export { createAppServer } from './server.ts'
export type { AppServer, AppServerOptions } from './server.ts'
export { runBackupCommand } from './backup-command.ts'
export type {
  BackupCommandName,
  BackupCommandOptions,
  BackupCommandResult,
} from './backup-command.ts'
export { APP_HEALTH_PATH } from './health.ts'
export type { HealthPayload, HealthStatus } from './health.ts'
