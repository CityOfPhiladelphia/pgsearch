// ABOUTME: Document ingest pipeline for pgsearch.
// ABOUTME: Handles chunking, content hashing, diff-based embedding, tsvector generation, and upsert.

import assert from 'assert'
import crypto from 'crypto'
import type { Pool } from 'pg'
import type { EmbeddingAdapter } from '@phila/search-embeddings'
import type { IngestRequest, IngestResponse, IndexConfig } from '../types'
import { chunkText } from './chunk'

interface IngestConfigOverrides {
  max_segments_per_document?: number
  max_segment_tokens?: number
}

export async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn() }
    catch (err: any) {
      // 40P01 deadlock_detected, 40001 serialization_failure
      if ((err?.code === '40P01' || err?.code === '40001') && i < attempts - 1) continue
      throw err
    }
  }
}

function hashContent(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

export async function ingestDocument(
  pool: Pool,
  indexId: number,
  adapter: EmbeddingAdapter,
  request: IngestRequest,
  config: IndexConfig,
  configOverrides?: IngestConfigOverrides,
): Promise<IngestResponse> {
  const maxSegmentTokens = configOverrides?.max_segment_tokens ?? config.max_segment_tokens
  const maxSegmentsPerDoc = configOverrides?.max_segments_per_document ?? config.max_segments_per_document

  // Chunk the body text
  const segments = chunkText(request.body, maxSegmentTokens)

  // Guardrail: reject if too many segments
  assert(
    segments.length <= maxSegmentsPerDoc,
    `Document produces ${segments.length} segments, exceeding limit of ${maxSegmentsPerDoc}`
  )

  // Diff against existing document
  const existingDoc = await pool.query(
    'SELECT document_id, title FROM search_documents WHERE index_id = $1 AND external_id = $2',
    [indexId, request.external_id],
  )
  const existingDocumentId: string | undefined = existingDoc.rows[0]?.document_id

  const existingHashes = new Set<string>()
  if (existingDocumentId) {
    const hashRows = await pool.query(
      'SELECT content_hash FROM search_segments WHERE document_id = $1',
      [existingDocumentId]
    )
    for (const row of hashRows.rows) {
      existingHashes.add(row.content_hash)
    }
  }

  // Partition new segments by content hash so the hash travels with its index.
  // Segments with identical content collapse to one entry: the store dedupes on
  // content_hash, trading exact lexical term-frequency fidelity for an idempotent,
  // simpler store. Acceptable for search; revisit if duplicate chunks must count distinctly.
  const changed = new Map<string, number>()    // content_hash -> segment index (needs embedding)
  const unchanged = new Map<string, number>()  // content_hash -> segment index (already stored)
  segments.forEach((segment, i) => {
    const hash = hashContent(segment)
    if (changed.has(hash) || unchanged.has(hash)) return
    ;(existingHashes.has(hash) ? unchanged : changed).set(hash, i)
  })

  const removedHashes = [...existingHashes].filter(h => !changed.has(h) && !unchanged.has(h))
  const storedSegmentCount = changed.size + unchanged.size

  // Embed only changed segments (prepend title for context)
  const changedEntries = [...changed]  // [content_hash, segment index][]
  let embeddings: number[][] = []
  if (changedEntries.length > 0) {
    const textsToEmbed = changedEntries.map(([, i]) => `${request.title}\n\n${segments[i]}`)
    embeddings = await adapter.embed(textsToEmbed)
  }

  const textSearchConfig = config.text_search_config || 'english'

  // Execute everything in a transaction (retried on transient deadlock/serialization errors)
  const response = await withDeadlockRetry(async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Upsert document
      const upsertResult = await client.query(
        `INSERT INTO search_documents (index_id, external_id, title, title_tsvector, metadata, segment_count, kind)
         VALUES ($1, $2, $3, to_tsvector($4, $5), $6, $7, $8)
         ON CONFLICT (index_id, external_id) DO UPDATE SET
           title = $3,
           title_tsvector = to_tsvector($4, $5),
           metadata = $6,
           segment_count = $7,
           kind = $8,
           updated_at = NOW()
         RETURNING document_id, (xmax = 0) AS is_insert`,
        [
          indexId,
          request.external_id,
          request.title,
          textSearchConfig,
          request.title,
          JSON.stringify(request.metadata || {}),
          storedSegmentCount,
          request.kind ?? null,
        ]
      )

      const documentId = upsertResult.rows[0].document_id
      const isInsert = upsertResult.rows[0].is_insert

      // Delete removed segments
      if (removedHashes.length > 0) {
        await client.query(
          'DELETE FROM search_segments WHERE document_id = $1 AND content_hash = ANY($2)',
          [documentId, removedHashes]
        )
      }

      // Update segment_index for unchanged segments (position may have changed)
      for (const [hash, i] of unchanged) {
        await client.query(
          'UPDATE search_segments SET segment_index = $1 WHERE document_id = $2 AND content_hash = $3',
          [i, documentId, hash]
        )
      }

      // Insert segments with new content
      for (let j = 0; j < changedEntries.length; j++) {
        const [hash, i] = changedEntries[j]
        const embedding = embeddings[j]
        const segBody = segments[i]

        await client.query(
          `INSERT INTO search_segments (document_id, index_id, segment_index, body, content_hash, embedding, body_tsvector)
           VALUES ($1, $2, $3, $4, $5, $6::vector, to_tsvector($7, $8))`,
          [
            documentId,
            indexId,
            i,
            segBody,
            hash,
            JSON.stringify(embedding),
            textSearchConfig,
            segBody,
          ]
        )
      }

      // Update index counters
      if (isInsert) {
        await client.query(
          'UPDATE search_indexes SET total_documents = total_documents + 1 WHERE index_id = $1',
          [indexId]
        )
      }

      await client.query('COMMIT')

      return {
        external_id: request.external_id,
        segments: storedSegmentCount,
        changed: changed.size,
        unchanged: unchanged.size,
        status: 'indexed',
      } as IngestResponse
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
  return response
}

export async function deleteDocument(
  pool: Pool,
  indexId: number,
  externalId: string,
): Promise<void> {
  // Unlike ingestDocument this is not wrapped in withDeadlockRetry: writes to one
  // index serialize on the search_indexes row lock (the total_documents UPDATE),
  // so an ingest/delete deadlock cannot form.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const found = await client.query(
      'SELECT document_id FROM search_documents WHERE index_id = $1 AND external_id = $2',
      [indexId, externalId],
    )
    if (found.rows.length === 0) { await client.query('COMMIT'); return }
    const documentId = found.rows[0].document_id

    await client.query('DELETE FROM search_documents WHERE document_id = $1', [documentId]) // segments cascade

    await client.query(
      'UPDATE search_indexes SET total_documents = total_documents - 1 WHERE index_id = $1',
      [indexId],
    )

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
