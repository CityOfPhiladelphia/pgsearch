// ABOUTME: Index CRUD operations for managing search indexes.
// ABOUTME: Handles creation (with key generation), retrieval, listing, updating, and deletion.

import type { Pool } from 'pg'
import type { CreateIndexRequest, CreateIndexResponse, SearchIndex, IndexConfig } from '../types'
import { generateKey, hashKey } from '../middleware/auth'
import { mergeConfig } from '../config'

function rowToIndex(row: any): SearchIndex {
  return {
    ...row,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    last_refreshed_at: row.last_refreshed_at ? row.last_refreshed_at.toISOString() : null,
  }
}

export async function createIndex(pool: Pool, request: CreateIndexRequest): Promise<CreateIndexResponse> {
  const indexKey = generateKey('idx')
  const searchKey = generateKey('srch')
  const indexKeyHash = await hashKey(indexKey)
  const searchKeyHash = await hashKey(searchKey)
  const config = mergeConfig(request.config || {})

  const result = await pool.query(
    `INSERT INTO search_indexes (name, description, config, index_key_hash, search_key_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING index_id, created_at`,
    [request.name, request.description || null, JSON.stringify(config), indexKeyHash, searchKeyHash]
  )

  const { index_id, created_at } = result.rows[0]

  // Create per-index HNSW partial vector index for cosine similarity search.
  // Uses string interpolation for DDL (index names and dimensions can't be parameterized).
  // index_id is a database-generated integer, safe from injection.
  await pool.query(
    `CREATE INDEX idx_segments_embedding_${index_id}
     ON search_segments USING hnsw ((embedding::vector(${config.embedding.dimensions})) vector_cosine_ops)
     WHERE index_id = ${index_id}`
  )

  return {
    name: request.name,
    index_key: indexKey,
    search_key: searchKey,
    created_at: created_at.toISOString(),
  }
}

export async function getIndex(pool: Pool, name: string): Promise<SearchIndex | null> {
  const result = await pool.query(
    'SELECT * FROM search_indexes WHERE name = $1',
    [name]
  )

  if (result.rows.length === 0) return null
  return rowToIndex(result.rows[0])
}

export async function listIndexes(pool: Pool): Promise<SearchIndex[]> {
  const result = await pool.query(
    'SELECT * FROM search_indexes ORDER BY created_at'
  )

  return result.rows.map(rowToIndex)
}

export async function updateIndex(pool: Pool, name: string, configOverrides: Partial<IndexConfig>): Promise<void> {
  const existing = await getIndex(pool, name)
  if (!existing) throw new Error(`Index '${name}' not found`)

  const mergedConfig = mergeConfig(configOverrides, existing.config)

  await pool.query(
    'UPDATE search_indexes SET config = $1, updated_at = NOW() WHERE name = $2',
    [JSON.stringify(mergedConfig), name]
  )
}

export async function deleteIndex(pool: Pool, name: string): Promise<void> {
  const existing = await getIndex(pool, name)
  if (!existing) throw new Error(`Index '${name}' not found`)

  // Drop per-index HNSW index before deleting the row.
  // Uses string interpolation for DDL; index_id is a database-generated integer.
  await pool.query(`DROP INDEX IF EXISTS idx_segments_embedding_${existing.index_id}`)

  await pool.query('DELETE FROM search_indexes WHERE name = $1', [name])
}
