// ABOUTME: Tests for the analytics event log: schema, capture, feedback postback, and pull.
// ABOUTME: Runs against the real test database; searches use mode=lexical (no Bedrock).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { Pool } from 'pg'
import { Hono } from 'hono'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { logQuery, logEvent } from '../services/analytics'
import { searchRoutes } from '../routes/search'
import { adminRoutes } from '../routes/admin'
import { analyticsRoutes } from '../routes/analytics'
import { ValidationError } from '../middleware/validate'
import { apiError } from '../middleware/error'

describe('analytics schema', () => {
  let pool: Pool

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
  })
  afterAll(async () => { await cleanupTestData(); await teardownSchema(); await closePool() })

  it('creates events with the expected columns', async () => {
    const result = await pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'events' ORDER BY column_name`,
    )
    const columns = Object.fromEntries(result.rows.map(r => [r.column_name, r.is_nullable]))
    expect(columns).toEqual({
      action: 'NO',
      created_at: 'NO',
      data: 'NO',
      event_id: 'NO',
      group_id: 'NO',
      index_id: 'NO',
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

    const row = await pool.query('SELECT * FROM events WHERE event_id = $1', [eventId])
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].index_id).toBe(indexId)
    expect(row.rows[0].group_id).toBe(eventId)
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

  it('logs the query and returns a group_id', async () => {
    const res = await search('q=water&mode=lexical&limit=5')
    expect(res.status).toBe(200)
    const body = await res.json() as { group_id?: string; total: number }
    expect(body.group_id).toMatch(/^[0-9a-f-]{36}$/)

    const row = await pool.query('SELECT * FROM events WHERE event_id = $1', [body.group_id])
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].action).toBe('search')
    expect(row.rows[0].data).toEqual({
      q: 'water', mode: 'lexical', kinds: null, limit: 5, total: 0, result_ids: [],
    })
  })

  // Must stay the LAST test in this block: it drops events and the only
  // way to get it back is a full teardown + setup — schema_migrations still
  // records version 10 after the DROP, so a bare setupSchema() would skip
  // recreating the table (runMigrations skips recorded versions). The rebuild
  // also wipes this block's index, which no later test in this block may rely on.
  it('returns results without group_id when the log insert fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await pool.query('DROP TABLE events CASCADE')
    try {
      const res = await search('q=water&mode=lexical')
      expect(res.status).toBe(200)
      const body = await res.json() as { group_id?: string; total: number; results: unknown[] }
      expect(body.group_id).toBeUndefined()
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

describe('feedback postback', () => {
  let pool: Pool
  let searchKey: string
  let otherSearchKey: string
  let groupId: string

  const app = new Hono()
  app.route('/', searchRoutes)
  app.onError((err, c) => {
    if (err instanceof ValidationError) {
      return apiError(c, 'VALIDATION_ERROR', err.message)
    }
    console.error('Unhandled error:', err)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
  })

  beforeAll(async () => {
    process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost'
    process.env.DB_PORT = process.env.TEST_DB_PORT || '5433'
    process.env.DB_NAME = process.env.TEST_DB_NAME || 'pgsearch_test'
    process.env.DB_USER = process.env.TEST_DB_USER || 'pgsearch'
    process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'testpassword'

    await setupSchema()
    pool = await getTestPool()
    const created = await createIndex(pool, { name: 'analytics-fb-idx' })
    searchKey = created!.search_key
    const other = await createIndex(pool, { name: 'analytics-fb-other' })
    otherSearchKey = other!.search_key

    const res = await app.request('/public/search/analytics-fb-idx?q=water&mode=lexical', {
      headers: { 'x-search-key': searchKey },
    })
    groupId = ((await res.json()) as { group_id: string }).group_id
  })
  afterAll(async () => { await cleanupTestData(); await teardownSchema(); await closePool() })

  const post = (body: unknown, key = searchKey, index = 'analytics-fb-idx') =>
    app.request(`/public/search/${index}/events`, {
      method: 'POST',
      headers: { 'x-search-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('records a feedback event against a query row', async () => {
    const res = await post({ group_id: groupId, action: 'selected', data: { external_id: 'page-1', rank: 3 } })
    expect(res.status).toBe(201)
    const body = await res.json() as { event_id: string }

    const row = await pool.query('SELECT * FROM events WHERE event_id = $1', [body.event_id])
    expect(row.rows[0].group_id).toBe(groupId)
    expect(row.rows[0].action).toBe('selected')
    expect(row.rows[0].data).toEqual({ external_id: 'page-1', rank: 3 })
    // index_id copied from the anchor event
    const parent = await pool.query('SELECT index_id FROM events WHERE event_id = $1', [groupId])
    expect(row.rows[0].index_id).toBe(parent.rows[0].index_id)
  })

  it('404s an unknown group_id', async () => {
    const res = await post({ group_id: '00000000-0000-0000-0000-000000000000', action: 'selected' })
    expect(res.status).toBe(404)
  })

  it('404s a group_id belonging to another index', async () => {
    const res = await post({ group_id: groupId, action: 'selected' }, otherSearchKey, 'analytics-fb-other')
    expect(res.status).toBe(404)
  })

  it('404s a group_id that points at a feedback row, not an anchor', async () => {
    const first = await post({ group_id: groupId, action: 'selected' })
    expect(first.status).toBe(201)
    const { event_id } = await first.json() as { event_id: string }
    const stored = await pool.query('SELECT data FROM events WHERE event_id = $1', [event_id])
    expect(stored.rows[0].data).toEqual({})
    const res = await post({ group_id: event_id, action: 'selected' })
    expect(res.status).toBe(404)
  })

  it('400s a missing action', async () => {
    const res = await post({ group_id: groupId })
    expect(res.status).toBe(400)
  })

  it('400s an action over 64 characters', async () => {
    const res = await post({ group_id: groupId, action: 'a'.repeat(65) })
    expect(res.status).toBe(400)
  })

  it('400s a non-uuid group_id', async () => {
    const res = await post({ group_id: 'not-a-uuid', action: 'selected' })
    expect(res.status).toBe(400)
  })

  it('400s data over 4KB serialized', async () => {
    const res = await post({ group_id: groupId, action: 'selected', data: { blob: 'x'.repeat(5000) } })
    expect(res.status).toBe(400)
  })

  it('400s data over 4KB in bytes even when under 4096 characters', async () => {
    const res = await post({ group_id: groupId, action: 'selected', data: { blob: '水'.repeat(2000) } })
    expect(res.status).toBe(400)
  })

  it('401s without a search key', async () => {
    const res = await app.request('/public/search/analytics-fb-idx/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_id: groupId, action: 'selected' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('analytics key admin', () => {
  let pool: Pool

  const app = new Hono()
  app.route('/', adminRoutes)

  beforeAll(async () => {
    process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost'
    process.env.DB_PORT = process.env.TEST_DB_PORT || '5433'
    process.env.DB_NAME = process.env.TEST_DB_NAME || 'pgsearch_test'
    process.env.DB_USER = process.env.TEST_DB_USER || 'pgsearch'
    process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'testpassword'

    await setupSchema()
    pool = await getTestPool()
    await createIndex(pool, { name: 'analytics-key-idx' })
  })
  afterAll(async () => { await cleanupTestData(); await teardownSchema(); await closePool() })

  it('mints an anly_-prefixed analytics key and stores its hash', async () => {
    const res = await app.request('/private/key/admin/indexes/analytics-key-idx/analytics-key', { method: 'POST' })
    expect(res.status).toBe(201)
    const body = await res.json() as { analytics_key: string }
    expect(body.analytics_key).toMatch(/^anly_/)

    const row = await pool.query(`SELECT analytics_key_hash FROM search_indexes WHERE name = 'analytics-key-idx'`)
    expect(row.rows[0].analytics_key_hash).not.toBeNull()
  })

  it('revokes the analytics key', async () => {
    await app.request('/private/key/admin/indexes/analytics-key-idx/analytics-key', { method: 'POST' })
    const res = await app.request('/private/key/admin/indexes/analytics-key-idx/analytics-key', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const row = await pool.query(`SELECT analytics_key_hash FROM search_indexes WHERE name = 'analytics-key-idx'`)
    expect(row.rows[0].analytics_key_hash).toBeNull()
  })

  it('404s minting for a missing index', async () => {
    const res = await app.request('/private/key/admin/indexes/nope/analytics-key', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('analytics pull', () => {
  let pool: Pool
  let indexId: number
  let analyticsKey: string
  let groupIds: string[] = []

  const app = new Hono()
  app.route('/', analyticsRoutes)

  const adminApp = new Hono()
  adminApp.route('/', adminRoutes)

  beforeAll(async () => {
    process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost'
    process.env.DB_PORT = process.env.TEST_DB_PORT || '5433'
    process.env.DB_NAME = process.env.TEST_DB_NAME || 'pgsearch_test'
    process.env.DB_USER = process.env.TEST_DB_USER || 'pgsearch'
    process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'testpassword'

    await setupSchema()
    pool = await getTestPool()
    await createIndex(pool, { name: 'analytics-pull-idx' })
    const idxRow = await pool.query(`SELECT index_id FROM search_indexes WHERE name = 'analytics-pull-idx'`)
    indexId = idxRow.rows[0].index_id

    const mint = await adminApp.request('/private/key/admin/indexes/analytics-pull-idx/analytics-key', { method: 'POST' })
    analyticsKey = ((await mint.json()) as { analytics_key: string }).analytics_key

    // 5 query rows, one with a feedback child → 6 events total
    groupIds = []
    for (let i = 0; i < 5; i++) {
      groupIds.push(await logQuery(pool, indexId, { q: `query ${i}`, total: 0, result_ids: [] }))
    }
    await logEvent(pool, indexId, groupIds[0], 'selected', { external_id: 'x', rank: 1 })
  })
  afterAll(async () => { await cleanupTestData(); await teardownSchema(); await closePool() })

  const pull = (qs = '', key = analyticsKey) =>
    app.request(`/public/analytics/analytics-pull-idx/events${qs ? `?${qs}` : ''}`, {
      headers: { 'x-analytics-key': key },
    })

  it('returns flat rows of both shapes in created_at order', async () => {
    const res = await pull()
    expect(res.status).toBe(200)
    const body = await res.json() as { events: any[]; next: string | null }
    expect(body.events).toHaveLength(6)
    expect(body.next).toBeNull()
    const actions = body.events.map(e => e.action)
    expect(actions.filter(a => a === 'search')).toHaveLength(5)
    expect(actions.filter(a => a === 'selected')).toHaveLength(1)
    const feedback = body.events.find(e => e.action === 'selected')
    expect(feedback.group_id).toBe(groupIds[0])
    const anchor = body.events.find(e => e.action === 'search')
    expect(anchor.group_id).toBe(anchor.event_id)
    // row shape: index_id omitted
    expect(Object.keys(body.events[0]).sort()).toEqual(['action', 'created_at', 'data', 'event_id', 'group_id'])
  })

  it('walks every row exactly once across pages', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const res = await pull(`limit=2${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`)
      const body = await res.json() as { events: any[]; next: string | null }
      seen.push(...body.events.map(e => e.event_id))
      cursor = body.next
      if (!cursor) break
    }
    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(6)
  })

  it('filters by half-open date range', async () => {
    const mid = await pool.query(
      `SELECT created_at::text AS ts FROM events ORDER BY created_at, event_id OFFSET 3 LIMIT 1`,
    )
    const ts = mid.rows[0].ts
    const before = await pull(`to=${encodeURIComponent(ts)}`)
    const after = await pull(`from=${encodeURIComponent(ts)}`)
    const beforeBody = await before.json() as { events: any[] }
    const afterBody = await after.json() as { events: any[] }
    expect(beforeBody.events.length + afterBody.events.length).toBe(6)
    expect(beforeBody.events).toHaveLength(3)   // to is exclusive
  })

  it('walks a from-filtered range exactly once across pages', async () => {
    const mid = await pool.query(
      `SELECT created_at::text AS ts FROM events ORDER BY created_at, event_id OFFSET 3 LIMIT 1`,
    )
    const ts = mid.rows[0].ts
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const qs = `limit=2&from=${encodeURIComponent(ts)}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`
      const res = await pull(qs)
      const body = await res.json() as { events: any[]; next: string | null }
      seen.push(...body.events.map(e => e.event_id))
      cursor = body.next
      if (!cursor) break
    }
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
  })

  it('removes feedback rows when their query row is deleted', async () => {
    const doomed = await logQuery(pool, indexId, { q: 'doomed', total: 0, result_ids: [] })
    await logEvent(pool, indexId, doomed, 'selected', {})
    await pool.query('DELETE FROM events WHERE event_id = $1', [doomed])
    const orphans = await pool.query('SELECT * FROM events WHERE group_id = $1', [doomed])
    expect(orphans.rows).toHaveLength(0)
  })

  it('400s an unparseable from', async () => {
    const res = await pull('from=purple')
    expect(res.status).toBe(400)
  })

  it('accepts Postgres relative timestamps like yesterday', async () => {
    const res = await pull('from=yesterday')
    expect(res.status).toBe(200)
    const body = await res.json() as { events: unknown[] }
    expect(body.events).toHaveLength(6)   // all rows were inserted moments ago
  })

  it('400s a malformed after cursor', async () => {
    const res = await pull('after=garbage')
    expect(res.status).toBe(400)
  })

  it('401s with no analytics key minted', async () => {
    await createIndex(pool, { name: 'analytics-pull-nokey' })
    const res = await app.request('/public/analytics/analytics-pull-nokey/events', {
      headers: { 'x-analytics-key': analyticsKey },
    })
    expect(res.status).toBe(401)
  })

  it('401s a wrong key', async () => {
    const res = await pull('', 'anly_wrong')
    expect(res.status).toBe(401)
  })

  it('400s a well-formed cursor with garbage contents', async () => {
    const token = Buffer.from(JSON.stringify(['x', 'y'])).toString('base64url')
    const res = await pull(`after=${token}`)
    expect(res.status).toBe(400)
  })

  it('400s a from value Date.parse accepts but Postgres would not', async () => {
    const res = await pull('from=1')
    expect(res.status).toBe(400)
  })

  it('400s an impossible calendar date instead of rolling it over', async () => {
    const res = await pull('from=2026-02-30')
    expect(res.status).toBe(400)
  })

  it('400s a cursor whose timestamp is not in issued format', async () => {
    const token = Buffer.from(JSON.stringify(['1', '00000000-0000-0000-0000-000000000000'])).toString('base64url')
    const res = await pull(`after=${token}`)
    expect(res.status).toBe(400)
  })

  it('scopes a pull to the authenticated index only', async () => {
    await createIndex(pool, { name: 'analytics-pull-other' })
    const otherIdxRow = await pool.query(`SELECT index_id FROM search_indexes WHERE name = 'analytics-pull-other'`)
    const otherIndexId = otherIdxRow.rows[0].index_id
    const otherMint = await adminApp.request('/private/key/admin/indexes/analytics-pull-other/analytics-key', { method: 'POST' })
    const otherKey = ((await otherMint.json()) as { analytics_key: string }).analytics_key
    await logQuery(pool, otherIndexId, { q: 'other index query', total: 0, result_ids: [] })

    const res = await app.request('/public/analytics/analytics-pull-other/events', {
      headers: { 'x-analytics-key': otherKey },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { events: any[]; next: string | null }
    expect(body.events).toHaveLength(1)
    expect(body.events[0].data).toEqual({ q: 'other index query', total: 0, result_ids: [] })
  })

  // Must stay the LAST test in this block: it seeds 600 extra rows, which would
  // break the earlier tests' row-count assertions if it ran before them.
  it('clamps limit to 500', async () => {
    await pool.query(
      `INSERT INTO events (event_id, group_id, index_id, action, data)
       SELECT id, id, $1, 'search', '{}'
       FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 600)) g`,
      [indexId],
    )
    const res = await pull('limit=9999')
    expect(res.status).toBe(200)
    const body = await res.json() as { events: any[]; next: string | null }
    expect(body.events).toHaveLength(500)
    expect(body.next).not.toBeNull()

    const res2 = await pull(`limit=9999&after=${encodeURIComponent(body.next!)}`)
    expect(res2.status).toBe(200)
    const body2 = await res2.json() as { events: any[]; next: string | null }
    expect(body2.events).toHaveLength(106)
    expect(body2.next).toBeNull()
  })
})
