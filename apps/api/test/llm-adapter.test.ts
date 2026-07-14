// ABOUTME: Tests for the LLM adapter factory in apps/api.
// ABOUTME: Validates that supported model prefixes return adapters and others throw.

import { describe, it, expect } from 'vitest'
import { getLlmAdapter } from '../services/llm-adapter'
import type { PromptContent } from '../types'

const base: PromptContent = {
  system: '', response_format: '', model: '', max_tokens: 1, temperature: 0,
  retrieval: { mode: 'hybrid', limit: 1, max_chunks_per_doc: 1, min_lexical_score: 0, min_vector_score: 0 },
}

describe('getLlmAdapter', () => {
  it('returns a Bedrock Claude adapter for anthropic.* models', () => {
    const a = getLlmAdapter({ ...base, model: 'anthropic.claude-haiku-4-5' })
    expect(a.model).toBe('anthropic.claude-haiku-4-5')
  })

  it('throws for unsupported model prefixes', () => {
    expect(() => getLlmAdapter({ ...base, model: 'amazon.titan-text' })).toThrow(/supports only/i)
  })
})
