// ABOUTME: Index CRUD operations for managing search indexes.
// ABOUTME: Handles creation (with key generation), retrieval, listing, updating, deletion, and key mint/revoke.

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
  }
}

// Returns null when an index with the requested name already exists. The
// UNIQUE(name) constraint is enforced by the DB via ON CONFLICT, so callers
// can guard on a null return without try/catch.
export async function createIndex(
  pool: Pool,
  request: CreateIndexRequest,
): Promise<CreateIndexResponse | null> {
  const indexKey = generateKey('idx')
  const searchKey = generateKey('srch')
  const indexKeyHash = await hashKey(indexKey)
  const searchKeyHash = await hashKey(searchKey)
  const config = mergeConfig(request.config || {})

  const result = await pool.query(
    `INSERT INTO search_indexes (name, description, config, index_key_hash, search_key_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name) DO NOTHING
     RETURNING index_id, created_at`,
    [request.name, request.description || null, JSON.stringify(config), indexKeyHash, searchKeyHash]
  )

  if (result.rows.length === 0) return null

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

// Returns the updated row, or null when no index with that name exists.
export async function updateIndex(
  pool: Pool,
  name: string,
  configOverrides: Partial<IndexConfig>,
): Promise<SearchIndex | null> {
  const existing = await getIndex(pool, name)
  if (!existing) return null

  const mergedConfig = mergeConfig(configOverrides, existing.config)
  const result = await pool.query(
    `UPDATE search_indexes SET config = $1, updated_at = NOW()
     WHERE name = $2
     RETURNING *`,
    [JSON.stringify(mergedConfig), name],
  )
  return rowToIndex(result.rows[0])
}

// Returns false when no index with that name exists.
export async function deleteIndex(pool: Pool, name: string): Promise<boolean> {
  const existing = await getIndex(pool, name)
  if (!existing) return false

  // Drop per-index HNSW index before deleting the row.
  // Uses string interpolation for DDL; index_id is a database-generated integer.
  await pool.query(`DROP INDEX IF EXISTS idx_segments_embedding_${existing.index_id}`)
  await pool.query('DELETE FROM search_indexes WHERE name = $1', [name])
  return true
}

// Per-index credentials.
// Each key type maps to its hash column on search_indexes and a token prefix.
// Both lookups are over typed const objects, so the SQL column interpolation
// below is safe-by-construction — the value can only ever be one of the three
// literal column names listed here.
export type KeyType = 'index' | 'search' | 'rag'

const KEY_HASH_COLUMNS: Record<KeyType, 'index_key_hash' | 'search_key_hash' | 'rag_key_hash'> = {
  index: 'index_key_hash',
  search: 'search_key_hash',
  rag: 'rag_key_hash',
}

const KEY_PREFIXES: Record<KeyType, string> = {
  index: 'idx',
  search: 'srch',
  rag: 'rag',
}

export interface MintKeyResult {
  key: string
}

// Returns null when no index with that name exists. When the index exists,
// generates a new plaintext key, stores its bcrypt hash in the appropriate
// column, and returns the plaintext (the only time the caller sees it).
// Calling twice in a row rotates the key (the old one stops verifying).
export async function mintKey(
  pool: Pool,
  indexName: string,
  keyType: KeyType,
): Promise<MintKeyResult | null> {
  const existing = await getIndex(pool, indexName)
  if (!existing) return null

  const key = generateKey(KEY_PREFIXES[keyType])
  const hash = await hashKey(key)
  const column = KEY_HASH_COLUMNS[keyType]

  await pool.query(
    `UPDATE search_indexes SET ${column} = $1, updated_at = NOW() WHERE name = $2`,
    [hash, indexName],
  )
  return { key }
}

// Returns false when no index with that name exists. Idempotent on the
// "key was never minted" case: nulling an already-null column still returns true.
export async function revokeKey(
  pool: Pool,
  indexName: string,
  keyType: KeyType,
): Promise<boolean> {
  const existing = await getIndex(pool, indexName)
  if (!existing) return false

  const column = KEY_HASH_COLUMNS[keyType]
  await pool.query(
    `UPDATE search_indexes SET ${column} = NULL, updated_at = NOW() WHERE name = $1`,
    [indexName],
  )
  return true
}
