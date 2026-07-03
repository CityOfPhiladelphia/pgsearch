// ABOUTME: Route tests for the admin indexes reconcile endpoint.
// ABOUTME: Verifies reconcile returns 200 on an existing index and 404 on a missing index.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { adminRoutes } from '../routes/admin'

const app = new Hono()
app.route('/', adminRoutes)

describe('admin reconcile route', () => {
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

  it('returns 200 with { status: "reconciled" } for an existing index', async () => {
    await createIndex(pool, { name: 'reconcile-test' })

    const res = await app.request('/private/key/admin/indexes/reconcile-test/reconcile', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { status: string }
    expect(body.status).toBe('reconciled')
  })

  it('returns 404 for a missing index', async () => {
    const res = await app.request('/private/key/admin/indexes/does-not-exist/reconcile', {
      method: 'POST',
    })

    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })
})
