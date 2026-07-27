// ABOUTME: Tests for the analytics event log: schema, capture, feedback postback, and pull.
// ABOUTME: Runs against the real test database; searches use mode=lexical (no Bedrock).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { Pool } from 'pg'
import { Hono } from 'hono'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { logQuery } from '../services/analytics'
import { searchRoutes } from '../routes/search'

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

describe('search capture', () => {
  let pool: Pool
  let searchKey: string

  beforeAll(async () => {
    process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost'
    process.env.DB_PORT = process.env.TEST_DB_PORT || '5433'
    process.env.DB_NAME = process.env.TEST_DB_NAME || 'pgsearch_test'
    process.env.DB_USER = process.env.TEST_DB_USER || 'pgsearch'
    process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'testpassword'

    await setupSchema()
    pool = await getTestPool()
    const created = await createIndex(pool, { name: 'analytics-capture-idx' })
    searchKey = created!.search_key
  })
  afterAll(async () => { await cleanupTestData(); await teardownSchema(); await closePool() })

  const app = new Hono()
  app.route('/', searchRoutes)

  const search = (query: string) =>
    app.request(`/public/search/analytics-capture-idx?${query}`, { headers: { 'x-search-key': searchKey } })

  it('logs the query and returns a query_id', async () => {
    const res = await search('q=water&mode=lexical&limit=5')
    expect(res.status).toBe(200)
    const body = await res.json() as { query_id?: string; total: number }
    expect(body.query_id).toMatch(/^[0-9a-f-]{36}$/)

    const row = await pool.query('SELECT * FROM search_events WHERE event_id = $1', [body.query_id])
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].action).toBe('search')
    expect(row.rows[0].data).toEqual({
      q: 'water', mode: 'lexical', kinds: null, limit: 5, total: 0, result_ids: [],
    })
  })

  // Must stay the LAST test in this block: it drops search_events and the only
  // way to get it back is a full teardown + setup — schema_migrations still
  // records version 10 after the DROP, so a bare setupSchema() would skip
  // recreating the table (runMigrations skips recorded versions). The rebuild
  // also wipes this block's index, which no later test in this block may rely on.
  it('returns results without query_id when the log insert fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await pool.query('DROP TABLE search_events CASCADE')
    try {
      const res = await search('q=water&mode=lexical')
      expect(res.status).toBe(200)
      const body = await res.json() as { query_id?: string; total: number; results: unknown[] }
      expect(body.query_id).toBeUndefined()
      expect(body.total).toBe(0)
      expect(body.results).toEqual([])
      expect(errors).toHaveBeenCalledOnce()
      expect(String(errors.mock.calls[0][0])).toContain('analytics')
    } finally {
      errors.mockRestore()
      await teardownSchema()
      await setupSchema()
    }
  })
})
