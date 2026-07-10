// ABOUTME: Tests for the document state listing service.
// ABOUTME: Verifies keyset pagination, ordering, cursor termination, payload shape, and index isolation.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { listDocumentState, clampLimit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../services/documents'
import { ingestRoutes } from '../routes/ingest'
import type { DocumentState } from '../types'

async function makeIndex(pool: Pool, name: string): Promise<number> {
  await createIndex(pool, { name })
  const row = await pool.query('SELECT index_id FROM search_indexes WHERE name = $1', [name])
  return row.rows[0].index_id
}

async function seedDoc(
  pool: Pool,
  indexId: number,
  externalId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO search_documents (index_id, external_id, title, metadata)
     VALUES ($1, $2, $3, $4)`,
    [indexId, externalId, `Title for ${externalId}`, JSON.stringify(metadata)],
  )
}

// Page through the whole index, returning every visited document in order.
async function walk(pool: Pool, indexId: number, limit: number): Promise<DocumentState[]> {
  const all: DocumentState[] = []
  let after: string | undefined
  for (;;) {
    const page = await listDocumentState(pool, indexId, { limit, after })
    all.push(...page.documents)
    if (page.next_cursor === null) break
    after = page.next_cursor
  }
  return all
}

describe('listDocumentState service', () => {
  let pool: Pool
  let indexId: number

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
  })
  afterAll(async () => { await teardownSchema(); await closePool() })
  afterEach(async () => { await cleanupTestData() })

  beforeEach(async () => {
    indexId = await makeIndex(pool, 'test-idx')
  })

  it('returns an empty page with null cursor for an empty index', async () => {
    const page = await listDocumentState(pool, indexId, { limit: 10 })
    expect(page.documents).toEqual([])
    expect(page.next_cursor).toBeNull()
  })

  it('returns all docs ascending with null cursor when under the limit', async () => {
    await seedDoc(pool, indexId, 'c')
    await seedDoc(pool, indexId, 'a')
    await seedDoc(pool, indexId, 'b')
    const page = await listDocumentState(pool, indexId, { limit: 10 })
    expect(page.documents.map(d => d.external_id)).toEqual(['a', 'b', 'c'])
    expect(page.next_cursor).toBeNull()
  })

  it('walks multiple pages visiting every doc exactly once in ascending order', async () => {
    for (const id of ['e', 'a', 'd', 'b', 'c']) await seedDoc(pool, indexId, id)
    const visited = await walk(pool, indexId, 2)
    expect(visited.map(d => d.external_id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('terminates with an empty final page when count is an exact multiple of limit', async () => {
    for (const id of ['a', 'b', 'c', 'd']) await seedDoc(pool, indexId, id)
    const p1 = await listDocumentState(pool, indexId, { limit: 2 })
    expect(p1.documents.map(d => d.external_id)).toEqual(['a', 'b'])
    expect(p1.next_cursor).toBe('b')
    const p2 = await listDocumentState(pool, indexId, { limit: 2, after: p1.next_cursor! })
    expect(p2.documents.map(d => d.external_id)).toEqual(['c', 'd'])
    expect(p2.next_cursor).toBe('d')
    const p3 = await listDocumentState(pool, indexId, { limit: 2, after: p2.next_cursor! })
    expect(p3.documents).toEqual([])
    expect(p3.next_cursor).toBeNull()
  })

  it('treats after as an exclusive lower bound', async () => {
    for (const id of ['a', 'b', 'c']) await seedDoc(pool, indexId, id)
    const page = await listDocumentState(pool, indexId, { limit: 10, after: 'a' })
    expect(page.documents.map(d => d.external_id)).toEqual(['b', 'c'])
  })

  it('returns updated_at as an ISO string and metadata verbatim', async () => {
    await seedDoc(pool, indexId, 'doc-1', { etag: '"abc123"', nested: { section: 'services' } })
    const page = await listDocumentState(pool, indexId, { limit: 10 })
    const doc = page.documents[0]
    expect(doc.metadata).toEqual({ etag: '"abc123"', nested: { section: 'services' } })
    expect(typeof doc.updated_at).toBe('string')
    expect(doc.updated_at).toBe(new Date(doc.updated_at).toISOString())
  })

  it('returns kind, null when the document has none', async () => {
    await seedDoc(pool, indexId, 'with-kind')
    await pool.query("UPDATE search_documents SET kind = 'services' WHERE external_id = 'with-kind'")
    await seedDoc(pool, indexId, 'without-kind')
    const page = await listDocumentState(pool, indexId, { limit: 10 })
    const byId = new Map(page.documents.map(d => [d.external_id, d.kind]))
    expect(byId.get('with-kind')).toBe('services')
    expect(byId.get('without-kind')).toBeNull()
  })

  it('lists only the requested index', async () => {
    const otherId = await makeIndex(pool, 'other-idx')
    await seedDoc(pool, indexId, 'mine')
    await seedDoc(pool, otherId, 'theirs')
    const page = await listDocumentState(pool, indexId, { limit: 10 })
    expect(page.documents.map(d => d.external_id)).toEqual(['mine'])
  })

  it('returns an empty page with null cursor when limit is 0', async () => {
    for (const id of ['a', 'b']) await seedDoc(pool, indexId, id)
    const page = await listDocumentState(pool, indexId, { limit: 0 })
    expect(page.documents).toEqual([])
    expect(page.next_cursor).toBeNull()
  })

  it('coerces null metadata to an empty object', async () => {
    await pool.query(
      `INSERT INTO search_documents (index_id, external_id, title, metadata)
       VALUES ($1, $2, $3, NULL)`,
      [indexId, 'no-meta', 'No metadata doc'],
    )
    const page = await listDocumentState(pool, indexId, { limit: 10 })
    expect(page.documents[0].metadata).toEqual({})
  })
})

describe('clampLimit', () => {
  it('defaults when the param is absent', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_SIZE)
  })
  it('defaults when the param is not a number', () => {
    expect(clampLimit('abc')).toBe(DEFAULT_PAGE_SIZE)
  })
  it('raises values below 1 to 1', () => {
    expect(clampLimit('0')).toBe(1)
    expect(clampLimit('-5')).toBe(1)
  })
  it('caps values above the max', () => {
    expect(clampLimit('99999')).toBe(MAX_PAGE_SIZE)
  })
  it('passes through an in-range value', () => {
    expect(clampLimit('500')).toBe(500)
  })
})

describe('GET /public/index/:name/documents route', () => {
  let pool: Pool
  let indexKey: string
  let indexId: number

  beforeAll(async () => {
    // The route's getPool() reads env vars and constructs a production pool;
    // point it at the same test container the rest of the suite uses.
    process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost'
    process.env.DB_PORT = process.env.TEST_DB_PORT || '5433'
    process.env.DB_NAME = process.env.TEST_DB_NAME || 'pgsearch_test'
    process.env.DB_USER = process.env.TEST_DB_USER || 'pgsearch'
    process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'testpassword'

    await setupSchema()
    pool = await getTestPool()
  })
  afterAll(async () => { await teardownSchema(); await closePool() })
  afterEach(async () => { await cleanupTestData() })

  const app = new Hono()
  app.route('/', ingestRoutes)

  beforeEach(async () => {
    const created = await createIndex(pool, { name: 'route-idx' })
    indexKey = created!.index_key
    const row = await pool.query('SELECT index_id FROM search_indexes WHERE name = $1', ['route-idx'])
    indexId = row.rows[0].index_id
  })

  it('Returns index state for an authenticated request', async () => {
    for (const id of ['b', 'a', 'c']) await seedDoc(pool, indexId, id, { tag: id })

    const res = await app.request('/public/index/route-idx/documents', {
      headers: { 'x-index-key': indexKey },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as {
      documents: { external_id: string; updated_at: string; metadata: Record<string, unknown> }[]
      next_cursor: string | null
    }
    expect(body.documents.map(d => d.external_id)).toEqual(['a', 'b', 'c'])
    expect(body.next_cursor).toBeNull()
    for (const doc of body.documents) {
      expect(typeof doc.updated_at).toBe('string')
      expect(doc.metadata).toBeTypeOf('object')
    }
  })

  it('flows limit + after query params through the route into the keyset walk', async () => {
    for (const id of ['a', 'b', 'c']) await seedDoc(pool, indexId, id)

    const res1 = await app.request('/public/index/route-idx/documents?limit=1', {
      headers: { 'x-index-key': indexKey },
    })
    expect(res1.status).toBe(200)
    const body1 = await res1.json() as {
      documents: { external_id: string }[]
      next_cursor: string | null
    }
    expect(body1.documents.map(d => d.external_id)).toEqual(['a'])
    expect(body1.next_cursor).toBe('a')

    const res2 = await app.request('/public/index/route-idx/documents?limit=1&after=a', {
      headers: { 'x-index-key': indexKey },
    })
    expect(res2.status).toBe(200)
    const body2 = await res2.json() as {
      documents: { external_id: string }[]
      next_cursor: string | null
    }
    expect(body2.documents.map(d => d.external_id)).toEqual(['b'])
    expect(body2.next_cursor).toBe('b')
  })
})
