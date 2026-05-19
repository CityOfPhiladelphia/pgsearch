// ABOUTME: Tests for the deterministic test LLM adapter.
// ABOUTME: Ensures it produces stable, identifiable output for integration tests.

import { describe, it, expect } from 'vitest'
import { createTestLlmAdapter } from '../src/test'

describe('createTestLlmAdapter', () => {
  it('echoes the latest user message prefixed with [test]', async () => {
    const adapter = createTestLlmAdapter()
    const result = await adapter.complete({
      system: 'be terse',
      messages: [{ role: 'user', content: 'hello world' }],
      max_tokens: 100,
      temperature: 0,
    })
    expect(result.text).toBe('[test] hello world')
  })

  it('reports token usage as character counts of system + last message and output', async () => {
    const adapter = createTestLlmAdapter()
    const result = await adapter.complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'q' }],
      max_tokens: 10,
      temperature: 0,
    })
    expect(result.usage.input_tokens).toBe(4) // "sys" (3) + "q" (1)
    expect(result.usage.output_tokens).toBe(result.text.length)
  })

  it('uses the latest user message even with prior turns', async () => {
    const adapter = createTestLlmAdapter()
    const result = await adapter.complete({
      system: '',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      max_tokens: 100,
      temperature: 0,
    })
    expect(result.text).toBe('[test] second')
  })

  it('emits citation-friendly output when asked to', async () => {
    const adapter = createTestLlmAdapter({ withCitations: [1, 2] })
    const result = await adapter.complete({
      system: '',
      messages: [{ role: 'user', content: 'q' }],
      max_tokens: 100,
      temperature: 0,
    })
    expect(result.text).toContain('[1]')
    expect(result.text).toContain('[2]')
  })

  it('reports a stable model identifier', async () => {
    const adapter = createTestLlmAdapter()
    expect(adapter.model).toBe('test-llm')
    const result = await adapter.complete({
      system: '', messages: [{ role: 'user', content: 'q' }], max_tokens: 1, temperature: 0,
    })
    expect(result.model).toBe('test-llm')
  })
})
