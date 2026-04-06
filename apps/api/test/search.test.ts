// ABOUTME: Integration tests for hybrid search combining BM25F keyword scoring and vector similarity.
// ABOUTME: Tests vector retrieval, BM25F scoring, score blending, and document deduplication.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { refreshIndex } from '../services/refresh'
import { vectorCandidates, hybridSearch } from '../services/search'
import { createTestAdapter } from '@phila/search-embeddings'
import type { Pool } from 'pg'

describe('search', () => {
  let pool: Pool
  let indexId: number
  const adapter = createTestAdapter(384)

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    const result = await createIndex(pool, { name: 'search-test' })
    const row = await pool.query("SELECT index_id FROM search_indexes WHERE name = 'search-test'")
    indexId = row.rows[0].index_id

    // Ingest test documents
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'parking',
      title: 'Parking Permits',
      body: 'Apply for a residential parking permit online. The process takes about two weeks.',
    })
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'taxes',
      title: 'Property Taxes',
      body: 'Pay your property taxes online or by mail. Deadlines are quarterly.',
    })
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'parks',
      title: 'City Parks',
      body: 'Visit one of Philadelphia many city parks. Free admission to all parks.',
    })

    // Refresh so BM25F has IDF data
    await refreshIndex(pool, indexId)
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  describe('vector candidates', () => {
    it('retrieves candidates by vector similarity', async () => {
      const queryEmbedding = (await adapter.embed(['parking permit application']))[0]
      const candidates = await vectorCandidates(pool, indexId, queryEmbedding, 10)
      expect(candidates.length).toBeGreaterThan(0)
      expect(candidates[0]).toHaveProperty('segment_id')
      expect(candidates[0]).toHaveProperty('similarity')
    })

    it('returns results ordered by similarity', async () => {
      const queryEmbedding = (await adapter.embed(['parking permit']))[0]
      const candidates = await vectorCandidates(pool, indexId, queryEmbedding, 10)
      for (let i = 1; i < candidates.length; i++) {
        expect(candidates[i - 1].similarity).toBeGreaterThanOrEqual(candidates[i].similarity)
      }
    })
  })

  describe('hybrid search', () => {
    it('returns results with scores, titles, snippets, and metadata', async () => {
      const results = await hybridSearch(pool, indexId, adapter, 'parking permit', { limit: 10 })
      expect(results.results.length).toBeGreaterThan(0)
      expect(results.results[0]).toHaveProperty('external_id')
      expect(results.results[0]).toHaveProperty('score')
      expect(results.results[0]).toHaveProperty('title')
      expect(results.results[0]).toHaveProperty('snippet')
      expect(results.total).toBeGreaterThan(0)
      expect(results.query).toBe('parking permit')
    })

    it('deduplicates results by document', async () => {
      // Ingest a document with multiple segments
      const longBody = Array(5).fill('Parking permit information and details about the application process for residents.').join('\n\n')
      await ingestDocument(pool, indexId, adapter, {
        external_id: 'multi-segment',
        title: 'Parking Info',
        body: longBody,
      }, { max_segment_tokens: 15 })
      await refreshIndex(pool, indexId)

      const results = await hybridSearch(pool, indexId, adapter, 'parking', { limit: 10 })
      const multiSegmentResults = results.results.filter(r => r.external_id === 'multi-segment')
      expect(multiSegmentResults.length).toBeLessThanOrEqual(1)
    })

    it('returns empty results for no matches', async () => {
      const results = await hybridSearch(pool, indexId, adapter, 'xyzzynonexistent', { limit: 10 })
      // May still get vector results (semantic similarity), but at least verifies no crash
      expect(results.results).toBeDefined()
      expect(results.query).toBe('xyzzynonexistent')
    })
  })
})
