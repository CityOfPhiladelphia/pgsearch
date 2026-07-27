// ABOUTME: Tests for the analytics event log: schema, capture, feedback postback, and pull.
// ABOUTME: Runs against the real test database; searches use mode=lexical (no Bedrock).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { logQuery } from '../services/analytics'

describe('analytics schema', () => {
  let pool: Pool

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
  })
  afterAll(async () => { await cleanupTestData(); await teardownSchema(); await closePool() })

  it('creates search_events with the expected columns', async () => {
    const result = await pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'search_events' ORDER BY column_name`,
    )
    const columns = Object.fromEntries(result.rows.map(r => [r.column_name, r.is_nullable]))
    expect(columns).toEqual({
      action: 'NO',
      created_at: 'NO',
      data: 'NO',
      event_id: 'NO',
      index_id: 'NO',
      query_id: 'YES',
    })
  })

  it('adds analytics_key_hash to search_indexes', async () => {
    const result = await pool.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'search_indexes' AND column_name = 'analytics_key_hash'`,
    )
    expect(result.rows).toEqual([{ is_nullable: 'YES' }])
  })
})

describe('logQuery', () => {
  let pool: Pool
  let indexId: number

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    await createIndex(pool, { name: 'analytics-svc-idx' })
    const row = await pool.query(`SELECT index_id FROM search_indexes WHERE name = 'analytics-svc-idx'`)
    indexId = row.rows[0].index_id
  })
  afterAll(async () => { await cleanupTestData(); await teardownSchema(); await closePool() })

  it('inserts a query row and returns its event_id', async () => {
    const data = { q: 'parking permit', mode: 'lexical', kinds: null, limit: 10, total: 2, result_ids: ['a', 'b'] }
    const eventId = await logQuery(pool, indexId, data)

    const row = await pool.query('SELECT * FROM search_events WHERE event_id = $1', [eventId])
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].index_id).toBe(indexId)
    expect(row.rows[0].query_id).toBeNull()
    expect(row.rows[0].action).toBe('search')
    expect(row.rows[0].data).toEqual(data)
  })
})
