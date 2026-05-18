// ABOUTME: Deterministic test LLM adapter for integration testing.
// ABOUTME: Echoes the latest user message and optionally appends citation markers.

import type { LlmAdapter, LlmCompleteInput, LlmCompleteResult } from './adapter'

export interface TestAdapterOptions {
  withCitations?: number[]
}

export function createTestLlmAdapter(options: TestAdapterOptions = {}): LlmAdapter {
  return {
    model: 'test-llm',
    async complete(input: LlmCompleteInput): Promise<LlmCompleteResult> {
      const latestUser = [...input.messages].reverse().find(m => m.role === 'user')
      const userText = latestUser ? latestUser.content : ''
      let text = `[test] ${userText}`
      if (options.withCitations) {
        text += ' ' + options.withCitations.map(n => `[${n}]`).join(' ')
      }
      return {
        text,
        usage: {
          input_tokens: input.system.length + userText.length,
          output_tokens: text.length,
        },
        model: 'test-llm',
      }
    },
  }
}
