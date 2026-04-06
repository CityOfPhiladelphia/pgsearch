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
  bm25_k1: 1.2,
  bm25_b: 0.75,
  field_weights: { title: 3.0, body: 1.0 },
  blend_alpha: 0.6,
  max_segment_tokens: 500,
  max_segments_per_document: 100,
  refresh_threshold: 100,
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
  }
}
