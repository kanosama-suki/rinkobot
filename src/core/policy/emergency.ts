/**
 * 紧急停止的双重开关。
 *
 * 数据库里的 emergency_state 是持久状态；数据目录下的 STOP 文件是网页之外
 * 的物理触发方式。停止只约束自主活动，用户主动发来的聊天仍由聊天服务处理。
 * 恢复必须由所有者显式操作，不能因为删除 STOP 文件就自动恢复。
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import {
  resolveDataPath,
  type KanobotStorage,
} from '../storage/index.ts'
import { systemClock, type Clock } from '../state/index.ts'

export interface EmergencyStatus {
  stopped: boolean
  reasonCode: string
  updatedAt: string
  stopFilePresent: boolean
}

export class EmergencyStopError extends Error {
  readonly code = 'emergency_stopped'

  constructor() {
    super('emergency stop is active; autonomous activity is disabled')
    this.name = 'EmergencyStopError'
  }
}

export class KanobotEmergencyService {
  private readonly storage: KanobotStorage
  private readonly stopFilePath: string
  private readonly clock: Clock

  constructor(
    storage: KanobotStorage,
    dataDir: string,
    stopFileName: string,
    clock: Clock = systemClock,
  ) {
    this.storage = storage
    this.clock = clock
    this.stopFilePath = resolveDataPath(
      dataDir,
      stopFileName,
      'policy.emergency.stop_file',
    )
  }

  /**
   * 读取状态时顺便把运行中新建的 STOP 文件同步进数据库。
   * 删除文件不会逆转停止，恢复只能走 resume()。
   */
  status(): EmergencyStatus {
    const stopFilePresent = existsSync(this.stopFilePath)
    let state = this.storage.getEmergencyState()
    if (stopFilePresent && !state.stopped) {
      state = this.storage.setEmergencyState({
        stopped: true,
        reasonCode: 'stop_file',
        updatedAt: this.clock.now().toISOString(),
      })
    }
    return {
      stopped: state.stopped,
      reasonCode: state.reasonCode,
      updatedAt: state.updatedAt,
      stopFilePresent,
    }
  }

  stop(reasonCode = 'owner_stop'): EmergencyStatus {
    const updatedAt = this.clock.now().toISOString()
    this.storage.setEmergencyState({
      stopped: true,
      reasonCode,
      updatedAt,
    })
    this.ensureStopFile()
    return this.status()
  }

  resume(): EmergencyStatus {
    const updatedAt = this.clock.now().toISOString()
    this.storage.setEmergencyState({
      stopped: false,
      reasonCode: 'running',
      updatedAt,
    })
    if (existsSync(this.stopFilePath)) {
      rmSync(this.stopFilePath)
    }
    return this.status()
  }

  assertAutonomousAllowed(): void {
    if (this.status().stopped) throw new EmergencyStopError()
  }

  private ensureStopFile(): void {
    if (existsSync(this.stopFilePath)) return
    mkdirSync(dirname(this.stopFilePath), { recursive: true })
    // 文件内容不承担状态语义；读取数据库和文件存在性即可。
    try {
      writeFileSync(this.stopFilePath, 'stopped\n', {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
    } catch (error) {
      // 另一个停止请求恰好先创建了文件时，结果已经是目标状态。
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}
