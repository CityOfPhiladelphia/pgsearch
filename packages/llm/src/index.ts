// ABOUTME: LLM adapter package exports.
// ABOUTME: Provides adapter interface, implementations, and factory.

export type {
  LlmAdapter,
  LlmMessage,
  LlmCompleteInput,
  LlmCompleteResult,
} from './adapter'
export { createTestLlmAdapter } from './test'
export type { TestAdapterOptions } from './test'
export { createBedrockLlmAdapter } from './bedrock'
export type { BedrockLlmConfig } from './bedrock'
