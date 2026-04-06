// ABOUTME: Tests for materialized view refresh and corpus statistics recomputation.
// ABOUTME: Verifies term frequency population, avg length updates, counter reset, and threshold triggering.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { refreshIndex, checkAndRefresh } from '../services/refresh'
import { createTestAdapter } from '@phila/search-embeddings'
import type { Pool } from 'pg'

describe('materialized view refresh', () => {
  let pool: Pool
  let indexId: number
  const adapter = createTestAdapter(384)

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    const result = await createIndex(pool, { name: 'refresh-test', config: { refresh_threshold: 2 } })
    const row = await pool.query("SELECT index_id FROM search_indexes WHERE name = 'refresh-test'")
    indexId = row.rows[0].index_id

    await ingestDocument(pool, indexId, adapter, {
      external_id: 'doc-a',
      title: 'Parking Permits',
      body: 'Apply for a residential parking permit.',
    })
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('populates term_document_frequencies after refresh', async () => {
    await refreshIndex(pool, indexId)
    const tdf = await pool.query('SELECT * FROM term_document_frequencies WHERE index_id = $1', [indexId])
    expect(tdf.rows.length).toBeGreaterThan(0)
  })

  it('updates avg_title_length and avg_body_length on the index', async () => {
    await refreshIndex(pool, indexId)
    const idx = await pool.query('SELECT avg_title_length, avg_body_length FROM search_indexes WHERE index_id = $1', [indexId])
    expect(idx.rows[0].avg_title_length).toBeGreaterThan(0)
    expect(idx.rows[0].avg_body_length).toBeGreaterThan(0)
  })

  it('resets docs_changed_since_refresh after refresh', async () => {
    await refreshIndex(pool, indexId)
    const idx = await pool.query('SELECT docs_changed_since_refresh FROM search_indexes WHERE index_id = $1', [indexId])
    expect(idx.rows[0].docs_changed_since_refresh).toBe(0)
  })

  it('sets last_refreshed_at after refresh', async () => {
    await refreshIndex(pool, indexId)
    const idx = await pool.query('SELECT last_refreshed_at FROM search_indexes WHERE index_id = $1', [indexId])
    expect(idx.rows[0].last_refreshed_at).not.toBeNull()
  })

  it('checkAndRefresh triggers when threshold is met', async () => {
    await pool.query('UPDATE search_indexes SET docs_changed_since_refresh = 2 WHERE index_id = $1', [indexId])
    await checkAndRefresh(pool, indexId, 2)
    const idx = await pool.query('SELECT docs_changed_since_refresh, last_refreshed_at FROM search_indexes WHERE index_id = $1', [indexId])
    expect(idx.rows[0].docs_changed_since_refresh).toBe(0)
  })

  it('checkAndRefresh does NOT trigger when below threshold', async () => {
    await pool.query('UPDATE search_indexes SET docs_changed_since_refresh = 1, last_refreshed_at = NULL WHERE index_id = $1', [indexId])
    await checkAndRefresh(pool, indexId, 5)
    const idx = await pool.query('SELECT docs_changed_since_refresh, last_refreshed_at FROM search_indexes WHERE index_id = $1', [indexId])
    expect(idx.rows[0].docs_changed_since_refresh).toBe(1)
    expect(idx.rows[0].last_refreshed_at).toBeNull()
  })
})
