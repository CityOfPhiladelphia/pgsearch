// ABOUTME: Tests for the embedding adapter factory — ensures unknown providers
// ABOUTME: fail loudly instead of silently degrading to the deterministic test adapter.

import { describe, it, expect } from 'vitest'
import { getAdapter } from '../services/adapter'
import type { IndexConfig } from '../types'

function configWith(provider: string): IndexConfig {
  return {
    embedding: { provider, model: 'some-model', dimensions: 384 },
    text_search_config: 'english',
    bm25_k1: 1.2,
    bm25_b: 0.75,
    field_weights: { title: 3.0, body: 1.0 },
    rrf_k: 60,
    rrf_weights: { bm25: 1.0, vector: 1.0 },
    min_bm25_score: 0,
    min_vector_score: 0,
    max_segment_tokens: 500,
    max_segments_per_document: 100,
    refresh_threshold: 100,
  } as IndexConfig
}

describe('getAdapter', () => {
  it('returns a bedrock adapter for provider=bedrock', () => {
    const config = configWith('bedrock')
    config.embedding.model = 'amazon.titan-embed-text-v2:0'
    config.embedding.dimensions = 1024
    const adapter = getAdapter(config)
    expect(adapter.model).toBe('amazon.titan-embed-text-v2:0')
    expect(adapter.dimensions).toBe(1024)
  })

  it('throws for provider=local so indexes do not silently get fake vectors', () => {
    expect(() => getAdapter(configWith('local'))).toThrowError(
      /embedding provider.*not.*support|local/i,
    )
  })

  it('throws for any other unrecognized provider', () => {
    expect(() => getAdapter(configWith('cohere'))).toThrowError(
      /embedding provider.*not.*support/i,
    )
  })
})
