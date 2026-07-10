// ABOUTME: Route tests for the admin diagnostics and key-minting endpoints.
// ABOUTME: Verifies admin diagnostics and search-key rotation 201/404.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { adminRoutes } from '../routes/admin'

const app = new Hono()
app.route('/', adminRoutes)

describe('admin routes', () => {
  let pool: Pool

  beforeAll(async () => {
    // The route handlers connect via getPool() (DB_* env), while the test drives
    // setup through getTestPool() (TEST_DB_* env). Point DB_* at the same test DB
    // before the first getPool() call (which happens lazily inside app.request).
    process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost'
    process.env.DB_PORT = process.env.TEST_DB_PORT || '5433'
    process.env.DB_NAME = process.env.TEST_DB_NAME || 'pgsearch_test'
    process.env.DB_USER = process.env.TEST_DB_USER || 'pgsearch'
    process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'testpassword'

    await setupSchema()
    pool = await getTestPool()
  })

  afterAll(async () => {
    await teardownSchema()
    await closePool()
  })

  afterEach(async () => {
    await cleanupTestData()
  })

  it('db-status reports extensions, embedding indexes, and vector dimensions', async () => {
    await createIndex(pool, { name: 'db-status-test' })

    const res = await app.request('/private/key/admin/db-status')
    expect(res.status).toBe(200)
    const body = await res.json() as {
      extensions: Array<{ name: string; version: string }>
      embedding_indexes: Array<{ index_name: string; definition: string }>
      segment_dimensions: Array<{ index_id: number; dimensions: number }>
    }
    expect(body.extensions.map(e => e.name)).toContain('vector')
    // createIndex builds a per-index embedding index; the test index has one
    expect(body.embedding_indexes.length).toBeGreaterThan(0)
    expect(body.embedding_indexes[0].definition).toContain('hnsw')
    // no segments ingested yet, so no dimensions rows
    expect(body.segment_dimensions).toEqual([])
  })

  it('mints (rotates) a search key for an existing index', async () => {
    await createIndex(pool, { name: 'search-key-test' })

    const res = await app.request('/private/key/admin/indexes/search-key-test/search-key', {
      method: 'POST',
    })

    expect(res.status).toBe(201)
    const body = await res.json() as { search_key: string }
    expect(body.search_key).toMatch(/^srch_/)
  })

  it('returns 404 minting a search key for a missing index', async () => {
    const res = await app.request('/private/key/admin/indexes/does-not-exist/search-key', {
      method: 'POST',
    })

    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })
})
