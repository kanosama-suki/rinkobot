/**
 * 插件生命周期的最小资源模型。
 *
 * 当前只持有 heartbeat 定时器；后续后台任务、监听器和 worker 也必须由
 * dispose 统一释放，避免 DSH 卸载插件后留下活动句柄。
 */

export interface PluginLifecycleOptions {
  heartbeatMs?: number
  onHeartbeat?: () => void
}

export interface PluginLifecycle {
  readonly startedAt: string
  dispose(): void
  isDisposed(): boolean
  heartbeatCount(): number
}

export function createPluginLifecycle(
  options: PluginLifecycleOptions = {},
): PluginLifecycle {
  const heartbeatMs = options.heartbeatMs ?? 300_000
  // 限制间隔范围，避免误配成高频空转或长到失去意义的定时器。
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1_000 || heartbeatMs > 86_400_000) {
    throw new RangeError('heartbeatMs must be an integer between 1000 and 86400000')
  }

  const startedAt = new Date().toISOString()
  let disposed = false
  let heartbeats = 0

  // 回调与 dispose 可能竞争，执行前再次检查状态。
  const timer = setInterval(() => {
    if (disposed) return
    heartbeats += 1
    options.onHeartbeat?.()
  }, heartbeatMs)

  return {
    startedAt,
    dispose(): void {
      // dispose 必须幂等；宿主可能重复执行清理，重复停止不能报错。
      if (disposed) return
      disposed = true
      clearInterval(timer)
    },
    isDisposed(): boolean {
      return disposed
    },
    heartbeatCount(): number {
      return heartbeats
    },
  }
}
