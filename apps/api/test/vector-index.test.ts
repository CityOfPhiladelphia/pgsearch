// ABOUTME: Verifies the vector pass matches the per-index HNSW expression index.
// ABOUTME: Asserts planner index usage via EXPLAIN and candidate correctness through the query path.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { vectorCandidates, vectorCandidatesSql } from '../services/search'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

describe('vector index usage', () => {
  let pool: Pool
  let indexId: number
  const adapter = createTestAdapter(384)
  const config = mergeConfig({})

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    await createIndex(pool, { name: 'vector-index-test', config: { embedding: { dimensions: 384 } } as any })
    const row = await pool.query("SELECT index_id FROM search_indexes WHERE name = 'vector-index-test'")
    indexId = row.rows[0].index_id

    for (let i = 0; i < 5; i++) {
      await ingestDocument(pool, indexId, adapter, {
        external_id: `doc-${i}`,
        title: `Document ${i}`,
        body: `Content for document number ${i} about topic ${i}.`,
      }, config)
    }
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('the query expression matches the per-index HNSW index', async () => {
    const embedding = (await adapter.embed(['topic 2']))[0]
    const embeddingStr = `[${embedding.join(',')}]`
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Disable the competing plans (seq scan; btree-bitmap + sort) so the assertion
      // proves expression matchability rather than a corpus-size-dependent cost choice.
      await client.query('SET LOCAL enable_seqscan = off')
      await client.query('SET LOCAL enable_sort = off')
      const plan = await client.query(
        `EXPLAIN (FORMAT JSON) ${vectorCandidatesSql(384)}`,
        [embeddingStr, indexId, 10],
      )
      await client.query('COMMIT')
      const planText = JSON.stringify(plan.rows[0]['QUERY PLAN'])
      expect(planText).toContain(`idx_segments_embedding_${indexId}`)
    } finally {
      client.release()
    }
  })

  it('returns candidates ordered by similarity through the indexed path', async () => {
    const embedding = (await adapter.embed(['topic 3']))[0]
    const candidates = await vectorCandidates(pool, indexId, 384, embedding, 5)
    expect(candidates.length).toBeGreaterThan(0)
    const sims = candidates.map(c => c.similarity)
    expect([...sims].sort((a, b) => b - a)).toEqual(sims)
  })

  it('rejects a non-integer dimension', async () => {
    const embedding = (await adapter.embed(['topic 1']))[0]
    await expect(vectorCandidates(pool, indexId, 384.5, embedding, 5)).rejects.toThrow()
  })
})
