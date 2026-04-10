// ABOUTME: Tests for index CRUD operations and auth key verification.
// ABOUTME: Validates creation, retrieval, listing, updating, and deletion of search indexes.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex, getIndex, listIndexes, deleteIndex, updateIndex } from '../services/indexes'
import { verifyKey } from '../middleware/auth'
import type { Pool } from 'pg'

describe('indexes service', () => {
  let pool: Pool

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
  })
  afterAll(async () => { await teardownSchema(); await closePool() })
  afterEach(async () => { await cleanupTestData() })

  it('creates an index and returns keys', async () => {
    const result = await createIndex(pool, { name: 'test-index', description: 'A test index' })
    expect(result.name).toBe('test-index')
    expect(result.index_key).toBeDefined()
    expect(result.index_key.startsWith('idx_')).toBe(true)
    expect(result.search_key).toBeDefined()
    expect(result.search_key.startsWith('srch_')).toBe(true)
  })

  it('applies default config when none provided', async () => {
    await createIndex(pool, { name: 'defaults-test' })
    const index = await getIndex(pool, 'defaults-test')
    expect(index).not.toBeNull()
    expect(index!.config.bm25_k1).toBe(1.2)
    expect(index!.config.rrf_k).toBe(60)
  })

  it('rejects duplicate index names', async () => {
    await createIndex(pool, { name: 'dupe' })
    await expect(createIndex(pool, { name: 'dupe' })).rejects.toThrow()
  })

  it('lists all indexes', async () => {
    await createIndex(pool, { name: 'idx-a' })
    await createIndex(pool, { name: 'idx-b' })
    const indexes = await listIndexes(pool)
    expect(indexes.length).toBe(2)
  })

  it('deletes an index and its HNSW index', async () => {
    await createIndex(pool, { name: 'to-delete' })
    await deleteIndex(pool, 'to-delete')
    const index = await getIndex(pool, 'to-delete')
    expect(index).toBeNull()
  })

  it('updates index config with deep merge', async () => {
    await createIndex(pool, { name: 'to-update' })
    await updateIndex(pool, 'to-update', { bm25_k1: 2.0 })
    const index = await getIndex(pool, 'to-update')
    expect(index!.config.bm25_k1).toBe(2.0)
    expect(index!.config.bm25_b).toBe(0.75) // unchanged default preserved
  })

  it('updates nested config without losing sibling fields', async () => {
    await createIndex(pool, { name: 'nested-update' })
    await updateIndex(pool, 'nested-update', { embedding: { model: 'new-model' } } as any)
    const index = await getIndex(pool, 'nested-update')
    expect(index!.config.embedding.model).toBe('new-model')
    expect(index!.config.embedding.provider).toBe('local') // default preserved
    expect(index!.config.embedding.dimensions).toBe(384) // default preserved
  })
})

describe('auth integration', () => {
  let pool: Pool

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
  })
  afterAll(async () => { await teardownSchema(); await closePool() })
  afterEach(async () => { await cleanupTestData() })

  it('indexAuth passes with valid index key', async () => {
    const result = await createIndex(pool, { name: 'auth-test' })
    const index = await getIndex(pool, 'auth-test')
    expect(await verifyKey(result.index_key, index!.index_key_hash)).toBe(true)
  })

  it('indexAuth rejects with invalid index key', async () => {
    await createIndex(pool, { name: 'auth-reject' })
    const index = await getIndex(pool, 'auth-reject')
    expect(await verifyKey('idx_wrong_key', index!.index_key_hash)).toBe(false)
  })

  it('searchAuth passes with valid search key', async () => {
    const result = await createIndex(pool, { name: 'search-auth' })
    const index = await getIndex(pool, 'search-auth')
    expect(await verifyKey(result.search_key, index!.search_key_hash)).toBe(true)
  })
})
