// ABOUTME: Tests for search route query-param validation behind real key auth.
// ABOUTME: Exercises kind_weights parsing; the 200 path is covered at the service seam (adapter needs bedrock).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { searchRoutes } from '../routes/search'

describe('GET /public/search/:name kind_weights validation', () => {
  let pool: Pool
  let searchKey: string

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
    const created = await createIndex(pool, { name: 'search-route-idx' })
    searchKey = created!.search_key
  })
  afterAll(async () => { await cleanupTestData(); await teardownSchema(); await closePool() })

  const app = new Hono()
  app.route('/', searchRoutes)

  const get = (query: string) =>
    app.request(`/public/search/search-route-idx?${query}`, { headers: { 'x-search-key': searchKey } })

  const expectValidationError = async (query: string) => {
    const res = await get(query)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
  }

  it('rejects a non-numeric weight', async () => {
    await expectValidationError('q=water&kind_weights=services:abc')
  })

  it('rejects a negative weight', async () => {
    await expectValidationError('q=water&kind_weights=services:-1')
  })

  it('rejects a pair with no separator', async () => {
    await expectValidationError('q=water&kind_weights=services')
  })

  it('rejects an empty kind', async () => {
    await expectValidationError('q=water&kind_weights=:1.2')
  })

  it('rejects a recency rule with too few fields', async () => {
    await expectValidationError('q=water&recency=posts:180')
  })

  it('rejects a recency rule with empty kinds', async () => {
    await expectValidationError('q=water&recency=:180:0.85')
  })

  it('rejects a non-positive half-life', async () => {
    await expectValidationError('q=water&recency=posts:0:0.85')
  })

  it('rejects a floor outside [0,1]', async () => {
    await expectValidationError('q=water&recency=posts:180:1.5')
  })

  it('rejects an empty kinds list', async () => {
    await expectValidationError('q=water&kinds=')
    await expectValidationError('q=water&kinds=,,')
  })
})
