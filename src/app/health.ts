/**
 * 未登录回环健康检查的纯响应构造。
 *
 * 边界：
 * - 只返回服务状态、uptime、版本、数据库/调度器/QQ 是否可用；
 * - 不返回配置路径、数据路径、模型名、token、Cookie、QQ 号或聊天内容；
 * - 只要数据库不可用或调度器未运行就返回 503，不把“进程还在”当成 ready。
 */

export const APP_HEALTH_PATH = '/kanobot/api/health'

export type HealthStatus = 'ready' | 'unavailable' | 'shutting_down'

export interface HealthInput {
  startedAtMillis: number
  nowMillis: number
  version: string
  databaseOk: boolean
  schedulerRunning: boolean
  qqEnabled: boolean
  shuttingDown: boolean
}

export interface HealthPayload {
  ok: boolean
  status: HealthStatus
  uptime: number
  version: string
  database: 'ok' | 'unavailable'
  scheduler: 'running' | 'stopped'
  qq: 'enabled' | 'disabled'
}

export function buildHealthPayload(input: HealthInput): HealthPayload {
  const databaseOk = input.databaseOk
  const schedulerRunning = input.schedulerRunning
  const nowMillis = Number.isFinite(input.nowMillis)
    ? input.nowMillis
    : input.startedAtMillis
  const status: HealthStatus = input.shuttingDown
    ? 'shutting_down'
    : databaseOk && schedulerRunning
      ? 'ready'
      : 'unavailable'
  return {
    ok: status === 'ready',
    status,
    uptime: Math.max(
      0,
      Math.floor((nowMillis - input.startedAtMillis) / 1_000),
    ),
    version: input.version,
    database: databaseOk ? 'ok' : 'unavailable',
    scheduler: schedulerRunning ? 'running' : 'stopped',
    qq: input.qqEnabled ? 'enabled' : 'disabled',
  }
}

export function healthStatusCode(payload: HealthPayload): 200 | 503 {
  return payload.ok ? 200 : 503
}
