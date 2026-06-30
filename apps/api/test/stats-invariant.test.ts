// ABOUTME: After an arbitrary ingest/delete sequence, reconcile must produce zero changes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool, cleanupTestData } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument, deleteDocument } from '../services/ingest'
import { reconcileIndex } from '../services/reconcile'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

const adapter = createTestAdapter(384)
const config = mergeConfig({})

async function snapshot(pool: Pool, indexId: number) {
  const df = await pool.query(
    'SELECT term, document_frequency FROM term_document_frequencies WHERE index_id=$1 ORDER BY term', [indexId])
  const idx = await pool.query(
    'SELECT total_title_length, total_body_length, total_segments, total_documents, avg_title_length, avg_body_length FROM search_indexes WHERE index_id=$1', [indexId])
  return { df: df.rows, idx: idx.rows[0] }
}

describe('incremental maintenance equals from-scratch reconcile', () => {
  let pool: Pool
  let indexId: number
  beforeAll(async () => {
    await setupSchema(); pool = await getTestPool()
    await createIndex(pool, { name: 'inv' })
    indexId = (await pool.query("SELECT index_id FROM search_indexes WHERE name='inv'")).rows[0].index_id

    // Arbitrary sequence: inserts, an update (term added + removed), a delete.
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'Parking Permits', body: 'parking permit garage downtown' }, config)
    await ingestDocument(pool, indexId, adapter, { external_id: 'b', title: 'Trash Pickup', body: 'trash recycling schedule' }, config)
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'Parking', body: 'parking permit residential' }, config) // update
    await ingestDocument(pool, indexId, adapter, { external_id: 'c', title: 'Permits', body: 'building permit application' }, config)
    await deleteDocument(pool, indexId, 'b')
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('reconcile changes nothing', async () => {
    const before = await snapshot(pool, indexId)
    await reconcileIndex(pool, indexId)
    const after = await snapshot(pool, indexId)
    expect(after.df).toEqual(before.df)
    expect(after.idx).toEqual(before.idx)
  })
})
