// ABOUTME: Tests for index CRUD operations and auth key verification.
// ABOUTME: Validates creation, retrieval, listing, updating, and deletion of search indexes.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex, getIndex, listIndexes, deleteIndex, updateIndex, mintRagKey, revokeRagKey } from '../services/indexes'
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

  describe('RAG key management', () => {
    it('rag_key_hash is null on a freshly created index', async () => {
      await createIndex(pool, { name: 'no-rag' })
      const index = await getIndex(pool, 'no-rag')
      expect(index!.rag_key_hash).toBeNull()
    })

    it('mintRagKey returns a plaintext key and persists its hash', async () => {
      await createIndex(pool, { name: 'with-rag' })
      const result = await mintRagKey(pool, 'with-rag')
      expect(result.rag_key.startsWith('rag_')).toBe(true)

      const index = await getIndex(pool, 'with-rag')
      expect(index!.rag_key_hash).not.toBeNull()
      expect(await verifyKey(result.rag_key, index!.rag_key_hash!)).toBe(true)
    })

    it('mintRagKey rotates an existing key', async () => {
      await createIndex(pool, { name: 'rotate' })
      const first = await mintRagKey(pool, 'rotate')
      const second = await mintRagKey(pool, 'rotate')
      expect(first.rag_key).not.toBe(second.rag_key)

      const index = await getIndex(pool, 'rotate')
      expect(await verifyKey(second.rag_key, index!.rag_key_hash!)).toBe(true)
      expect(await verifyKey(first.rag_key, index!.rag_key_hash!)).toBe(false)
    })

    it('revokeRagKey nulls the hash', async () => {
      await createIndex(pool, { name: 'revoke-me' })
      await mintRagKey(pool, 'revoke-me')
      await revokeRagKey(pool, 'revoke-me')
      const index = await getIndex(pool, 'revoke-me')
      expect(index!.rag_key_hash).toBeNull()
    })

    it('mintRagKey throws for missing index', async () => {
      await expect(mintRagKey(pool, 'nope')).rejects.toThrow(/not found/i)
    })

    it('revokeRagKey throws for missing index', async () => {
      await expect(revokeRagKey(pool, 'nope')).rejects.toThrow(/not found/i)
    })

    it('revokeRagKey is idempotent — no error when key was never minted', async () => {
      await createIndex(pool, { name: 'never-minted' })
      await expect(revokeRagKey(pool, 'never-minted')).resolves.toBeUndefined()
      const index = await getIndex(pool, 'never-minted')
      expect(index!.rag_key_hash).toBeNull()
    })
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
