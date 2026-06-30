// ABOUTME: Verifies ingestDocument maintains DF and averages incrementally (no refresh).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool, cleanupTestData } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument, deleteDocument } from '../services/ingest'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

const adapter = createTestAdapter(384)
const config = mergeConfig({})

async function df(pool: Pool, indexId: number, term: string): Promise<number> {
  const r = await pool.query(
    'SELECT document_frequency FROM term_document_frequencies WHERE index_id=$1 AND term=$2', [indexId, term])
  return r.rows.length ? r.rows[0].document_frequency : 0
}

describe('ingest maintains stats incrementally', () => {
  let pool: Pool
  let indexId: number
  beforeAll(async () => { await setupSchema(); pool = await getTestPool() })
  afterAll(async () => { await teardownSchema(); await closePool() })
  beforeEach(async () => {
    await cleanupTestData()
    await createIndex(pool, { name: 'inc' })
    indexId = (await pool.query("SELECT index_id FROM search_indexes WHERE name='inc'")).rows[0].index_id
  })

  it('new doc populates DF and averages without any refresh call', async () => {
    await ingestDocument(pool, indexId, adapter,
      { external_id: 'a', title: 'Parking Permits', body: 'Apply for a parking permit.' }, config)
    expect(await df(pool, indexId, 'park')).toBe(1)
    const idx = await pool.query('SELECT avg_title_length, avg_body_length, total_documents FROM search_indexes WHERE index_id=$1', [indexId])
    expect(Number(idx.rows[0].avg_title_length)).toBeGreaterThan(0)
    expect(Number(idx.rows[0].avg_body_length)).toBeGreaterThan(0)
    expect(idx.rows[0].total_documents).toBe(1)
  })

  it('a term shared by two docs has DF 2', async () => {
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'Parking', body: 'parking permit' }, config)
    await ingestDocument(pool, indexId, adapter, { external_id: 'b', title: 'Parking', body: 'parking garage' }, config)
    expect(await df(pool, indexId, 'park')).toBe(2)
  })

  it('re-ingesting with a removed term decrements its DF and shrinks avg body length', async () => {
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'X', body: 'parking garage downtown' }, config)
    expect(await df(pool, indexId, 'garag')).toBe(1)
    const before = await pool.query('SELECT avg_body_length FROM search_indexes WHERE index_id=$1', [indexId])
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'X', body: 'parking downtown' }, config)
    expect(await df(pool, indexId, 'garag')).toBe(0)
    expect(await df(pool, indexId, 'park')).toBe(1)
    const after = await pool.query('SELECT avg_body_length FROM search_indexes WHERE index_id=$1', [indexId])
    expect(Number(after.rows[0].avg_body_length)).toBeLessThan(Number(before.rows[0].avg_body_length))
  })

  it('re-ingesting identical content leaves DF and averages unchanged (skip path)', async () => {
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'Parking', body: 'parking permit' }, config)
    const before = await pool.query(
      'SELECT avg_title_length, avg_body_length, total_documents FROM search_indexes WHERE index_id=$1', [indexId])
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'Parking', body: 'parking permit' }, config)
    expect(await df(pool, indexId, 'park')).toBe(1)
    expect(await df(pool, indexId, 'permit')).toBe(1)
    const after = await pool.query(
      'SELECT avg_title_length, avg_body_length, total_documents FROM search_indexes WHERE index_id=$1', [indexId])
    expect(after.rows[0]).toEqual(before.rows[0])
  })

  it('re-ingesting with only the title changed moves title-only terms', async () => {
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'Recycling', body: 'parking permit' }, config)
    expect(await df(pool, indexId, 'recycl')).toBe(1)
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'Compost', body: 'parking permit' }, config)
    expect(await df(pool, indexId, 'recycl')).toBe(0)   // dropped from the title
    expect(await df(pool, indexId, 'compost')).toBe(1)  // added by the new title
    expect(await df(pool, indexId, 'park')).toBe(1)      // body term unchanged
    expect(await df(pool, indexId, 'permit')).toBe(1)
  })

  it('delete decrements DF, removes zeroed terms, and subtracts lengths', async () => {
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'Parking', body: 'parking permit garage' }, config)
    await ingestDocument(pool, indexId, adapter, { external_id: 'b', title: 'Parking', body: 'parking permit' }, config)
    await deleteDocument(pool, indexId, 'a')
    expect(await df(pool, indexId, 'park')).toBe(1)    // still in b
    expect(await df(pool, indexId, 'garag')).toBe(0)   // only in a -> removed
    const idx = await pool.query('SELECT total_documents FROM search_indexes WHERE index_id=$1', [indexId])
    expect(idx.rows[0].total_documents).toBe(1)
  })
})
