// ABOUTME: Request and response type definitions for the pgsearch API client.
// ABOUTME: Mirrors the API contract defined in the pgsearch service.

export interface IndexConfig {
  text_search_config?: string
  embedding?: { provider?: string; model?: string; dimensions?: number }
  bm25_k1?: number
  bm25_b?: number
  field_weights?: { title?: number; body?: number }
  rrf_k?: number
  rrf_weights?: { bm25?: number; vector?: number }
  min_bm25_score?: number
  min_vector_score?: number
  max_segment_tokens?: number
  max_segments_per_document?: number
}

export interface CreateIndexRequest {
  name: string
  description?: string
  config?: IndexConfig
}

export interface CreateIndexResponse {
  name: string
  index_key: string
  search_key: string
  created_at: string
}

export interface IndexInfo {
  name: string
  description: string | null
  config: IndexConfig
  total_documents: number
  created_at: string
  updated_at: string
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
