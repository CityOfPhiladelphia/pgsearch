// ABOUTME: Verifies the database schema applies cleanly and all objects exist.
// ABOUTME: Confirms tables, dropped statistics artifacts, and tsvector_to_array function.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupSchema, teardownSchema, getTestPool, closePool } from './setup'

describe('database schema', () => {
  beforeAll(async () => {
    await teardownSchema()
    await setupSchema()
  })

  afterAll(async () => {
    await teardownSchema()
  })

  it('creates search_indexes table', async () => {
    const pool = await getTestPool()
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'search_indexes'
      ORDER BY column_name
    `)
    const columns = result.rows.map((r: { column_name: string }) => r.column_name)
    expect(columns).toContain('index_id')
    expect(columns).toContain('name')
    expect(columns).toContain('config')
    expect(columns).toContain('index_key_hash')
    expect(columns).toContain('search_key_hash')
    expect(columns).toContain('total_documents')
  })

  it('creates search_documents table', async () => {
    const pool = await getTestPool()
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'search_documents'
      ORDER BY column_name
    `)
    const columns = result.rows.map((r: { column_name: string }) => r.column_name)
    expect(columns).toContain('document_id')
    expect(columns).toContain('index_id')
    expect(columns).toContain('external_id')
    expect(columns).toContain('title_tsvector')
  })

  it('creates search_segments table', async () => {
    const pool = await getTestPool()
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'search_segments'
      ORDER BY column_name
    `)
    const columns = result.rows.map((r: { column_name: string }) => r.column_name)
    expect(columns).toContain('segment_id')
    expect(columns).toContain('embedding')
    expect(columns).toContain('body_tsvector')
    expect(columns).toContain('content_hash')
  })

  it('tsvector_to_array function extracts lexemes', async () => {
    const pool = await getTestPool()
    const result = await pool.query(`SELECT tsvector_to_array('hello:1 world:2'::tsvector) AS terms`)
    const terms: string[] = result.rows[0].terms
    expect(terms).toContain('hello')
    expect(terms).toContain('world')
  })

  it('carries no keyword-statistics artifacts (term frequencies table, stats columns)', async () => {
    const pool = await getTestPool()
    const tdf = await pool.query(`SELECT 1 FROM pg_class WHERE relname = 'term_document_frequencies'`)
    expect(tdf.rows).toHaveLength(0)
    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'search_indexes' AND column_name IN
        ('avg_title_length', 'avg_body_length', 'total_title_length', 'total_body_length',
         'total_segments', 'last_refreshed_at', 'docs_changed_since_refresh')
    `)
    expect(cols.rows).toHaveLength(0)
    const lengthCols = await pool.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'search_documents' AND column_name = 'title_length')
         OR (table_name = 'search_segments' AND column_name = 'body_length')
    `)
    expect(lengthCols.rows).toHaveLength(0)
  })
})

describe('rag schema', () => {
  beforeAll(async () => {
    await teardownSchema()
    await setupSchema()
  })

  afterAll(async () => {
    await teardownSchema()
  })

  it('adds rag_key_hash column to search_indexes', async () => {
    const pool = await getTestPool()
    const result = await pool.query(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'search_indexes' AND column_name = 'rag_key_hash'
    `)
    expect(result.rows.length).toBe(1)
    expect(result.rows[0].is_nullable).toBe('YES')
  })

  it('creates rag_prompts table with expected columns', async () => {
    const pool = await getTestPool()
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'rag_prompts'
      ORDER BY ordinal_position
    `)
    const columns = result.rows.map((r: { column_name: string }) => r.column_name)
    expect(columns).toEqual(expect.arrayContaining([
      'prompt_id', 'index_id', 'name', 'content', 'created_at', 'updated_at',
    ]))
  })

  it('enforces unique (index_id, name) on rag_prompts', async () => {
    const pool = await getTestPool()
    const result = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'rag_prompts' AND indexdef LIKE '%UNIQUE%(index_id, name)%'
    `)
    expect(result.rows.length).toBeGreaterThan(0)
  })
})

afterAll(async () => {
  await closePool()
})
