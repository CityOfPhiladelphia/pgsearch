// ABOUTME: Integration tests for the RAG pipeline.
// ABOUTME: Uses test embedding + LLM adapters so retrieval and synthesis are deterministic.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex, mintKey, getIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { createPrompt } from '../services/prompts'
import { runRag } from '../services/rag'
import { ragRoutes } from '../routes/rag'
import { createTestAdapter } from '@phila/search-embeddings'
import { createTestLlmAdapter } from '@phila/llm'
import { mergeConfig } from '../config'
import type { PromptContent } from '../types'

const promptContent: PromptContent = {
  system: 'You are helpful.',
  response_format: 'Cite [N].',
  model: 'anthropic.claude-haiku-4-5',
  max_tokens: 256,
  temperature: 0,
  retrieval: { mode: 'hybrid', limit: 4, max_chunks_per_doc: 2, min_lexical_score: 0, min_vector_score: 0 },
}

describe('runRag', () => {
  let pool: Pool
  let indexId: number
  const embedAdapter = createTestAdapter(384)
  const config = mergeConfig({})

  // Fetch a fresh index per call, mirroring how the route resolves it from auth.
  const rag = async (llmAdapter: Parameters<typeof runRag>[3], input: Parameters<typeof runRag>[4]) =>
    runRag(pool, (await getIndex(pool, 'rag-idx'))!, embedAdapter, llmAdapter, input)

  beforeAll(async () => { await setupSchema(); pool = await getTestPool() })
  afterAll(async () => { await teardownSchema(); await closePool() })
  afterEach(async () => { await cleanupTestData() })

  beforeEach(async () => {
    await createIndex(pool, {
      name: 'rag-idx',
      config: { embedding: { provider: 'bedrock', model: 'test', dimensions: 384 } } as any,
    })
    const row = await pool.query('SELECT index_id FROM search_indexes WHERE name = $1', ['rag-idx'])
    indexId = row.rows[0].index_id

    // Seed two docs so we have something to cite
    await ingestDocument(pool, indexId, embedAdapter, {
      external_id: 'parking-apply',
      title: 'Apply for a Parking Permit',
      body: 'You can apply for a parking permit online or in person at the Streets Department.',
      metadata: { source_url: 'https://phila.gov/parking/apply' },
    }, config)
    await ingestDocument(pool, indexId, embedAdapter, {
      external_id: 'parking-veterans',
      title: 'Veterans Parking Benefits',
      body: 'Veterans qualify for a reduced fee on residential parking permits.',
      metadata: { source_url: 'https://phila.gov/parking/veterans' },
    }, config)

    await createPrompt(pool, indexId, 'navigator', promptContent)
  })

  it('returns answer, citations, retrieved, model, usage, prompt name', async () => {
    const llm = createTestLlmAdapter({ withCitations: [1, 2] })
    const result = await rag(llm, {
      promptName: 'navigator',
      promptContent,
      question: 'parking',
    })

    expect(result.answer).toContain('[1]')
    expect(result.answer).toContain('[2]')
    expect(result.citations.length).toBe(2)
    expect(result.citations[0].marker).toBe(1)
    expect(result.citations[1].marker).toBe(2)
    expect(result.retrieved.length).toBeGreaterThan(0)
    expect(result.prompt).toBe('navigator')
    expect(result.model).toBe('test-llm')
    expect(result.usage.output_tokens).toBeGreaterThan(0)
  })

  it('marks cited chunks as used=true and uncited as used=false', async () => {
    const llm = createTestLlmAdapter({ withCitations: [1] })
    const result = await rag(llm, {
      promptName: 'navigator',
      promptContent,
      question: 'parking',
    })
    const usedCount = result.retrieved.filter(r => r.used).length
    const unusedCount = result.retrieved.filter(r => !r.used).length
    expect(usedCount).toBe(1)
    expect(unusedCount).toBeGreaterThanOrEqual(0)
  })

  it('drops citation markers pointing to nonexistent source numbers', async () => {
    // Use an explicit response text (not the echo default) so this test exercises
    // citation parsing in isolation from the test adapter's echo behavior.
    const llm = createTestLlmAdapter({ responseText: 'see [99]' })
    const result = await rag(llm, {
      promptName: 'navigator',
      promptContent,
      question: 'parking',
    })
    expect(result.citations).toEqual([])
  })

  it('passes caller messages through to LLM (multi-turn)', async () => {
    let captured: any
    const llm = {
      model: 'test',
      async complete(input: any) {
        captured = input
        return { text: 'ok', usage: { input_tokens: 0, output_tokens: 0 }, model: 'test' }
      },
    }
    await rag(llm as any, {
      promptName: 'navigator',
      promptContent,
      question: 'follow-up',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
      ],
    })
    // first two messages are history, third is the final user turn with context + question
    expect(captured.messages.length).toBe(3)
    expect(captured.messages[0]).toEqual({ role: 'user', content: 'first' })
    expect(captured.messages[1]).toEqual({ role: 'assistant', content: 'reply' })
    expect(captured.messages[2].role).toBe('user')
    expect(captured.messages[2].content).toContain('Source [1]:')
    expect(captured.messages[2].content).toContain('Question: follow-up')
  })

  it('uses prompt.system in the system field', async () => {
    let captured: any
    const llm = {
      model: 'test',
      async complete(input: any) {
        captured = input
        return { text: 'ok', usage: { input_tokens: 0, output_tokens: 0 }, model: 'test' }
      },
    }
    await rag(llm as any, {
      promptName: 'navigator',
      promptContent,
      question: 'q',
    })
    expect(captured.system).toBe(promptContent.system)
  })

  it('retrieved is deduplicated by external_id (one entry per document)', async () => {
    // Use max_chunks_per_doc=3 against a doc that chunks into multiple segments
    // so retrieval returns >1 chunk per doc; verify retrieved still has one entry per doc.
    const multiChunkBody = Array(6).fill('Parking permit information and application details for residents.').join('\n\n')
    await ingestDocument(pool, indexId, embedAdapter, {
      external_id: 'parking-long',
      title: 'Parking — extended',
      body: multiChunkBody,
      metadata: { source_url: 'https://phila.gov/parking/long' },
    }, config, { max_segment_tokens: 15 })

    const llm = createTestLlmAdapter({ withCitations: [1] })
    const multiChunkPrompt = { ...promptContent, retrieval: { ...promptContent.retrieval, limit: 10, max_chunks_per_doc: 3 } }
    const result = await rag(llm, {
      promptName: 'navigator',
      promptContent: multiChunkPrompt,
      question: 'parking',
    })

    const ids = result.retrieved.map(r => r.external_id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('ragAuth integration', () => {
  let pool: Pool

  beforeAll(async () => {
    // The route's getPool() reads env vars and constructs a production pool;
    // point it at the same test container the rest of the suite uses.
    process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost'
    process.env.DB_PORT = process.env.TEST_DB_PORT || '5433'
    process.env.DB_NAME = process.env.TEST_DB_NAME || 'pgsearch_test'
    process.env.DB_USER = process.env.TEST_DB_USER || 'pgsearch'
    process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'testpassword'

    await setupSchema()
    pool = await getTestPool()
  })
  afterAll(async () => { await teardownSchema(); await closePool() })
  afterEach(async () => { await cleanupTestData() })

  const app = new Hono()
  app.route('/', ragRoutes)

  it('returns 401 UNAUTHORIZED when rag_key_hash is null (RAG not enabled)', async () => {
    await createIndex(pool, { name: 'no-rag-yet' })
    // Intentionally do NOT call mintRagKey.

    const res = await app.request('/public/rag/no-rag-yet?prompt=any', {
      method: 'POST',
      headers: { 'x-rag-key': 'rag_anything', 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'q' }),
    })

    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.message).toMatch(/invalid rag key/i)
  })

  it('returns 401 UNAUTHORIZED when key is wrong but RAG is enabled', async () => {
    await createIndex(pool, { name: 'has-rag' })
    await mintKey(pool, 'has-rag', 'rag')

    const res = await app.request('/public/rag/has-rag?prompt=any', {
      method: 'POST',
      headers: { 'x-rag-key': 'rag_wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'q' }),
    })

    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })
})
