// ABOUTME: Shared type definitions for the pgsearch API.
// ABOUTME: Covers index configuration, documents, segments, and API contracts.

export interface IndexConfig {
  text_search_config: string
  embedding: EmbeddingConfig
  bm25_k1: number
  bm25_b: number
  field_weights: { title: number; body: number }
  rrf_k: number
  rrf_weights: { bm25: number; vector: number }
  min_bm25_score: number
  min_vector_score: number
  max_segment_tokens: number
  max_segments_per_document: number
  refresh_threshold: number
}

export interface EmbeddingConfig {
  provider: 'bedrock' | 'local'
  model: string
  dimensions: number
}

export interface SearchIndex {
  index_id: number
  name: string
  description: string | null
  config: IndexConfig
  index_key_hash: string
  search_key_hash: string
  total_documents: number
  avg_title_length: number
  avg_body_length: number
  last_refreshed_at: string | null
  docs_changed_since_refresh: number
  created_at: string
  updated_at: string
}

export interface SearchDocument {
  document_id: string
  index_id: number
  external_id: string
  title: string
  title_tsvector: string | null
  title_length: number
  metadata: Record<string, unknown>
  segment_count: number
  created_at: string
  updated_at: string
}

export interface SearchSegment {
  segment_id: string
  document_id: string
  index_id: number
  segment_index: number
  body: string
  content_hash: string
  embedding: number[] | null
  body_tsvector: string | null
  body_length: number
  created_at: string
}

export interface IngestRequest {
  external_id: string
  title: string
  body: string
  metadata?: Record<string, unknown>
}

export interface IngestResponse {
  external_id: string
  segments: number
  changed: number
  unchanged: number
  status: 'indexed'
}

export interface SearchResult {
  external_id: string
  score: number
  title: string
  snippet: string
  metadata: Record<string, unknown>
}

export interface SearchResponse {
  results: SearchResult[]
  total: number
  query: string
}

export interface CreateIndexRequest {
  name: string
  description?: string
  config?: Partial<IndexConfig>
}

export interface CreateIndexResponse {
  name: string
  index_key: string
  search_key: string
  created_at: string
}

export interface ApiError {
  error: {
    code: string
    message: string
  }
}

export type AppEnv = {
  Variables: {
    index: SearchIndex
  }
}
