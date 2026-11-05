/**
 * 所有者操作审计。
 *
 * 这一层只做时间来源和公开接口收口；实际写入仍由存储层校验并持久化。
 * 审计内容不包含记忆正文、提示词或模型输出。
 */

import type {
  KanobotStorage,
  OwnerAuditRecord,
  RecordOwnerAuditInput,
} from '../storage/index.ts'
import { systemClock, type Clock } from '../state/index.ts'

export class OwnerAuditService {
  private readonly storage: KanobotStorage
  private readonly clock: Clock

  constructor(storage: KanobotStorage, clock: Clock = systemClock) {
    this.storage = storage
    this.clock = clock
  }

  record(input: RecordOwnerAuditInput): OwnerAuditRecord {
    return this.storage.recordOwnerAudit({
      ...input,
      occurredAt: input.occurredAt ?? this.clock.now().toISOString(),
    })
  }

  list(limit = 50): OwnerAuditRecord[] {
    return this.storage.listOwnerAudit(limit)
  }

  count(): number {
    return this.storage.ownerAuditCount()
  }
}
