// ABOUTME: Verifies the baseline migration applies cleanly to a fresh database.
// ABOUTME: Confirms single-version recording, idempotent re-runs, and no pg_cron side effects.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { runMigrations, resetMigrationState } from '../db/migrate'
import type { Pool } from 'pg'

describe('migrations', () => {
  let pool: Pool
  beforeAll(async () => { await teardownSchema(); await setupSchema(); pool = await getTestPool() })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('a fresh database records the baseline and change-set versions', async () => {
    const r = await pool.query('SELECT version FROM schema_migrations ORDER BY version')
    expect(r.rows.map(row => row.version)).toEqual([5, 6, 7, 8])
  })

  it('re-running the migration set is a no-op', async () => {
    resetMigrationState()
    await runMigrations(pool)
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM schema_migrations')
    expect(r.rows[0].n).toBe(4)
  })

  it('search_documents has a nullable kind column', async () => {
    const r = await pool.query(`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'search_documents' AND column_name = 'kind'
    `)
    expect(r.rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }])
  })

  it('does not create the pg_cron extension', async () => {
    const r = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'")
    expect(r.rows).toHaveLength(0)
  })
})
