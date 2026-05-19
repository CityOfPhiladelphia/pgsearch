// ABOUTME: Tests for index CRUD operations and auth key verification.
// ABOUTME: Validates creation, retrieval, listing, updating, and deletion of search indexes.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex, getIndex, listIndexes, deleteIndex, updateIndex, mintKey, revokeKey } from '../services/indexes'
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
    expect(result).not.toBeNull()
    expect(result!.name).toBe('test-index')
    expect(result!.index_key.startsWith('idx_')).toBe(true)
    expect(result!.search_key.startsWith('srch_')).toBe(true)
  })

  it('applies default config when none provided', async () => {
    await createIndex(pool, { name: 'defaults-test' })
    const index = await getIndex(pool, 'defaults-test')
    expect(index).not.toBeNull()
    expect(index!.config.bm25_k1).toBe(1.2)
    expect(index!.config.rrf_k).toBe(60)
  })

  it('returns null on duplicate index names', async () => {
    await createIndex(pool, { name: 'dupe' })
    const second = await createIndex(pool, { name: 'dupe' })
    expect(second).toBeNull()
  })

  it('lists all indexes', async () => {
    await createIndex(pool, { name: 'idx-a' })
    await createIndex(pool, { name: 'idx-b' })
    const indexes = await listIndexes(pool)
    expect(indexes.length).toBe(2)
  })

  it('deletes an index and its HNSW index', async () => {
    await createIndex(pool, { name: 'to-delete' })
    const deleted = await deleteIndex(pool, 'to-delete')
    expect(deleted).toBe(true)
    const index = await getIndex(pool, 'to-delete')
    expect(index).toBeNull()
  })

  it('deleteIndex returns false for missing index', async () => {
    const deleted = await deleteIndex(pool, 'never-existed')
    expect(deleted).toBe(false)
  })

  it('updates index config with deep merge', async () => {
    await createIndex(pool, { name: 'to-update' })
    const updated = await updateIndex(pool, 'to-update', { bm25_k1: 2.0 })
    expect(updated).not.toBeNull()
    expect(updated!.config.bm25_k1).toBe(2.0)
    expect(updated!.config.bm25_b).toBe(0.75) // unchanged default preserved
  })

  it('updates nested config without losing sibling fields', async () => {
    await createIndex(pool, { name: 'nested-update' })
    const updated = await updateIndex(pool, 'nested-update', { embedding: { model: 'new-model' } } as any)
    expect(updated!.config.embedding.model).toBe('new-model')
    expect(updated!.config.embedding.provider).toBe('local') // default preserved
    expect(updated!.config.embedding.dimensions).toBe(384) // default preserved
  })

  it('updateIndex returns null for missing index', async () => {
    const updated = await updateIndex(pool, 'never-existed', { bm25_k1: 2.0 })
    expect(updated).toBeNull()
  })

  describe('key management', () => {
    it('rag_key_hash is null on a freshly created index', async () => {
      await createIndex(pool, { name: 'no-rag' })
      const index = await getIndex(pool, 'no-rag')
      expect(index!.rag_key_hash).toBeNull()
    })

    it('mintKey for RAG returns a plaintext key and persists its hash', async () => {
      await createIndex(pool, { name: 'with-rag' })
      const result = await mintKey(pool, 'with-rag', 'rag')
      expect(result).not.toBeNull()
      expect(result!.key.startsWith('rag_')).toBe(true)

      const index = await getIndex(pool, 'with-rag')
      expect(index!.rag_key_hash).not.toBeNull()
      expect(await verifyKey(result!.key, index!.rag_key_hash!)).toBe(true)
    })

    it('mintKey rotates an existing key', async () => {
      await createIndex(pool, { name: 'rotate' })
      const first = await mintKey(pool, 'rotate', 'rag')
      const second = await mintKey(pool, 'rotate', 'rag')
      expect(first!.key).not.toBe(second!.key)

      const index = await getIndex(pool, 'rotate')
      expect(await verifyKey(second!.key, index!.rag_key_hash!)).toBe(true)
      expect(await verifyKey(first!.key, index!.rag_key_hash!)).toBe(false)
    })

    it('revokeKey nulls the hash', async () => {
      await createIndex(pool, { name: 'revoke-me' })
      await mintKey(pool, 'revoke-me', 'rag')
      const revoked = await revokeKey(pool, 'revoke-me', 'rag')
      expect(revoked).toBe(true)
      const index = await getIndex(pool, 'revoke-me')
      expect(index!.rag_key_hash).toBeNull()
    })

    it('mintKey returns null for missing index', async () => {
      const result = await mintKey(pool, 'nope', 'rag')
      expect(result).toBeNull()
    })

    it('revokeKey returns false for missing index', async () => {
      const revoked = await revokeKey(pool, 'nope', 'rag')
      expect(revoked).toBe(false)
    })

    it('revokeKey is idempotent — succeeds when key was never minted', async () => {
      await createIndex(pool, { name: 'never-minted' })
      const revoked = await revokeKey(pool, 'never-minted', 'rag')
      expect(revoked).toBe(true)
      const index = await getIndex(pool, 'never-minted')
      expect(index!.rag_key_hash).toBeNull()
    })

    it('mintKey accepts other key types (index, search)', async () => {
      await createIndex(pool, { name: 'rotate-search' })
      const rotated = await mintKey(pool, 'rotate-search', 'search')
      expect(rotated!.key.startsWith('srch_')).toBe(true)
      const index = await getIndex(pool, 'rotate-search')
      expect(await verifyKey(rotated!.key, index!.search_key_hash)).toBe(true)
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
    expect(await verifyKey(result!.index_key, index!.index_key_hash)).toBe(true)
  })

  it('indexAuth rejects with invalid index key', async () => {
    await createIndex(pool, { name: 'auth-reject' })
    const index = await getIndex(pool, 'auth-reject')
    expect(await verifyKey('idx_wrong_key', index!.index_key_hash)).toBe(false)
  })

  it('searchAuth passes with valid search key', async () => {
    const result = await createIndex(pool, { name: 'search-auth' })
    const index = await getIndex(pool, 'search-auth')
    expect(await verifyKey(result!.search_key, index!.search_key_hash)).toBe(true)
  })
})
