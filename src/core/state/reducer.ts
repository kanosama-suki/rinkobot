/**
 * 纯状态 reducer。
 *
 * 边界：
 * - 只读入 state 和已校验事件，不读系统时间、网络、随机数或配置以外的状态；
 * - 返回新对象，不修改输入；
 * - 关系变化受配置上限约束，所有数值夹紧到合法区间；
 * - 事件语义非法时直接抛错，不吞掉或猜测调用方意图。
 */

import type { LifeStateConfig } from '../config/types.ts'
import { validateStateEvent } from './events.ts'
import type {
  Activity,
  Commitment,
  LifeState,
  StateEvent,
} from './types.ts'

const HURT_REPAIR_THRESHOLD = 0.05
const ONE_MICRO = 1e-6

export function createInitialState(config: LifeStateConfig): LifeState {
  return {
    activity: 'idle',
    affect: {
      valence: round6(clamp(config.initial.valence, -1, 1)),
      arousal: round6(clamp(config.initial.arousal, 0, 1)),
    },
    energy: round6(clamp(config.initial.energy, 0, 1)),
    socialBattery: round6(clamp(config.initial.socialBattery, 0, 1)),
    relationship: {
      closeness: round6(clamp(config.initial.closeness, 0, 1)),
      hurt: 0,
      repairNeeded: false,
    },
    attention: {
      busyUntil: null,
    },
    commitments: [],
  }
}

export function reduceState(
  state: LifeState,
  input: StateEvent,
  config: LifeStateConfig,
): LifeState {
  const event = validateStateEvent(input)
  switch (event.type) {
    case 'tick':
      return applyTick(state, event, config)
    case 'activity.changed':
      return applyActivityChanged(state, event)
    case 'appraisal.recorded':
      return applyAppraisal(state, event)
    case 'interaction.recorded':
      return applyInteraction(state, event, config)
    case 'relationship.adjusted':
      return applyRelationshipAdjustment(state, event, config)
    case 'commitment.created':
      return applyCommitmentCreated(state, event, config)
    case 'commitment.resolved':
      return applyCommitmentResolved(state, event)
  }
}

function applyTick(
  state: LifeState,
  event: Extract<StateEvent, { type: 'tick' }>,
  config: LifeStateConfig,
): LifeState {
  const hours = event.payload.elapsedMinutes / 60
  const energy = event.payload.awake
    ? state.energy - config.decayPerHour.energyAwake * hours
    : state.energy + config.decayPerHour.energyAsleepRecovery * hours
  const socialBattery = event.payload.awake
    ? state.socialBattery - config.decayPerHour.socialBatteryAwake * hours
    : state.socialBattery +
      config.decayPerHour.socialBatteryAsleepRecovery * hours

  // valence 向中性衰减；arousal 回到配置的基线，而不是一律回到 0。
  const valence = decayTowardZero(
    state.affect.valence,
    config.decayPerHour.valence * hours,
  )
  const arousalFactor = Math.exp(-config.decayPerHour.arousal * hours)
  const arousal =
    config.initial.arousal +
    (state.affect.arousal - config.initial.arousal) * arousalFactor
  // Tick 表示从 occurredAt 起经过了一段时间；忙碌状态应在推进后的时刻判断，
  // 而不是只看 Tick 开始的时刻。
  const tickEnd = Date.parse(event.occurredAt) + event.payload.elapsedMinutes * 60_000
  const busyUntil =
    state.attention.busyUntil !== null &&
    Date.parse(state.attention.busyUntil) <= tickEnd
      ? null
      : state.attention.busyUntil

  return {
    ...state,
    affect: {
      valence: round6(clamp(valence, -1, 1)),
      arousal: round6(clamp(arousal, 0, 1)),
    },
    energy: round6(clamp(energy, 0, 1)),
    socialBattery: round6(clamp(socialBattery, 0, 1)),
    attention: {
      ...state.attention,
      busyUntil,
    },
  }
}

function applyActivityChanged(
  state: LifeState,
  event: Extract<StateEvent, { type: 'activity.changed' }>,
): LifeState {
  const busyUntil =
    event.payload.busyUntil !== null &&
    Date.parse(event.payload.busyUntil) <= Date.parse(event.occurredAt)
      ? null
      : event.payload.busyUntil
  return {
    ...state,
    activity: event.payload.activity as Activity,
    attention: {
      busyUntil,
    },
  }
}

function applyAppraisal(
  state: LifeState,
  event: Extract<StateEvent, { type: 'appraisal.recorded' }>,
): LifeState {
  const { appraisal } = event.payload
  // 置信度就是这次 appraisal 对现有情绪的权重；低置信判断不能整幅覆盖状态。
  const weight = appraisal.confidence
  return {
    ...state,
    affect: {
      valence: round6(
        clamp(
          state.affect.valence * (1 - weight) + appraisal.valence * weight,
          -1,
          1,
        ),
      ),
      arousal: round6(
        clamp(
          state.affect.arousal * (1 - weight) + appraisal.arousal * weight,
          0,
          1,
        ),
      ),
    },
  }
}

function applyInteraction(
  state: LifeState,
  event: Extract<StateEvent, { type: 'interaction.recorded' }>,
  config: LifeStateConfig,
): LifeState {
  const { kind, intensity } = event.payload
  const cap = config.limits.maxRelationshipDeltaPerEvent
  let energy = state.energy
  let socialBattery = state.socialBattery
  let closeness = state.relationship.closeness
  let hurt = state.relationship.hurt

  switch (kind) {
    case 'conversation':
      energy -= 0.01 * intensity
      socialBattery -= 0.04 * intensity
      closeness += Math.min(cap, 0.002 * intensity)
      break
    case 'shared_experience':
      energy -= 0.005 * intensity
      socialBattery -= 0.015 * intensity
      closeness += Math.min(cap, 0.01 * intensity)
      break
    case 'conflict':
      energy -= 0.02 * intensity
      socialBattery -= 0.06 * intensity
      closeness -= Math.min(cap, 0.01 * intensity)
      hurt += 0.12 * intensity
      break
    case 'apology':
      // 道歉最多消去当前 hurt 的一半，不能一次抹掉冲突留下的影响。
      hurt -= Math.min(hurt * 0.5, 0.1 * intensity)
      closeness += Math.min(cap, 0.002 * intensity)
      break
  }

  return withRelationship(state, {
    energy: round6(clamp(energy, 0, 1)),
    socialBattery: round6(clamp(socialBattery, 0, 1)),
    closeness: round6(clamp(closeness, 0, 1)),
    hurt: round6(clamp(hurt, 0, 1)),
  })
}

function applyRelationshipAdjustment(
  state: LifeState,
  event: Extract<StateEvent, { type: 'relationship.adjusted' }>,
  config: LifeStateConfig,
): LifeState {
  const cap = config.limits.maxRelationshipDeltaPerEvent + ONE_MICRO
  const { closenessDelta, hurtDelta } = event.payload
  if (Math.abs(closenessDelta) > cap || Math.abs(hurtDelta) > cap) {
    throw new RangeError(
      `relationship delta exceeds configured cap ${config.limits.maxRelationshipDeltaPerEvent}`,
    )
  }
  return withRelationship(state, {
    closeness: round6(
      clamp(state.relationship.closeness + closenessDelta, 0, 1),
    ),
    hurt: round6(clamp(state.relationship.hurt + hurtDelta, 0, 1)),
  })
}

function applyCommitmentCreated(
  state: LifeState,
  event: Extract<StateEvent, { type: 'commitment.created' }>,
  config: LifeStateConfig,
): LifeState {
  if (
    state.commitments.some(
      commitment => commitment.id === event.payload.commitmentId,
    )
  ) {
    throw new Error(`commitment "${event.payload.commitmentId}" already exists`)
  }
  if (state.commitments.length >= config.limits.maxCommitments) {
    throw new RangeError(
      `commitment limit ${config.limits.maxCommitments} has been reached`,
    )
  }
  const commitment: Commitment = {
    id: event.payload.commitmentId,
    descriptionRef: event.payload.descriptionRef,
    dueAt: event.payload.dueAt,
    status: 'open',
  }
  return {
    ...state,
    commitments: [...state.commitments, commitment],
  }
}

function applyCommitmentResolved(
  state: LifeState,
  event: Extract<StateEvent, { type: 'commitment.resolved' }>,
): LifeState {
  const index = state.commitments.findIndex(
    commitment => commitment.id === event.payload.commitmentId,
  )
  if (index < 0) {
    throw new Error(`unknown commitment "${event.payload.commitmentId}"`)
  }
  if (state.commitments[index].status !== 'open') {
    throw new Error(
      `commitment "${event.payload.commitmentId}" is already resolved`,
    )
  }
  const commitments = [...state.commitments]
  commitments[index] = {
    ...commitments[index],
    status: event.payload.status,
  }
  return {
    ...state,
    commitments,
  }
}

function withRelationship(
  state: LifeState,
  values: {
    closeness?: number
    hurt?: number
    energy?: number
    socialBattery?: number
  },
): LifeState {
  const hurt = values.hurt ?? state.relationship.hurt
  return {
    ...state,
    ...(values.energy === undefined ? {} : { energy: values.energy }),
    ...(values.socialBattery === undefined
      ? {}
      : { socialBattery: values.socialBattery }),
    relationship: {
      closeness: values.closeness ?? state.relationship.closeness,
      hurt,
      repairNeeded: hurt >= HURT_REPAIR_THRESHOLD,
    },
  }
}

function decayTowardZero(value: number, amount: number): number {
  if (value > 0) return Math.max(0, value - amount)
  if (value < 0) return Math.min(0, value + amount)
  return 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round6(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6
  return Object.is(rounded, -0) ? 0 : rounded
}
