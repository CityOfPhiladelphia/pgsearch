// ABOUTME: Test database setup and teardown helpers.
// ABOUTME: Connects to the test PostgreSQL, applies schema, and cleans up between runs.

import { Pool } from 'pg'
import { readFileSync } from 'fs'
import { join } from 'path'

const TEST_DB_CONFIG = {
  host: process.env.TEST_DB_HOST || 'localhost',
  port: parseInt(process.env.TEST_DB_PORT || '5433'),
  database: process.env.TEST_DB_NAME || 'pgsearch_test',
  user: process.env.TEST_DB_USER || 'pgsearch',
  password: process.env.TEST_DB_PASSWORD || 'testpassword',
}

let pool: Pool | undefined

export async function getTestPool(): Promise<Pool> {
  if (!pool) {
    pool = new Pool(TEST_DB_CONFIG)
  }
  return pool
}

export async function setupSchema(): Promise<void> {
  const p = await getTestPool()
  await p.query('CREATE EXTENSION IF NOT EXISTS vector')
  const schema = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf-8')
  await p.query(schema)
}

export async function teardownSchema(): Promise<void> {
  const p = await getTestPool()
  await p.query('DROP MATERIALIZED VIEW IF EXISTS term_document_frequencies CASCADE')
  await p.query('DROP TABLE IF EXISTS search_segments CASCADE')
  await p.query('DROP TABLE IF EXISTS search_documents CASCADE')
  await p.query('DROP TABLE IF EXISTS search_indexes CASCADE')
  await p.query('DROP FUNCTION IF EXISTS public.tsvector_to_array(tsvector) CASCADE')
}

export async function cleanupTestData(): Promise<void> {
  const p = await getTestPool()
  // Drop dynamic per-index HNSW indexes before deleting index rows
  const indexes = await p.query('SELECT index_id FROM search_indexes')
  for (const row of indexes.rows) {
    await p.query(`DROP INDEX IF EXISTS idx_segments_embedding_${row.index_id}`)
  }
  await p.query('DELETE FROM search_segments')
  await p.query('DELETE FROM search_documents')
  await p.query('DELETE FROM search_indexes')
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = undefined
  }
}
