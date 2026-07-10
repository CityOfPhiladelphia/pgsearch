// ABOUTME: Tests for configuration defaults and merging logic.
// ABOUTME: Verifies that partial config overrides merge correctly with defaults.

import { describe, it, expect } from 'vitest'
import { mergeConfig, DEFAULT_CONFIG } from '../config'

describe('config', () => {
  it('returns full defaults when no overrides provided', () => {
    const config = mergeConfig({})
    expect(config.embedding).toEqual({ provider: 'bedrock', model: 'amazon.titan-embed-text-v2:0', dimensions: 1024 })
    expect(config.field_weights).toEqual({ title: 3.0, body: 1.0 })
    expect(config.rrf_k).toBe(60)
    expect(config.rrf_weights).toEqual({ bm25: 1.0, vector: 1.0 })
    expect(config.min_bm25_score).toBe(0)
    expect(config.min_vector_score).toBe(0)
    expect(config.max_segment_tokens).toBe(1000)
    expect(config.max_segments_per_document).toBe(150)
    expect(config.text_search_config).toBe('english')
  })

  it('merges partial overrides with defaults', () => {
    const config = mergeConfig({ rrf_k: 30 })
    expect(config.rrf_k).toBe(30)
    expect(config.min_vector_score).toBe(0) // default preserved
  })

  it('merges nested embedding config', () => {
    const config = mergeConfig({
      embedding: { provider: 'bedrock', model: 'amazon.titan-embed-text-v2:0', dimensions: 1024 }
    })
    expect(config.embedding.provider).toBe('bedrock')
    expect(config.embedding.dimensions).toBe(1024)
  })

  it('merges partial embedding config preserving defaults', () => {
    const config = mergeConfig({
      embedding: { dimensions: 512 } as any
    })
    expect(config.embedding.provider).toBe('bedrock') // default preserved
    expect(config.embedding.model).toBe('amazon.titan-embed-text-v2:0') // default preserved
    expect(config.embedding.dimensions).toBe(512)
  })

  it('merges partial rrf_weights preserving defaults', () => {
    const config = mergeConfig({
      rrf_weights: { bm25: 2.0 } as any
    })
    expect(config.rrf_weights.bm25).toBe(2.0)
    expect(config.rrf_weights.vector).toBe(1.0) // default preserved
  })

  it('defaults kind_weights to empty (engine has no label opinions)', () => {
    expect(mergeConfig({}).kind_weights).toEqual({})
  })

  it('replaces kind_weights wholesale on override', () => {
    const base = mergeConfig({ kind_weights: { services: 1.2, documents: 0.8 } })
    expect(mergeConfig({ kind_weights: { posts: 0.9 } }, base).kind_weights).toEqual({ posts: 0.9 })
  })

  it('merges partial field_weights preserving defaults', () => {
    const config = mergeConfig({
      field_weights: { title: 5.0 } as any
    })
    expect(config.field_weights.title).toBe(5.0)
    expect(config.field_weights.body).toBe(1.0) // default preserved
  })
})
