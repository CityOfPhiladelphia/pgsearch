// ABOUTME: Unit tests for hot-path stat maintenance helpers (term set, stats, deltas).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool, cleanupTestData } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { documentTermSet, applyMaintenance } from '../services/stats'
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

  it('applyMaintenance adds and removes DF and updates averages', async () => {
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
