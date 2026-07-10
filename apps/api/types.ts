// ABOUTME: Shared type definitions for the pgsearch API.
// ABOUTME: Covers index configuration, documents, segments, and API contracts.

export interface IndexConfig {
  text_search_config: string
  embedding: EmbeddingConfig
  field_weights: { title: number; body: number }
  rrf_k: number
  rrf_weights: { bm25: number; vector: number }
  kind_weights: Record<string, number>
  min_bm25_score: number
  min_vector_score: number
  max_segment_tokens: number
  max_segments_per_document: number
}

export interface EmbeddingConfig {
  provider: 'bedrock'
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
  rag_key_hash: string | null
  total_documents: number
  created_at: string
  updated_at: string
}

export interface SearchDocument {
  document_id: string
  index_id: number
  external_id: string
  title: string
  title_tsvector: string | null
  kind: string | null
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
  created_at: string
}

export interface IngestRequest {
  external_id: string
  title: string
  body: string
  kind?: string
  metadata?: Record<string, unknown>
}

export interface IngestResponse {
  external_id: string
  segments: number
  changed: number
  unchanged: number
  status: 'indexed'
}

export interface DocumentState {
  external_id: string
  updated_at: string
  kind: string | null
  metadata: Record<string, unknown>
}

export interface DocumentStateResponse {
  documents: DocumentState[]
  next_cursor: string | null
}

export interface SearchResult {
  external_id: string
  score: number
  title: string
  snippet: string
  kind: string | null
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

export interface PromptRetrievalConfig {
  mode: 'hybrid' | 'bm25' | 'semantic'
  limit: number
  max_chunks_per_doc: number
  min_bm25_score: number
  min_vector_score: number
}

export interface PromptContent {
  system: string
  response_format: string
  model: string
  max_tokens: number
  temperature: number
  retrieval: PromptRetrievalConfig
}

export interface RagPrompt {
  prompt_id: string
  index_id: number
  name: string
  content: PromptContent
  created_at: string
  updated_at: string
}

export interface RagRequest {
  question: string
  messages?: { role: 'user' | 'assistant'; content: string }[]
}

export interface Citation {
  marker: number
  external_id: string
  title: string
  url: string
  snippet: string
}

export interface RetrievedRef {
  external_id: string
  score: number
  used: boolean
}

export interface RagResponse {
  answer: string
  citations: Citation[]
  retrieved: RetrievedRef[]
  model: string
  prompt: string
  usage: { input_tokens: number; output_tokens: number }
}
