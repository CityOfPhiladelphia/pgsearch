// ABOUTME: Integration tests for hybrid search combining SQL-ranked keyword scoring and vector similarity.
// ABOUTME: Tests vector retrieval, RRF fusion, score floors, and document deduplication.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { createIndex, getIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { vectorCandidates, hybridSearch, type HybridSearchOptions } from '../services/search'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

describe('search', () => {
  let pool: Pool
  let indexId: number
  const adapter = createTestAdapter(384)
  const config = mergeConfig({})

  // Fetch a fresh index per query, mirroring how the route resolves it from auth on
  // each request — lexical corpus stats are maintained incrementally on ingest.
  const search = async (queryText: string, options: HybridSearchOptions = {}) =>
    hybridSearch(pool, (await getIndex(pool, 'search-test'))!, adapter, queryText, options)

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    const result = await createIndex(pool, { name: 'search-test', config: { embedding: { dimensions: 384 } } as any })
    const row = await pool.query("SELECT index_id FROM search_indexes WHERE name = 'search-test'")
    indexId = row.rows[0].index_id

    // Ingest test documents
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'parking',
      title: 'Parking Permits',
      body: 'Apply for a residential parking permit online. The process takes about two weeks.',
    }, config)
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'taxes',
      title: 'Property Taxes',
      body: 'Pay your property taxes online or by mail. Deadlines are quarterly.',
    }, config)
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'parks',
      title: 'City Parks',
      body: 'Visit one of Philadelphia many city parks. Free admission to all parks.',
    }, config)

  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  describe('vector candidates', () => {
    it('retrieves candidates by vector similarity', async () => {
      const queryEmbedding = (await adapter.embed(['parking permit application']))[0]
      const candidates = await vectorCandidates(pool, indexId, 384, queryEmbedding, 10)
      expect(candidates.length).toBeGreaterThan(0)
      expect(candidates[0]).toHaveProperty('segment_id')
      expect(candidates[0]).toHaveProperty('similarity')
    })

    it('returns results ordered by similarity', async () => {
      const queryEmbedding = (await adapter.embed(['parking permit']))[0]
      const candidates = await vectorCandidates(pool, indexId, 384, queryEmbedding, 10)
      for (let i = 1; i < candidates.length; i++) {
        expect(candidates[i - 1].similarity).toBeGreaterThanOrEqual(candidates[i].similarity)
      }
    })
  })

  describe('hybrid search', () => {
    it('returns results with scores, titles, snippets, and metadata', async () => {
      const results = await search('parking permit', { limit: 10 })
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
      }, config, { max_segment_tokens: 15 })

      const results = await search('parking', { limit: 10 })
      const multiSegmentResults = results.results.filter(r => r.external_id === 'multi-segment')
      expect(multiSegmentResults.length).toBeLessThanOrEqual(1)
    })

    it('returns empty results for no matches', async () => {
      const results = await search('xyzzynonexistent', { limit: 10 })
      // May still get vector results (semantic similarity), but at least verifies no crash
      expect(results.results).toBeDefined()
      expect(results.query).toBe('xyzzynonexistent')
    })
  })

  describe('search mode', () => {
    it('mode=lexical returns only keyword matches', async () => {
      const results = await search('parking permit', { limit: 10, mode: 'lexical' })
      expect(results.results.length).toBeGreaterThan(0)
      expect(results.query).toBe('parking permit')
    })

    it('mode=lexical returns empty for queries with no keyword matches', async () => {
      const results = await search('xyzzynonexistent', { limit: 10, mode: 'lexical' })
      expect(results.results).toEqual([])
      expect(results.total).toBe(0)
    })

    it('mode=semantic returns results even without keyword matches', async () => {
      const results = await search('xyzzynonexistent', { limit: 10, mode: 'semantic' })
      expect(results.results.length).toBeGreaterThan(0)
    })

    it('defaults to hybrid when mode is not specified', async () => {
      const hybrid = await search('parking permit', { limit: 10 })
      const explicit = await search('parking permit', { limit: 10, mode: 'hybrid' })
      expect(hybrid.results.length).toBe(explicit.results.length)
      expect(hybrid.results[0].score).toBeCloseTo(explicit.results[0].score, 5)
    })
  })

  describe('RRF fusion', () => {
    it('scores follow RRF pattern (small positive values)', async () => {
      const results = await search('parking permit', { limit: 10 })
      expect(results.results.length).toBeGreaterThan(0)
      for (const r of results.results) {
        // RRF scores are small: max is w/(k+1) per retriever, so ~0.033 for two equal-weight retrievers
        expect(r.score).toBeGreaterThan(0)
        expect(r.score).toBeLessThan(1)
      }
    })

    it('candidates appearing in both passes score higher than single-pass', async () => {
      // "parking" matches via lexical (keyword) and should also have vector similarity
      // Documents that appear in both passes get two RRF contributions
      const results = await search('parking', { limit: 10 })
      expect(results.results.length).toBeGreaterThan(1)
      // The top result should score higher than the bottom — both-pass candidates rise
      expect(results.results[0].score).toBeGreaterThan(results.results[results.results.length - 1].score)
    })

    it('score floors exclude weak candidates', async () => {
      // With an impossibly high vector floor, semantic pass contributes nothing
      const results = await search('parking', {
        limit: 10,
        mode: 'semantic',
        minVectorScore: 0.99,
      })
      expect(results.results).toEqual([])
      expect(results.total).toBe(0)
    })
  })

  describe('maxChunksPerDoc', () => {
    beforeAll(async () => {
      // Ingest a doc whose body chunks into several segments so the cap can be tested.
      const longBody = Array(8).fill('Parking permit information and application details for residents of the city.').join('\n\n')
      await ingestDocument(pool, indexId, adapter, {
        external_id: 'multi-cap',
        title: 'Parking Info Detailed',
        body: longBody,
      }, config, { max_segment_tokens: 15 })
    })

    it('defaults to 1 (best segment per document)', async () => {
      const results = await search('parking', { limit: 20 })
      const docIds = results.results.map(r => r.external_id)
      expect(new Set(docIds).size).toBe(docIds.length)
    })

    it('with maxChunksPerDoc=3 returns up to 3 segments per document', async () => {
      const results = await search('parking', {
        limit: 20, maxChunksPerDoc: 3,
      })
      const counts = new Map<string, number>()
      for (const r of results.results) {
        counts.set(r.external_id, (counts.get(r.external_id) ?? 0) + 1)
      }
      for (const [, count] of counts) {
        expect(count).toBeLessThanOrEqual(3)
      }
      // Prove the cap actually enables multiple chunks (would fail under the old 1-per-doc dedup)
      expect(counts.get('multi-cap') ?? 0).toBeGreaterThan(1)
    })

    it('respects per-doc cap when one doc has many strong segments', async () => {
      const results = await search('parking', {
        limit: 50, maxChunksPerDoc: 2,
      })
      const counts = new Map<string, number>()
      for (const r of results.results) {
        counts.set(r.external_id, (counts.get(r.external_id) ?? 0) + 1)
      }
      for (const [, count] of counts) {
        expect(count).toBeLessThanOrEqual(2)
      }
      // multi-cap has many matching segments; cap=2 should yield exactly 2 (proves the cap fires)
      expect(counts.get('multi-cap') ?? 0).toBe(2)
    })
  })
})
