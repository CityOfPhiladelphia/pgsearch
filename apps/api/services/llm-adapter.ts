// ABOUTME: LLM adapter factory mapping PromptContent → LlmAdapter.
// ABOUTME: Throws on unsupported model prefixes; mirrors services/adapter.ts.

import type { LlmAdapter } from '@phila/llm'
import { createBedrockLlmAdapter } from '@phila/llm'
import type { PromptContent } from '../types'

export function getLlmAdapter(content: PromptContent): LlmAdapter {
  if (content.model.startsWith('anthropic.')) {
    return createBedrockLlmAdapter({ model: content.model })
  }
  throw new Error(
    `LLM model '${content.model}' is not supported. Only 'anthropic.*' models are available in this deployment.`,
  )
}
