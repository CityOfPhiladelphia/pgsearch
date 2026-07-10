// ABOUTME: Hybrid search pipeline combining BM25F keyword scoring and pgvector similarity.
// ABOUTME: Two-pass retrieval with score floors, RRF fusion, and document deduplication.

import type { Pool } from 'pg'
import type { EmbeddingAdapter } from '@phila/search-embeddings'
import type { SearchIndex, SearchResponse, SearchResult } from '../types'
import { computeBM25F, computeRRF } from './score'

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

export type SearchMode = 'hybrid' | 'bm25' | 'semantic'
export type LexicalScorer = 'bm25f' | 'tsrank'

export interface HybridSearchOptions {
  limit?: number
  mode?: SearchMode
  minBm25Score?: number
  minVectorScore?: number
  maxChunksPerDoc?: number
  lexical?: LexicalScorer
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
  index: SearchIndex,
  adapter: EmbeddingAdapter,
  queryText: string,
  options: HybridSearchOptions = {},
): Promise<SearchResponse> {
  const indexId = index.index_id
  const limit = options.limit ?? 10
  const mode = options.mode ?? 'hybrid'
  const lexical = options.lexical ?? 'bm25f'
  const runBm25 = mode !== 'semantic'
  const runVector = mode !== 'bm25'

  const config = index.config
  const totalDocuments = Number(index.total_documents)
  const avgTitleLength = Number(index.avg_title_length)
  const avgBodyLength = Number(index.avg_body_length)

  const textSearchConfig: string = config.text_search_config || 'english'
  const k1: number = config.bm25_k1 ?? 1.2
  const b: number = config.bm25_b ?? 0.75
  const fieldWeights = config.field_weights ?? { title: 3.0, body: 1.0 }
  // Parse tsquery and stem terms (only needed for BM25 pass)
  let tsquery: string | null = null
  let queryTerms: string[] = []
  if (runBm25) {
    const [tsqueryResult, terms] = await Promise.all([
      pool.query(
        `SELECT plainto_tsquery($1, $2) AS tsquery`,
        [textSearchConfig, queryText],
      ),
      lexical === 'bm25f'
        ? stemQueryTerms(pool, queryText, textSearchConfig)
        : Promise.resolve([]),
    ])
    tsquery = tsqueryResult.rows[0].tsquery
    queryTerms = terms
  }

  // The tsrank scorer ranks candidates in SQL before the limit, so the true top
  // matches always enter the pool; weights map title to the A slot and body to D,
  // normalized to ts_rank_cd's required [0,1] range (only the ratio affects ranking).
  const weightScale = Math.max(fieldWeights.title, fieldWeights.body)
  const lexicalCandidateQuery = lexical === 'tsrank'
    ? {
        text: `SELECT s.segment_id, s.document_id, s.body, d.title, d.external_id, d.metadata,
                      ts_rank_cd(ARRAY[$4, 0.2, 0.4, $3]::float4[],
                                 setweight(coalesce(d.title_tsvector, ''::tsvector), 'A') ||
                                 setweight(coalesce(s.body_tsvector, ''::tsvector), 'D'),
                                 $2, 1) AS lex_score
               FROM search_segments s
               JOIN search_documents d ON d.document_id = s.document_id
               WHERE s.index_id = $1
                 AND (s.body_tsvector @@ $2 OR d.title_tsvector @@ $2)
               ORDER BY lex_score DESC
               LIMIT 200`,
        values: [indexId, tsquery, fieldWeights.title / weightScale, fieldWeights.body / weightScale],
      }
    : {
        text: `SELECT s.segment_id, s.document_id, s.body, s.body_length, s.body_tsvector,
                      d.title, d.external_id, d.title_tsvector, d.title_length, d.metadata
               FROM search_segments s
               JOIN search_documents d ON d.document_id = s.document_id
               WHERE s.index_id = $1
                 AND (s.body_tsvector @@ $2 OR d.title_tsvector @@ $2)
               LIMIT 200`,
        values: [indexId, tsquery],
      }

  // Run lexical and vector passes concurrently
  const [bm25Rows, embeddingResults] = await Promise.all([
    runBm25 && tsquery
      ? pool.query(lexicalCandidateQuery)
      : Promise.resolve({ rows: [] }),
    runVector
      ? adapter.embed([queryText])
      : Promise.resolve([] as number[][]),
  ])

  let vectorResults: VectorCandidate[] = []
  if (runVector && embeddingResults.length > 0) {
    vectorResults = await vectorCandidates(pool, indexId, embeddingResults[0], 200)
  }

  // Look up document frequencies for query terms (only needed for BM25 pass)
  const dfMap = new Map<string, number>()
  if (runBm25 && queryTerms.length > 0) {
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

  // Process lexical candidates
  for (const row of bm25Rows.rows) {
    let bm25Score: number
    if (lexical === 'tsrank') {
      bm25Score = parseFloat(row.lex_score)
    } else {
      const bodyTf = parseTsvectorTf(row.body_tsvector)
      const titleTf = parseTsvectorTf(row.title_tsvector)

      const termFreqs = queryTerms.map(term => ({
        term,
        titleTf: titleTf.get(term) ?? 0,
        bodyTf: bodyTf.get(term) ?? 0,
        df: dfMap.get(term) ?? 0,
      }))

      bm25Score = computeBM25F({
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
    }

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

  const segments = Array.from(segmentMap.values())

  const rrfK: number = config.rrf_k ?? 60
  const rrfWeights = config.rrf_weights ?? { bm25: 1.0, vector: 1.0 }
  const minBm25Score = options.minBm25Score ?? config.min_bm25_score ?? 0
  const minVectorScore = options.minVectorScore ?? config.min_vector_score ?? 0

  // Assign 1-based ranks per retriever (sorted by raw score descending), applying score floors
  const bm25Ranked = segments
    .filter(s => s.bm25Score > minBm25Score)
    .sort((a, b) => b.bm25Score - a.bm25Score)
  const bm25RankMap = new Map<string, number>()
  bm25Ranked.forEach((s, i) => bm25RankMap.set(s.segment_id, i + 1))

  const vectorRanked = segments
    .filter(s => s.vectorScore > minVectorScore)
    .sort((a, b) => b.vectorScore - a.vectorScore)
  const vectorRankMap = new Map<string, number>()
  vectorRanked.forEach((s, i) => vectorRankMap.set(s.segment_id, i + 1))

  // Compute RRF score for each segment
  const scored = segments
    .map(s => {
      const bm25Rank = bm25RankMap.get(s.segment_id)
      const vectorRank = vectorRankMap.get(s.segment_id)
      // Segments excluded by both score floors are dropped
      if (bm25Rank == null && vectorRank == null) return null
      const score = computeRRF({ bm25Rank, vectorRank, k: rrfK, weights: rrfWeights })
      return { ...s, score }
    })
    .filter((s): s is NonNullable<typeof s> => s != null)

  if (scored.length === 0) {
    return { results: [], total: 0, query: queryText }
  }

  const maxChunksPerDoc = options.maxChunksPerDoc ?? 1

  // Group by document, keep top-N per doc by score
  const byDoc = new Map<string, typeof scored>()
  for (const s of scored) {
    const list = byDoc.get(s.document_id) ?? []
    list.push(s)
    byDoc.set(s.document_id, list)
  }

  const capped: typeof scored = []
  for (const [, list] of byDoc) {
    list.sort((a, b) => b.score - a.score)
    capped.push(...list.slice(0, maxChunksPerDoc))
  }

  const deduped = capped
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const results: SearchResult[] = deduped.map(s => ({
    external_id: s.external_id,
    score: s.score,
    title: s.title,
    snippet: s.body,
    metadata: s.metadata,
  }))

  return {
    results,
    total: byDoc.size,
    query: queryText,
  }
}
