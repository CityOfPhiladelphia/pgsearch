// ABOUTME: Hybrid search pipeline combining BM25F keyword scoring and pgvector similarity.
// ABOUTME: Two-pass retrieval with score normalization, blending, and document deduplication.

import type { Pool } from 'pg'
import type { EmbeddingAdapter } from '@phila/search-embeddings'
import type { SearchResponse, SearchResult } from '../types'
import { computeBM25F, normalizeScores } from './score'

export interface VectorCandidate {
  segment_id: string
  document_id: string
  body: string
  body_length: number
  segment_index: number
  similarity: number
}

interface BM25Candidate {
  segment_id: string
  document_id: string
  body: string
  body_length: number
  body_tsvector: string
  title: string
  external_id: string
  title_tsvector: string
  title_length: number
  metadata: Record<string, unknown>
}

export interface HybridSearchOptions {
  limit?: number
}

export async function vectorCandidates(
  pool: Pool,
  indexId: number,
  queryEmbedding: number[],
  limit: number,
): Promise<VectorCandidate[]> {
  const embeddingStr = `[${queryEmbedding.join(',')}]`
  const result = await pool.query(
    `SELECT s.segment_id, s.document_id, s.body, s.body_length, s.segment_index,
            1 - (s.embedding <=> $1::vector) AS similarity
     FROM search_segments s
     WHERE s.index_id = $2
     ORDER BY s.embedding <=> $1::vector
     LIMIT $3`,
    [embeddingStr, indexId, limit],
  )

  return result.rows.map(row => ({
    segment_id: row.segment_id,
    document_id: row.document_id,
    body: row.body,
    body_length: parseInt(row.body_length, 10),
    segment_index: parseInt(row.segment_index, 10),
    similarity: parseFloat(row.similarity),
  }))
}

// Parses a PostgreSQL tsvector text representation and returns per-term position counts (term frequency).
// A tsvector looks like: 'apply':1 'parking':3,5 'permit':4
function parseTsvectorTf(tsvector: string): Map<string, number> {
  const tf = new Map<string, number>()
  if (!tsvector) return tf

  // Match lexeme entries: 'word':pos1,pos2,...
  const lexemePattern = /'([^']+)'(?::([0-9A-C,]+))?/g
  let match
  while ((match = lexemePattern.exec(tsvector)) !== null) {
    const word = match[1]
    const positions = match[2] ? match[2].split(',').length : 1
    tf.set(word, positions)
  }
  return tf
}

// Stems query terms using PostgreSQL's text search normalization, returning lexemes.
async function stemQueryTerms(pool: Pool, queryText: string, config: string): Promise<string[]> {
  const result = await pool.query(
    `SELECT unnest(tsvector_to_array(to_tsvector($1, $2))) AS term`,
    [config, queryText],
  )
  return result.rows.map((r: any) => r.term)
}

export async function hybridSearch(
  pool: Pool,
  indexId: number,
  adapter: EmbeddingAdapter,
  queryText: string,
  options: HybridSearchOptions = {},
): Promise<SearchResponse> {
  const limit = options.limit ?? 10

  // Load index config and statistics
  const indexRow = await pool.query(
    `SELECT config, total_documents, avg_title_length, avg_body_length
     FROM search_indexes WHERE index_id = $1`,
    [indexId],
  )
  if (indexRow.rows.length === 0) {
    throw new Error(`Index ${indexId} not found`)
  }
  const idx = indexRow.rows[0]
  const config = typeof idx.config === 'string' ? JSON.parse(idx.config) : idx.config
  const totalDocuments: number = parseInt(idx.total_documents, 10)
  const avgTitleLength: number = parseFloat(idx.avg_title_length)
  const avgBodyLength: number = parseFloat(idx.avg_body_length)

  const textSearchConfig: string = config.text_search_config || 'english'
  const k1: number = config.bm25_k1 ?? 1.2
  const b: number = config.bm25_b ?? 0.75
  const fieldWeights = config.field_weights ?? { title: 3.0, body: 1.0 }
  const blendAlpha: number = config.blend_alpha ?? 0.6

  // Parse the query into a tsquery
  const tsqueryResult = await pool.query(
    `SELECT plainto_tsquery($1, $2) AS tsquery`,
    [textSearchConfig, queryText],
  )
  const tsquery = tsqueryResult.rows[0].tsquery

  // Stem query terms to match stored lexemes
  const queryTerms = await stemQueryTerms(pool, queryText, textSearchConfig)

  // Run BM25F and vector passes concurrently
  const [bm25Rows, embeddingResults] = await Promise.all([
    tsquery
      ? pool.query(
          `SELECT s.segment_id, s.document_id, s.body, s.body_length, s.body_tsvector,
                  d.title, d.external_id, d.title_tsvector, d.title_length, d.metadata
           FROM search_segments s
           JOIN search_documents d ON d.document_id = s.document_id
           WHERE s.index_id = $1
             AND (s.body_tsvector @@ $2 OR d.title_tsvector @@ $2)
           LIMIT 200`,
          [indexId, tsquery],
        )
      : Promise.resolve({ rows: [] }),
    adapter.embed([queryText]),
  ])

  const queryEmbedding = embeddingResults[0]
  const vectorResults = await vectorCandidates(pool, indexId, queryEmbedding, 200)

  // Look up document frequencies for query terms
  const dfMap = new Map<string, number>()
  if (queryTerms.length > 0) {
    const dfResult = await pool.query(
      `SELECT term, document_frequency
       FROM term_document_frequencies
       WHERE index_id = $1 AND term = ANY($2)`,
      [indexId, queryTerms],
    )
    for (const row of dfResult.rows) {
      dfMap.set(row.term, parseInt(row.document_frequency, 10))
    }
  }

  // Compute BM25F score for each BM25 candidate
  interface ScoredSegment {
    segment_id: string
    document_id: string
    external_id: string
    title: string
    body: string
    metadata: Record<string, unknown>
    bm25Score: number
    vectorScore: number
  }

  const segmentMap = new Map<string, ScoredSegment>()

  // Process BM25F candidates
  for (const row of bm25Rows.rows) {
    const bodyTf = parseTsvectorTf(row.body_tsvector)
    const titleTf = parseTsvectorTf(row.title_tsvector)

    const termFreqs = queryTerms.map(term => ({
      term,
      titleTf: titleTf.get(term) ?? 0,
      bodyTf: bodyTf.get(term) ?? 0,
      df: dfMap.get(term) ?? 0,
    }))

    const bm25Score = computeBM25F({
      termFreqs,
      titleLength: parseInt(row.title_length, 10),
      bodyLength: parseInt(row.body_length, 10),
      k1,
      b,
      fieldWeights,
      avgTitleLength,
      avgBodyLength,
      totalDocuments,
    })

    segmentMap.set(row.segment_id, {
      segment_id: row.segment_id,
      document_id: row.document_id,
      external_id: row.external_id,
      title: row.title,
      body: row.body,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
      bm25Score,
      vectorScore: 0,
    })
  }

  // Process vector candidates — fetch document info for any not already in map
  const vectorOnlyIds = vectorResults
    .filter(v => !segmentMap.has(v.segment_id))
    .map(v => v.segment_id)

  if (vectorOnlyIds.length > 0) {
    const docInfoResult = await pool.query(
      `SELECT s.segment_id, s.document_id, s.body,
              d.title, d.external_id, d.metadata
       FROM search_segments s
       JOIN search_documents d ON d.document_id = s.document_id
       WHERE s.segment_id = ANY($1)`,
      [vectorOnlyIds],
    )
    for (const row of docInfoResult.rows) {
      segmentMap.set(row.segment_id, {
        segment_id: row.segment_id,
        document_id: row.document_id,
        external_id: row.external_id,
        title: row.title,
        body: row.body,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
        bm25Score: 0,
        vectorScore: 0,
      })
    }
  }

  // Merge vector scores into segmentMap
  for (const v of vectorResults) {
    const entry = segmentMap.get(v.segment_id)
    if (entry) {
      entry.vectorScore = v.similarity
    }
  }

  if (segmentMap.size === 0) {
    return { results: [], total: 0, query: queryText }
  }

  const segments = Array.from(segmentMap.values())

  // Normalize scores independently
  const bm25Scores = segments.map(s => s.bm25Score)
  const vectorScores = segments.map(s => s.vectorScore)
  const normalizedBm25 = normalizeScores(bm25Scores)
  const normalizedVector = normalizeScores(vectorScores)

  // Blend scores and attach to segments
  const scored = segments.map((s, i) => ({
    ...s,
    blendedScore: blendAlpha * normalizedBm25[i] + (1 - blendAlpha) * normalizedVector[i],
  }))

  // Deduplicate: keep the highest-scoring segment per document
  const bestByDoc = new Map<string, typeof scored[0]>()
  for (const s of scored) {
    const existing = bestByDoc.get(s.document_id)
    if (!existing || s.blendedScore > existing.blendedScore) {
      bestByDoc.set(s.document_id, s)
    }
  }

  const deduped = Array.from(bestByDoc.values())
    .sort((a, b) => b.blendedScore - a.blendedScore)
    .slice(0, limit)

  const results: SearchResult[] = deduped.map(s => ({
    external_id: s.external_id,
    score: s.blendedScore,
    title: s.title,
    snippet: s.body,
    metadata: s.metadata,
  }))

  return {
    results,
    total: bestByDoc.size,
    query: queryText,
  }
}
