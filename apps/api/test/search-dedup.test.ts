// ABOUTME: Integration tests for query-time collapse of duplicate content across documents.
// ABOUTME: Mirror documents (identical text at different external_ids) return once, by segment content hash.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { createIndex, getIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { hybridSearch, type HybridSearchOptions } from '../services/search'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

describe('duplicate content collapse', () => {
  let pool: Pool
  let indexId: number
  const adapter = createTestAdapter(384)
  const config = mergeConfig({})

  const search = async (queryText: string, options: HybridSearchOptions = {}) =>
    hybridSearch(pool, (await getIndex(pool, 'dedup-test'))!, adapter, queryText, options)

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    await createIndex(pool, { name: 'dedup-test' })
    const row = await pool.query("SELECT index_id FROM search_indexes WHERE name = 'dedup-test'")
    indexId = row.rows[0].index_id

    const mirrorBody = 'Pay your water bill online, by mail, or in person at the Municipal Services Building.'
    // The same page published under two category paths — identical title and body
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'https://example.gov/services/water/pay-water-bill/',
      title: 'Pay a water bill',
      body: mirrorBody,
    }, config)
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'https://example.gov/payments/pay-water-bill/',
      title: 'Pay a water bill',
      body: mirrorBody,
    }, config)
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'https://example.gov/services/water/dispute-water-bill/',
      title: 'Dispute a water bill',
      body: 'If you believe your water bill is incorrect, you can file a dispute with the Water Revenue Bureau.',
    }, config)
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('returns mirror documents once in hybrid mode', async () => {
    const response = await search('pay water bill')
    const snippets = response.results.map(r => r.snippet)
    expect(new Set(snippets).size).toBe(snippets.length)
    const mirrors = response.results.filter(r => r.external_id.includes('pay-water-bill'))
    expect(mirrors).toHaveLength(1)
  })

  it('collapses in bm25 and semantic modes too', async () => {
    for (const mode of ['bm25', 'semantic'] as const) {
      const response = await search('pay water bill', { mode })
      const mirrors = response.results.filter(r => r.external_id.includes('pay-water-bill'))
      expect(mirrors, mode).toHaveLength(1)
    }
  })

  it('keeps distinct documents intact', async () => {
    const response = await search('water bill')
    const ids = response.results.map(r => r.external_id)
    expect(ids.some(id => id.includes('dispute-water-bill'))).toBe(true)
    expect(ids.some(id => id.includes('pay-water-bill'))).toBe(true)
  })

  it('total counts collapsed documents once', async () => {
    const response = await search('pay water bill')
    expect(response.total).toBe(response.results.length)
  })

  it('does not repeat chunks across mirror documents for RAG callers', async () => {
    const response = await search('pay water bill', { maxChunksPerDoc: 3, limit: 10 })
    const snippets = response.results.map(r => r.snippet)
    expect(new Set(snippets).size).toBe(snippets.length)
  })
})
