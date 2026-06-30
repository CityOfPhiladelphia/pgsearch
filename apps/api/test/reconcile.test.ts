// ABOUTME: Verifies reconcile_index_stats recomputes DF + averages from source.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { reconcileIndex } from '../services/reconcile'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

describe('reconcileIndex', () => {
  let pool: Pool
  let indexId: number
  const adapter = createTestAdapter(384)
  const config = mergeConfig({})
  beforeAll(async () => {
    await setupSchema(); pool = await getTestPool()
    await createIndex(pool, { name: 'recon' })
    indexId = (await pool.query("SELECT index_id FROM search_indexes WHERE name='recon'")).rows[0].index_id
    await ingestDocument(pool, indexId, adapter,
      { external_id: 'd1', title: 'Parking Permits', body: 'Apply for a residential parking permit today.' }, config)
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('rebuilds DF and averages from source', async () => {
    // Corrupt the maintained state, then reconcile should restore it.
    await pool.query('DELETE FROM term_document_frequencies WHERE index_id = $1', [indexId])
    await pool.query('UPDATE search_indexes SET avg_title_length = 0, avg_body_length = 0 WHERE index_id = $1', [indexId])

    await reconcileIndex(pool, indexId)

    const tdf = await pool.query('SELECT COUNT(*)::int AS n FROM term_document_frequencies WHERE index_id = $1', [indexId])
    expect(tdf.rows[0].n).toBeGreaterThan(0)
    const idx = await pool.query('SELECT avg_title_length, avg_body_length FROM search_indexes WHERE index_id = $1', [indexId])
    expect(Number(idx.rows[0].avg_title_length)).toBeGreaterThan(0)
    expect(Number(idx.rows[0].avg_body_length)).toBeGreaterThan(0)
  })
})
