// ABOUTME: Verifies migration v4 is a clean no-op where pg_cron is not preloaded
// ABOUTME: (the dockerized test DB), so the pg_cron migration stays portable.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import type { Pool } from 'pg'

describe('migration v4 (pg_cron, guarded)', () => {
  let pool: Pool
  beforeAll(async () => { await setupSchema(); pool = await getTestPool() })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('records version 4 as applied', async () => {
    const r = await pool.query('SELECT MAX(version)::int AS v FROM schema_migrations')
    expect(r.rows[0].v).toBeGreaterThanOrEqual(4)
  })

  it('does not create the pg_cron extension where it is not preloaded', async () => {
    // The dockerized test DB has no pg_cron in shared_preload_libraries, so the
    // guard must skip CREATE EXTENSION rather than error (setupSchema in beforeAll
    // would have thrown if v4 hard-failed).
    const r = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'")
    expect(r.rows).toHaveLength(0)
  })
})
