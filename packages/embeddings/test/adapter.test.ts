// ABOUTME: Tests for the embedding adapter interface and test implementation.
// ABOUTME: Verifies deterministic vector generation, dimension correctness, and batching.

import { describe, it, expect } from 'vitest'
import { createTestAdapter } from '../src/test'

describe('test embedding adapter', () => {
  it('returns vectors with correct dimensions', async () => {
    const adapter = createTestAdapter(384)
    const results = await adapter.embed(['hello world'])
    expect(results).toHaveLength(1)
    expect(results[0]).toHaveLength(384)
  })

  it('returns consistent vectors for the same input', async () => {
    const adapter = createTestAdapter(384)
    const a = await adapter.embed(['hello world'])
    const b = await adapter.embed(['hello world'])
    expect(a[0]).toEqual(b[0])
  })

  it('returns different vectors for different inputs', async () => {
    const adapter = createTestAdapter(384)
    const results = await adapter.embed(['hello', 'world'])
    expect(results[0]).not.toEqual(results[1])
  })

  it('batches multiple texts', async () => {
    const adapter = createTestAdapter(384)
    const results = await adapter.embed(['one', 'two', 'three'])
    expect(results).toHaveLength(3)
  })

  it('exposes model and dimensions', () => {
    const adapter = createTestAdapter(384)
    expect(adapter.dimensions).toBe(384)
    expect(adapter.model).toBe('test-deterministic')
  })

  it('produces unit vectors (normalized)', async () => {
    const adapter = createTestAdapter(384)
    const [vector] = await adapter.embed(['test normalization'])
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
    expect(magnitude).toBeCloseTo(1.0, 4)
  })
})
