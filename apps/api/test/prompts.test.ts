// ABOUTME: Tests for the RAG prompt CRUD service.
// ABOUTME: Verifies create / read / list / update / delete and uniqueness behavior.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { createPrompt, getPrompt, listPrompts, updatePrompt, deletePrompt } from '../services/prompts'
import type { PromptContent } from '../types'

const sampleContent: PromptContent = {
  system: 'You are a helpful assistant.',
  response_format: 'Cite sources as [N].',
  model: 'anthropic.claude-haiku-4-5',
  max_tokens: 1024,
  temperature: 0.2,
  retrieval: {
    mode: 'hybrid',
    limit: 8,
    max_chunks_per_doc: 3,
    min_lexical_score: 0,
    min_vector_score: 0,
  },
}

describe('prompts service', () => {
  let pool: Pool
  let indexId: number

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
  })
  afterAll(async () => { await teardownSchema(); await closePool() })
  afterEach(async () => { await cleanupTestData() })

  beforeEach(async () => {
    await createIndex(pool, { name: 'test-idx' })
    const row = await pool.query('SELECT index_id FROM search_indexes WHERE name = $1', ['test-idx'])
    indexId = row.rows[0].index_id
  })

  it('creates and reads a prompt', async () => {
    const created = await createPrompt(pool, indexId, 'navigator', sampleContent)
    expect(created).not.toBeNull()
    expect(created!.name).toBe('navigator')
    expect(created!.content.model).toBe('anthropic.claude-haiku-4-5')

    const read = await getPrompt(pool, indexId, 'navigator')
    expect(read).not.toBeNull()
    expect(read!.content.system).toBe(sampleContent.system)
  })

  it('returns null for a missing prompt', async () => {
    const read = await getPrompt(pool, indexId, 'does-not-exist')
    expect(read).toBeNull()
  })

  it('lists prompts for an index', async () => {
    await createPrompt(pool, indexId, 'a', sampleContent)
    await createPrompt(pool, indexId, 'b', sampleContent)
    const list = await listPrompts(pool, indexId)
    expect(list.length).toBe(2)
    expect(list.map(p => p.name)).toEqual(['a', 'b'])
  })

  it('returns null on duplicate (index_id, name)', async () => {
    await createPrompt(pool, indexId, 'dupe', sampleContent)
    const second = await createPrompt(pool, indexId, 'dupe', sampleContent)
    expect(second).toBeNull()
  })

  it('updates a prompt content', async () => {
    await createPrompt(pool, indexId, 'p', sampleContent)
    const updated = { ...sampleContent, temperature: 0.7 }
    const result = await updatePrompt(pool, indexId, 'p', updated)
    expect(result).not.toBeNull()
    expect(result!.content.temperature).toBe(0.7)
  })

  it('updatePrompt returns null for missing prompt', async () => {
    const result = await updatePrompt(pool, indexId, 'never-existed', sampleContent)
    expect(result).toBeNull()
  })

  it('deletes a prompt', async () => {
    await createPrompt(pool, indexId, 'gone', sampleContent)
    const deleted = await deletePrompt(pool, indexId, 'gone')
    expect(deleted).toBe(true)
    const read = await getPrompt(pool, indexId, 'gone')
    expect(read).toBeNull()
  })

  it('deletePrompt returns false for missing prompt', async () => {
    const deleted = await deletePrompt(pool, indexId, 'never-existed')
    expect(deleted).toBe(false)
  })
})
