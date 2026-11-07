/**
 * 兼容旧调用点的薄导出；实际 provider 选择在 src/model-providers。
 */

export {
  createChatModelFromConfig as createChatModel,
  createVisionModelFromConfig as createVisionModel,
  type ModelProviderMode as KanobotModelMode,
} from '../model-providers/index.ts'
