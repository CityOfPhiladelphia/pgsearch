// ABOUTME: LLM adapter factory mapping PromptContent → LlmAdapter.
// ABOUTME: Throws on unsupported model prefixes; mirrors services/adapter.ts.

import type { LlmAdapter } from '@phila/llm'
import { createBedrockLlmAdapter } from '@phila/llm'
import type { PromptContent } from '../types'

export function getLlmAdapter(content: PromptContent): LlmAdapter {
  // Accept raw anthropic.* model IDs and regional inference profile IDs (us.anthropic.*, global.anthropic.*).
  if (/^(?:[a-z]+\.)?anthropic\./.test(content.model)) {
    return createBedrockLlmAdapter({ model: content.model })
  }
  throw new Error(
    `LLM model '${content.model}' is not supported. Only anthropic.* models and <region>.anthropic.* inference profiles are available in this deployment.`,
  )
}
