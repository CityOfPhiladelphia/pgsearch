// ABOUTME: Tests for the analytics event log: schema, capture, feedback postback, and pull.
// ABOUTME: Runs against the real test database; searches use mode=lexical (no Bedrock).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'

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
