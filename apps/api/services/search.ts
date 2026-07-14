// ABOUTME: Hybrid search pipeline combining SQL-ranked keyword scoring and pgvector similarity.
// ABOUTME: Two-pass retrieval with score floors, RRF fusion, and document deduplication.

import type { Pool } from 'pg'
import type { EmbeddingAdapter } from '@phila/search-embeddings'
import type { RecencyRule, SearchIndex, SearchResponse, SearchResult } from '../types'
import { computeRRF } from './score'

export interface VectorCandidate {
  segment_id: string
  document_id: string
  body: string
  segment_index: number
  content_hash: string
  similarity: number
}

export type SearchMode = 'hybrid' | 'lexical' | 'semantic'

export interface FusedCandidate {
  score: number
  lexicalRank: number | null
  vectorRank: number | null
  lexicalScore: number
  vectorScore: number
  external_id: string
}

// Orders fused results. Beyond the RRF score: candidates found by both passes carry
// more evidence than single-pass ties, and among single-pass ties the vector side wins —
// a keyword-only candidate invisible to the vector pass usually matched incidental body
// terms, while a vector-only candidate lacking term overlap is the vocabulary mismatch
// the vector pass exists to bridge. external_id last, so ordering is total and stable
// across runs.
export function fusionOrder(a: FusedCandidate, b: FusedCandidate): number {
  if (b.score !== a.score) return b.score - a.score
  const passesA = (a.lexicalRank != null ? 1 : 0) + (a.vectorRank != null ? 1 : 0)
  const passesB = (b.lexicalRank != null ? 1 : 0) + (b.vectorRank != null ? 1 : 0)
  if (passesB !== passesA) return passesB - passesA
  const vectorA = a.vectorRank != null ? 1 : 0
  const vectorB = b.vectorRank != null ? 1 : 0
  if (vectorB !== vectorA) return vectorB - vectorA
  if (b.lexicalScore !== a.lexicalScore) return b.lexicalScore - a.lexicalScore
  if (b.vectorScore !== a.vectorScore) return b.vectorScore - a.vectorScore
  return a.external_id < b.external_id ? -1 : a.external_id > b.external_id ? 1 : 0
}

export interface HybridSearchOptions {
  limit?: number
  mode?: SearchMode
  minLexicalScore?: number
  minVectorScore?: number
  maxChunksPerDoc?: number
  kindWeights?: Record<string, number>
  recency?: RecencyRule
  /** Restrict results to these kinds; filtering happens in SQL in both passes. */
  kinds?: string[]
}

const DAY_MS = 86_400_000

// Time decay on the fused score: a doc published now is neutral (1.0) and age
// converges to the floor, so old news sinks a bounded number of ranks instead
// of falling without limit. Docs with no parseable published_at, kinds outside
// the rule, and future dates are all neutral — strictly opt-in, like kind weights.
export function recencyMultiplier(
  rule: RecencyRule | undefined,
  kind: string | null,
  metadata: Record<string, unknown>,
  nowMs: number,
): number {
  if (!rule || kind == null || !rule.kinds.includes(kind)) return 1
  const published = typeof metadata.published_at === 'string' ? Date.parse(metadata.published_at) : NaN
  if (Number.isNaN(published)) return 1
  const ageDays = Math.max(0, (nowMs - published) / DAY_MS)
  return rule.floor + (1 - rule.floor) * 2 ** (-ageDays / rule.half_life_days)
}

// The cast to a dimensioned vector must appear verbatim in ORDER BY: the per-index
// HNSW indexes are expression indexes on (embedding::vector(dims)), and the planner
// only matches the identical expression. dims is interpolated (typmods cannot be
// parameterized) and validated as an integer.
export function vectorCandidatesSql(dims: number, kindFiltered = false): string {
  if (!Number.isInteger(dims) || dims <= 0) throw new Error(`invalid embedding dimensions: ${dims}`)
  // The kind filter joins documents and discards non-matching rows from the HNSW
  // scan frontier, so filtered scans run with ef_search at its ceiling to keep
  // enough survivors for the candidate limit.
  const join = kindFiltered ? 'JOIN search_documents d ON d.document_id = s.document_id' : ''
  const filter = kindFiltered ? 'AND d.kind = ANY($4)' : ''
  return `SELECT s.segment_id, s.document_id, s.body, s.segment_index, s.content_hash,
            1 - ((s.embedding)::vector(${dims}) <=> $1::vector) AS similarity
     FROM search_segments s ${join}
     WHERE s.index_id = $2 ${filter}
     ORDER BY (s.embedding)::vector(${dims}) <=> $1::vector
     LIMIT $3`
}

export async function vectorCandidates(
  pool: Pool,
  indexId: number,
  dims: number,
  queryEmbedding: number[],
  limit: number,
  kinds?: string[],
): Promise<VectorCandidate[]> {
  const sql = vectorCandidatesSql(dims, kinds != null)
  const embeddingStr = `[${queryEmbedding.join(',')}]`
  const client = await pool.connect()
  let result
  try {
    await client.query('BEGIN')
    // HNSW returns at most ef_search rows (default 40); it must cover the candidate
    // limit or the index silently truncates the list — a membership error under RRF.
    // SET LOCAL scopes it to this transaction, which pooled connections require.
    const efSearch = kinds != null ? 1000 : Math.min(Math.max(limit, 40), 1000)
    await client.query(`SET LOCAL hnsw.ef_search = ${efSearch}`)
    const params: unknown[] = [embeddingStr, indexId, limit]
    if (kinds != null) params.push(kinds)
    result = await client.query(sql, params)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  return result.rows.map(row => ({
    segment_id: row.segment_id,
    document_id: row.document_id,
    body: row.body,
    segment_index: parseInt(row.segment_index, 10),
    content_hash: row.content_hash,
    similarity: parseFloat(row.similarity),
  }))
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
  const runLexical = mode !== 'semantic'
  const runVector = mode !== 'lexical'

  const config = index.config

  const textSearchConfig: string = config.text_search_config || 'english'
  const fieldWeights = config.field_weights ?? { title: 3.0, body: 1.0 }

  let tsquery: string | null = null
  if (runLexical) {
    const tsqueryResult = await pool.query(
      `SELECT plainto_tsquery($1, $2) AS tsquery`,
      [textSearchConfig, queryText],
    )
    tsquery = tsqueryResult.rows[0].tsquery
  }

  // The lexical pass ranks candidates in SQL before the limit, so the true top
  // matches always enter the pool; weights map title to the A slot and body to D,
  // normalized to ts_rank_cd's required [0,1] range (only the ratio affects ranking).
  const weightScale = Math.max(fieldWeights.title, fieldWeights.body)

  // Run lexical and vector passes concurrently
  const [lexicalRows, embeddingResults] = await Promise.all([
    runLexical && tsquery
      ? pool.query(
          `SELECT s.segment_id, s.document_id, s.body, s.content_hash, d.title, d.external_id, d.kind, d.metadata,
                  ts_rank_cd(ARRAY[$4, 0.2, 0.4, $3]::float4[],
                             setweight(coalesce(d.title_tsvector, ''::tsvector), 'A') ||
                             setweight(coalesce(s.body_tsvector, ''::tsvector), 'D'),
                             $2, 1) AS lex_score
           FROM search_segments s
           JOIN search_documents d ON d.document_id = s.document_id
           WHERE s.index_id = $1
             AND (s.body_tsvector @@ $2 OR d.title_tsvector @@ $2)
             AND ($5::text[] IS NULL OR d.kind = ANY($5))
           ORDER BY lex_score DESC
           LIMIT 200`,
          [indexId, tsquery, fieldWeights.title / weightScale, fieldWeights.body / weightScale, options.kinds ?? null],
        )
      : Promise.resolve({ rows: [] }),
    runVector
      ? adapter.embed([queryText])
      : Promise.resolve([] as number[][]),
  ])

  let vectorResults: VectorCandidate[] = []
  if (runVector && embeddingResults.length > 0) {
    vectorResults = await vectorCandidates(pool, indexId, config.embedding.dimensions, embeddingResults[0], 200, options.kinds)
  }

  interface ScoredSegment {
    segment_id: string
    document_id: string
    external_id: string
    title: string
    body: string
    content_hash: string
    kind: string | null
    metadata: Record<string, unknown>
    lexicalScore: number
    vectorScore: number
  }

  const segmentMap = new Map<string, ScoredSegment>()

  // Process lexical candidates
  for (const row of lexicalRows.rows) {
    segmentMap.set(row.segment_id, {
      segment_id: row.segment_id,
      document_id: row.document_id,
      external_id: row.external_id,
      title: row.title,
      body: row.body,
      content_hash: row.content_hash,
      kind: row.kind ?? null,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
      lexicalScore: parseFloat(row.lex_score),
      vectorScore: 0,
    })
  }

  // Process vector candidates — fetch document info for any not already in map
  const vectorOnlyIds = vectorResults
    .filter(v => !segmentMap.has(v.segment_id))
    .map(v => v.segment_id)

  if (vectorOnlyIds.length > 0) {
    const docInfoResult = await pool.query(
      `SELECT s.segment_id, s.document_id, s.body, s.content_hash,
              d.title, d.external_id, d.kind, d.metadata
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
        content_hash: row.content_hash,
        kind: row.kind ?? null,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
        lexicalScore: 0,
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
  const rrfWeights = config.rrf_weights ?? { lexical: 1.0, vector: 1.0 }
  const kindWeights = options.kindWeights ?? config.kind_weights ?? {}
  const recency = options.recency ?? config.recency
  const nowMs = Date.now()
  const minLexicalScore = options.minLexicalScore ?? config.min_lexical_score ?? 0
  const minVectorScore = options.minVectorScore ?? config.min_vector_score ?? 0

  // Assign 1-based ranks per retriever (sorted by raw score descending), applying score floors
  const lexicalRanked = segments
    .filter(s => s.lexicalScore > minLexicalScore)
    .sort((a, b) => b.lexicalScore - a.lexicalScore)
  const lexicalRankMap = new Map<string, number>()
  lexicalRanked.forEach((s, i) => lexicalRankMap.set(s.segment_id, i + 1))

  const vectorRanked = segments
    .filter(s => s.vectorScore > minVectorScore)
    .sort((a, b) => b.vectorScore - a.vectorScore)
  const vectorRankMap = new Map<string, number>()
  vectorRanked.forEach((s, i) => vectorRankMap.set(s.segment_id, i + 1))

  // Compute RRF score for each segment
  const scored = segments
    .map(s => {
      const lexicalRank = lexicalRankMap.get(s.segment_id) ?? null
      const vectorRank = vectorRankMap.get(s.segment_id) ?? null
      // Segments excluded by both score floors are dropped
      if (lexicalRank == null && vectorRank == null) return null
      // The kind multiplier scales the fused score, so under w/(k+r) it acts as
      // a roughly uniform rank shift (0.85 ≈ ~10 ranks at k=60). Documents with
      // no kind, and kinds absent from the map, are neutral.
      const kindWeight = s.kind != null ? kindWeights[s.kind] ?? 1 : 1
      const score = computeRRF({ lexicalRank: lexicalRank ?? undefined, vectorRank: vectorRank ?? undefined, k: rrfK, weights: rrfWeights })
        * kindWeight * recencyMultiplier(recency, s.kind, s.metadata, nowMs)
      return { ...s, score, lexicalRank, vectorRank }
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
    list.sort(fusionOrder)
    capped.push(...list.slice(0, maxChunksPerDoc))
  }

  // Collapse identical content across documents: the same text published at
  // multiple external_ids (mirror pages) surfaces once, keeping the
  // highest-scored copy. Segment content hashes make the comparison exact.
  const seenHashes = new Set<string>()
  const collapsed = capped
    .sort(fusionOrder)
    .filter(s => {
      if (seenHashes.has(s.content_hash)) return false
      seenHashes.add(s.content_hash)
      return true
    })

  const deduped = collapsed.slice(0, limit)

  const results: SearchResult[] = deduped.map(s => ({
    external_id: s.external_id,
    score: s.score,
    title: s.title,
    snippet: s.body,
    kind: s.kind,
    metadata: s.metadata,
  }))

  return {
    results,
    total: new Set(collapsed.map(s => s.document_id)).size,
    query: queryText,
  }
}
