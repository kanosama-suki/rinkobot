/**
 * 测试用聊天信封构造器。
 *
 * 只生成虚构占位内容，帮助测试明确区分“回复正文”和结构化元数据。
 */

export interface TestEnvelopeOptions {
  memoryCandidates?: unknown[]
  appraisal?: {
    valence: number
    arousal: number
    confidence: number
  } | null
  commitments?: unknown[]
  reminderCandidates?: unknown[]
  careCandidates?: unknown[]
}

export function chatEnvelopeText(
  reply: string,
  options: TestEnvelopeOptions = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    reply,
    memoryCandidates: options.memoryCandidates ?? [],
    appraisal: options.appraisal === undefined
      ? { valence: 0.1, arousal: 0.3, confidence: 0.6 }
      : options.appraisal,
    commitments: options.commitments ?? [],
    reminderCandidates: options.reminderCandidates ?? [],
    careCandidates: options.careCandidates ?? [],
  })
}
