// ABOUTME: Unit tests for hot-path stat maintenance helpers (term set, stats, deltas).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { documentTermSet, documentStats, applyMaintenance } from '../services/stats'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

describe('stats helpers', () => {
  let pool: Pool
  let indexId: number
  const adapter = createTestAdapter(384)
  const config = mergeConfig({})
  beforeAll(async () => {
    await setupSchema(); pool = await getTestPool()
    await createIndex(pool, { name: 'stats' })
    indexId = (await pool.query("SELECT index_id FROM search_indexes WHERE name='stats'")).rows[0].index_id
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('documentTermSet returns distinct title+body lexemes', async () => {
    await ingestDocument(pool, indexId, adapter,
      { external_id: 't1', title: 'Parking Permits', body: 'Apply for a parking permit.' }, config)
    const docId = (await pool.query("SELECT document_id FROM search_documents WHERE external_id='t1'")).rows[0].document_id
    const client = await pool.connect()
    try {
      const terms = await documentTermSet(client, docId)
      expect(terms).toContain('park')   // 'parking' -> 'park' under english stemming
      expect(terms).toContain('permit')
      expect(new Set(terms).size).toBe(terms.length) // distinct
    } finally { client.release() }
  })

  it('documentStats returns title, body, and segment lengths', async () => {
    const docId = (await pool.query("SELECT document_id FROM search_documents WHERE external_id='t1'")).rows[0].document_id
    const client = await pool.connect()
    try {
      const s = await documentStats(client, docId)
      expect(s.titleLength).toBeGreaterThan(0)
      expect(s.bodyLength).toBeGreaterThan(0)
      expect(s.segments).toBeGreaterThan(0)
    } finally { client.release() }
  })

  it('documentStats returns zeros for an unknown document', async () => {
    const client = await pool.connect()
    try {
      const s = await documentStats(client, '00000000-0000-0000-0000-000000000000')
      expect(s).toEqual({ titleLength: 0, bodyLength: 0, segments: 0 })
    } finally { client.release() }
  })

  it('applyMaintenance adds and removes DF and updates sums + averages', async () => {
    const idxCols =
      'SELECT total_title_length, total_body_length, total_segments, total_documents, avg_title_length, avg_body_length FROM search_indexes WHERE index_id=$1'
    const before = (await pool.query(idxCols, [indexId])).rows[0]

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await applyMaintenance(client, {
        indexId, oldTerms: [], newTerms: ['alpha', 'beta'],
        deltaTitle: 2, deltaBody: 4, deltaSegments: 1,
      })
      await client.query('COMMIT')
    } finally { client.release() }
    const df = await pool.query(
      "SELECT term, document_frequency FROM term_document_frequencies WHERE index_id=$1 AND term=ANY($2) ORDER BY term",
      [indexId, ['alpha', 'beta']])
    expect(df.rows).toEqual([
      { term: 'alpha', document_frequency: 1 },
      { term: 'beta', document_frequency: 1 },
    ])

    // Sums move by exactly the deltas; averages are recomputed from the sums.
    const afterAdd = (await pool.query(idxCols, [indexId])).rows[0]
    expect(Number(afterAdd.total_title_length)).toBe(Number(before.total_title_length) + 2)
    expect(Number(afterAdd.total_body_length)).toBe(Number(before.total_body_length) + 4)
    expect(Number(afterAdd.total_segments)).toBe(Number(before.total_segments) + 1)
    const docs = Number(afterAdd.total_documents)
    if (docs > 0) {
      expect(Number(afterAdd.avg_title_length)).toBeCloseTo(Number(afterAdd.total_title_length) / docs)
    }
    const segs = Number(afterAdd.total_segments)
    if (segs > 0) {
      expect(Number(afterAdd.avg_body_length)).toBeCloseTo(Number(afterAdd.total_body_length) / segs)
    }

    // Remove 'beta' -> its row drops to 0 and is deleted.
    const client2 = await pool.connect()
    try {
      await client2.query('BEGIN')
      await applyMaintenance(client2, {
        indexId, oldTerms: ['beta'], newTerms: [],
        deltaTitle: 0, deltaBody: 0, deltaSegments: 0,
      })
      await client2.query('COMMIT')
    } finally { client2.release() }
    const after = await pool.query(
      "SELECT term FROM term_document_frequencies WHERE index_id=$1 AND term='beta'", [indexId])
    expect(after.rows).toHaveLength(0)
  })
})
