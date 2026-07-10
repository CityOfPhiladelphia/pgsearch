// ABOUTME: LLM adapter factory mapping PromptContent → LlmAdapter.
// ABOUTME: Model-format validation lives in createBedrockLlmAdapter.

import type { LlmAdapter } from '@phila/llm'
import { createBedrockLlmAdapter } from '@phila/llm'
import type { PromptContent } from '../types'

export function getLlmAdapter(content: PromptContent): LlmAdapter {
  return createBedrockLlmAdapter({ model: content.model })
}
