// ABOUTME: Typed HTTP client for the pgsearch search API.
// ABOUTME: Provides methods for index management, document ingestion, and search.

import type {
  CreateIndexRequest, CreateIndexResponse, IndexInfo,
  IngestRequest, IngestResponse, SearchResponse, IndexConfig
} from './types'

export type { CreateIndexRequest, CreateIndexResponse, IndexInfo, IngestRequest, IngestResponse, SearchResponse, IndexConfig } from './types'

interface ClientConfig {
  baseUrl: string
  adminKey?: string
}

export class PgsearchClient {
  private baseUrl: string
  private adminKey?: string

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.adminKey = config.adminKey
  }

  // Admin operations
  async createIndex(request: CreateIndexRequest): Promise<CreateIndexResponse> {
    return this.request('POST', '/admin/indexes', { body: request, auth: 'admin' })
  }

  async listIndexes(): Promise<IndexInfo[]> {
    return this.request('GET', '/admin/indexes', { auth: 'admin' })
  }

  async getIndex(name: string): Promise<IndexInfo> {
    return this.request('GET', `/admin/indexes/${name}`, { auth: 'admin' })
  }

  async updateIndex(name: string, config: Partial<IndexConfig>): Promise<void> {
    await this.request('PATCH', `/admin/indexes/${name}`, { body: config, auth: 'admin' })
  }

  async deleteIndex(name: string): Promise<void> {
    await this.request('DELETE', `/admin/indexes/${name}`, { auth: 'admin' })
  }

  async refreshIndex(name: string): Promise<void> {
    await this.request('POST', `/admin/indexes/${name}/refresh`, { auth: 'admin' })
  }

  // Ingest operations
  async ingest(indexName: string, document: IngestRequest, indexKey: string): Promise<IngestResponse> {
    return this.request('POST', `/index/${indexName}/documents`, { body: document, headers: { 'x-index-key': indexKey } })
  }

  async deleteDocument(indexName: string, externalId: string, indexKey: string): Promise<void> {
    await this.request('DELETE', `/index/${indexName}/documents/${externalId}`, { headers: { 'x-index-key': indexKey } })
  }

  // Search operations
  async search(indexName: string, query: string, searchKey: string, options?: { limit?: number }): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query })
    if (options?.limit) params.set('limit', String(options.limit))
    return this.request('GET', `/search/${indexName}?${params}`, { headers: { 'x-search-key': searchKey } })
  }

  // Internal
  private async request<T>(method: string, path: string, options?: { body?: unknown; auth?: 'admin'; headers?: Record<string, string> }): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...options?.headers }
    if (options?.auth === 'admin' && this.adminKey) {
      headers['x-api-key'] = this.adminKey
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { code: 'UNKNOWN', message: response.statusText } }))
      throw new Error(`pgsearch API error: ${error.error?.code || response.status} - ${error.error?.message || response.statusText}`)
    }
    const text = await response.text()
    return text ? JSON.parse(text) : undefined
  }
}
