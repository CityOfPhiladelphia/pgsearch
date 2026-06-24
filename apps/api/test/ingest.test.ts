// ABOUTME: Integration tests for the document ingest pipeline.
// ABOUTME: Tests chunking, hash-based diffing, embedding generation, tsvector creation, and upsert logic.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument, deleteDocument } from '../services/ingest'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

describe('ingest service', () => {
  let pool: Pool
  let indexId: number
  const adapter = createTestAdapter(384)
  const config = mergeConfig({})

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    await createIndex(pool, { name: 'ingest-test' })
    const row = await pool.query("SELECT index_id FROM search_indexes WHERE name = 'ingest-test'")
    indexId = row.rows[0].index_id
  })
  afterAll(async () => { await teardownSchema(); await closePool() })
  afterEach(async () => {
    await pool.query('DELETE FROM search_segments WHERE index_id = $1', [indexId])
    await pool.query('DELETE FROM search_documents WHERE index_id = $1', [indexId])
    await pool.query("UPDATE search_indexes SET total_documents = 0, docs_changed_since_refresh = 0 WHERE index_id = $1", [indexId])
  })

  it('ingests a document and creates segments', async () => {
    const result = await ingestDocument(pool, indexId, adapter, {
      external_id: 'doc-1',
      title: 'Test Document',
      body: 'This is the body of the test document with enough content to form a segment.',
    }, config)
    expect(result.external_id).toBe('doc-1')
    expect(result.segments).toBeGreaterThan(0)
    expect(result.status).toBe('indexed')
  })

  it('upserts without re-embedding unchanged segments', async () => {
    const doc = {
      external_id: 'doc-2',
      title: 'Upsert Test',
      body: 'Content that will not change between ingests.',
    }
    const first = await ingestDocument(pool, indexId, adapter, doc, config)
    const second = await ingestDocument(pool, indexId, adapter, doc, config)
    expect(second.unchanged).toBe(first.segments)
    expect(second.changed).toBe(0)
  })

  it('detects changed content and re-embeds', async () => {
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'doc-3',
      title: 'Change Test',
      body: 'Original content here.',
    }, config)
    const result = await ingestDocument(pool, indexId, adapter, {
      external_id: 'doc-3',
      title: 'Change Test',
      body: 'Updated content here that is different.',
    }, config)
    expect(result.changed).toBeGreaterThan(0)
  })

  it('uses the config passed in rather than re-reading it from the database', async () => {
    // The stored index config uses text_search_config 'english', which stems words.
    // Passing 'simple' must win, leaving words unstemmed in the body tsvector — proving
    // the service sources config from its argument, not a second database read.
    const simpleConfig = mergeConfig({ text_search_config: 'simple' })
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'config-source',
      title: 'Config Source',
      body: 'running quickly through testing.',
    }, simpleConfig)
    const seg = await pool.query(
      `SELECT s.body_tsvector::text AS tsv FROM search_segments s
       JOIN search_documents d ON d.document_id = s.document_id
       WHERE d.external_id = 'config-source' AND s.index_id = $1`,
      [indexId]
    )
    expect(seg.rows[0].tsv).toContain("'running'")
  })

  it('dedupes identical segments within a document', async () => {
    const paragraph = Array(55).fill('word').join(' ')
    const body = `${paragraph}\n\n${paragraph}`
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'dup-seg',
      title: 'Dup Test',
      body,
    }, config, { max_segment_tokens: 60, max_segments_per_document: 10 })

    const doc = await pool.query(
      "SELECT document_id, segment_count FROM search_documents WHERE external_id = 'dup-seg' AND index_id = $1", [indexId]
    )
    const seg = await pool.query(
      'SELECT COUNT(*)::int AS n FROM search_segments WHERE document_id = $1', [doc.rows[0].document_id]
    )
    expect(seg.rows[0].n).toBe(1)
    expect(doc.rows[0].segment_count).toBe(1)
  })

  it('auto-refreshes when ingest crosses the refresh threshold', async () => {
    const lowThreshold = mergeConfig({ refresh_threshold: 1 })
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'auto-refresh',
      title: 'Auto Refresh',
      body: 'Content that should trigger a refresh on ingest.',
    }, lowThreshold)
    const idx = await pool.query(
      'SELECT docs_changed_since_refresh, last_refreshed_at FROM search_indexes WHERE index_id = $1',
      [indexId]
    )
    expect(idx.rows[0].last_refreshed_at).not.toBeNull()
    expect(idx.rows[0].docs_changed_since_refresh).toBe(0)
  })

  it('rejects documents exceeding segment limit', async () => {
    const longBody = Array(200).fill('A paragraph with several words. Another sentence here.').join('\n\n')
    await expect(
      ingestDocument(pool, indexId, adapter, {
        external_id: 'too-long',
        title: 'Too Long',
        body: longBody,
      }, config, { max_segments_per_document: 5, max_segment_tokens: 10 })
    ).rejects.toThrow()
  })

  it('generates tsvectors for title and body', async () => {
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'tsvector-test',
      title: 'Parking Permits',
      body: 'Apply for a residential parking permit online.',
    }, config)
    const doc = await pool.query(
      "SELECT document_id, title_tsvector FROM search_documents WHERE external_id = 'tsvector-test' AND index_id = $1", [indexId]
    )
    expect(doc.rows[0].title_tsvector).toBeTruthy()

    const seg = await pool.query(
      "SELECT body_tsvector FROM search_segments WHERE document_id = $1",
      [doc.rows[0].document_id]
    )
    expect(seg.rows[0].body_tsvector).toBeTruthy()
  })

  it('stores embeddings on segments', async () => {
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'embed-test',
      title: 'Embedding Test',
      body: 'Content for embedding verification.',
    }, config)
    const doc = await pool.query("SELECT document_id FROM search_documents WHERE external_id = 'embed-test' AND index_id = $1", [indexId])
    const seg = await pool.query("SELECT embedding FROM search_segments WHERE document_id = $1", [doc.rows[0].document_id])
    expect(seg.rows[0].embedding).toBeTruthy()
    // Embedding should be the right dimension (384 for test adapter)
    const embedding = seg.rows[0].embedding
    // pgvector returns embedding as string like '[0.1,0.2,...]' or as array depending on type registration
    if (typeof embedding === 'string') {
      const parsed = JSON.parse(embedding)
      expect(parsed).toHaveLength(384)
    } else if (Array.isArray(embedding)) {
      expect(embedding).toHaveLength(384)
    }
  })

  it('increments total_documents on new document', async () => {
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'counter-1',
      title: 'First',
      body: 'First document content.',
    }, config)
    const idx = await pool.query('SELECT total_documents FROM search_indexes WHERE index_id = $1', [indexId])
    expect(idx.rows[0].total_documents).toBe(1)
  })

  it('does not increment total_documents on upsert of existing document', async () => {
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'counter-dup',
      title: 'First',
      body: 'Content here.',
    }, config)
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'counter-dup',
      title: 'First Updated',
      body: 'Updated content.',
    }, config)
    const idx = await pool.query('SELECT total_documents FROM search_indexes WHERE index_id = $1', [indexId])
    expect(idx.rows[0].total_documents).toBe(1)
  })

  it('deletes a document and decrements total_documents', async () => {
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'to-delete',
      title: 'Delete Me',
      body: 'Content to be deleted.',
    }, config)
    const before = await pool.query('SELECT total_documents FROM search_indexes WHERE index_id = $1', [indexId])
    await deleteDocument(pool, indexId, 'to-delete')
    const after = await pool.query('SELECT total_documents FROM search_indexes WHERE index_id = $1', [indexId])
    expect(after.rows[0].total_documents).toBe(before.rows[0].total_documents - 1)

    const doc = await pool.query("SELECT * FROM search_documents WHERE external_id = 'to-delete' AND index_id = $1", [indexId])
    expect(doc.rows).toHaveLength(0)
  })
})
