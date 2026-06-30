// ABOUTME: Verifies migration v3 converts the term-frequency matview to a table
// ABOUTME: and adds the running-sum columns used for incremental average maintenance.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import type { Pool } from 'pg'

describe('migration v3', () => {
  let pool: Pool
  beforeAll(async () => { await setupSchema(); pool = await getTestPool() })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('term_document_frequencies is a base table, not a matview', async () => {
    const r = await pool.query(
      "SELECT relkind FROM pg_class WHERE relname = 'term_document_frequencies'"
    )
    expect(r.rows[0].relkind).toBe('r') // 'r' = ordinary table ('m' = matview)
  })

  it('term_document_frequencies has a primary key on (index_id, term)', async () => {
    const r = await pool.query(`
      SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'term_document_frequencies'::regclass AND i.indisprimary
      ORDER BY a.attname`)
    expect(r.rows.map(x => x.attname)).toEqual(['index_id', 'term'])
  })

  it('search_indexes has the running-sum columns', async () => {
    const r = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'search_indexes'
        AND column_name IN ('total_title_length','total_body_length','total_segments')`)
    expect(r.rows.map(x => x.column_name).sort()).toEqual(
      ['total_body_length', 'total_segments', 'total_title_length'])
  })
})
