// ABOUTME: Integration tests for the RAG pipeline.
// ABOUTME: Uses test embedding + LLM adapters so retrieval and synthesis are deterministic.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { refreshIndex } from '../services/refresh'
import { createPrompt } from '../services/prompts'
import { runRag } from '../services/rag'
import { createTestAdapter } from '@phila/search-embeddings'
import { createTestLlmAdapter } from '@phila/llm'
import type { PromptContent } from '../types'

const promptContent: PromptContent = {
  system: 'You are helpful.',
  response_format: 'Cite [N].',
  model: 'anthropic.claude-haiku-4-5',
  max_tokens: 256,
  temperature: 0,
  retrieval: { mode: 'hybrid', limit: 4, max_chunks_per_doc: 2, min_bm25_score: 0, min_vector_score: 0 },
}

describe('runRag', () => {
  let pool: Pool
  let indexId: number
  const embedAdapter = createTestAdapter(384)

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
    })
    await ingestDocument(pool, indexId, embedAdapter, {
      external_id: 'parking-veterans',
      title: 'Veterans Parking Benefits',
      body: 'Veterans qualify for a reduced fee on residential parking permits.',
      metadata: { source_url: 'https://phila.gov/parking/veterans' },
    })

    // Refresh so BM25F has IDF data and avg field lengths are set
    await refreshIndex(pool, indexId)

    await createPrompt(pool, indexId, 'navigator', promptContent)
  })

  it('returns answer, citations, retrieved, model, usage, prompt name', async () => {
    const llm = createTestLlmAdapter({ withCitations: [1, 2] })
    const result = await runRag(pool, indexId, embedAdapter, llm, {
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
    expect(result.history_sig).toBeNull()
  })

  it('marks cited chunks as used=true and uncited as used=false', async () => {
    const llm = createTestLlmAdapter({ withCitations: [1] })
    const result = await runRag(pool, indexId, embedAdapter, llm, {
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
    const llm = createTestLlmAdapter({ withCitations: [99] })
    const result = await runRag(pool, indexId, embedAdapter, llm, {
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
    await runRag(pool, indexId, embedAdapter, llm as any, {
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
    await runRag(pool, indexId, embedAdapter, llm as any, {
      promptName: 'navigator',
      promptContent,
      question: 'q',
    })
    expect(captured.system).toBe(promptContent.system)
  })
})
