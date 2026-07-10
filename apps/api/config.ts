// ABOUTME: Default configuration values and config merging logic.
// ABOUTME: Applies sensible defaults so most callers only need to provide index name.

import type { IndexConfig, EmbeddingConfig } from './types'

const DEFAULT_EMBEDDING: EmbeddingConfig = {
  provider: 'local',
  model: 'all-MiniLM-L6-v2',
  dimensions: 384,
}

export const DEFAULT_CONFIG: IndexConfig = {
  text_search_config: 'english',
  embedding: { ...DEFAULT_EMBEDDING },
  field_weights: { title: 3.0, body: 1.0 },
  rrf_k: 60,
  rrf_weights: { bm25: 1.0, vector: 1.0 },
  min_bm25_score: 0,
  min_vector_score: 0,
  max_segment_tokens: 1000,
  max_segments_per_document: 150,
}

export function mergeConfig(overrides: Partial<IndexConfig>, base: IndexConfig = DEFAULT_CONFIG): IndexConfig {
  return {
    ...base,
    ...overrides,
    embedding: {
      ...(base.embedding || DEFAULT_EMBEDDING),
      ...(overrides.embedding || {}),
    },
    field_weights: {
      ...(base.field_weights || DEFAULT_CONFIG.field_weights),
      ...(overrides.field_weights || {}),
    },
    rrf_weights: {
      ...(base.rrf_weights || DEFAULT_CONFIG.rrf_weights),
      ...(overrides.rrf_weights || {}),
    },
  }
}
