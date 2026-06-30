// ABOUTME: Hot-path BM25 stat maintenance: per-document term-set + length deltas.
// ABOUTME: Applies DF and average-length changes inside the caller's ingest/delete transaction.
import type { PoolClient } from 'pg'

export interface DocStats { titleLength: number; bodyLength: number; segments: number }

export async function documentTermSet(client: PoolClient, documentId: string): Promise<string[]> {
  const r = await client.query(
    `SELECT array_agg(DISTINCT term) AS terms FROM (
       SELECT unnest(tsvector_to_array(body_tsvector)) AS term
       FROM search_segments WHERE document_id = $1 AND body_tsvector IS NOT NULL
       UNION ALL
       SELECT unnest(tsvector_to_array(title_tsvector))
       FROM search_documents WHERE document_id = $1 AND title_tsvector IS NOT NULL
     ) t`,
    [documentId],
  )
  return r.rows[0].terms ?? []
}

export async function documentStats(client: PoolClient, documentId: string): Promise<DocStats> {
  const r = await client.query(
    `SELECT
       COALESCE(d.title_length, 0)                         AS title_length,
       COALESCE(SUM(s.body_length), 0)                     AS body_length,
       COALESCE(d.segment_count, 0)                        AS segments
     FROM search_documents d
     LEFT JOIN search_segments s ON s.document_id = d.document_id
     WHERE d.document_id = $1
     GROUP BY d.title_length, d.segment_count`,
    [documentId],
  )
  if (r.rows.length === 0) return { titleLength: 0, bodyLength: 0, segments: 0 }
  return {
    titleLength: Number(r.rows[0].title_length),
    bodyLength: Number(r.rows[0].body_length),
    segments: Number(r.rows[0].segments),
  }
}

export async function applyMaintenance(client: PoolClient, args: {
  indexId: number
  oldTerms: string[]
  newTerms: string[]
  deltaTitle: number
  deltaBody: number
  deltaSegments: number
}): Promise<void> {
  const { indexId, oldTerms, newTerms } = args
  const oldSet = new Set(oldTerms)
  const newSet = new Set(newTerms)
  // Sort for a consistent lock order across concurrent transactions (deadlock guard).
  const added = newTerms.filter(t => !oldSet.has(t)).sort()
  const removed = oldTerms.filter(t => !newSet.has(t)).sort()

  if (added.length > 0) {
    await client.query(
      `INSERT INTO term_document_frequencies (index_id, term, document_frequency)
       SELECT $1, t, 1 FROM unnest($2::text[]) t
       ON CONFLICT (index_id, term)
       DO UPDATE SET document_frequency = term_document_frequencies.document_frequency + 1`,
      [indexId, added],
    )
  }
  if (removed.length > 0) {
    await client.query(
      `UPDATE term_document_frequencies SET document_frequency = document_frequency - 1
       WHERE index_id = $1 AND term = ANY($2::text[])`,
      [indexId, removed],
    )
    await client.query(
      `DELETE FROM term_document_frequencies WHERE index_id = $1 AND document_frequency <= 0`,
      [indexId],
    )
  }

  // Length sums first, then recompute averages from current column values
  // (total_documents is maintained by the caller's existing insert logic).
  await client.query(
    `UPDATE search_indexes SET
       total_title_length = total_title_length + $2,
       total_body_length  = total_body_length  + $3,
       total_segments     = total_segments     + $4
     WHERE index_id = $1`,
    [indexId, args.deltaTitle, args.deltaBody, args.deltaSegments],
  )
  await client.query(
    `UPDATE search_indexes SET
       avg_title_length = COALESCE(total_title_length::float / NULLIF(total_documents, 0), 0),
       avg_body_length  = COALESCE(total_body_length::float  / NULLIF(total_segments, 0), 0)
     WHERE index_id = $1`,
    [indexId],
  )
}

// Note: averages are wrapped in COALESCE(..., 0) because avg_title_length /
// avg_body_length are FLOAT NOT NULL. Without it, an empty index, a delete of
// the last document, or a doc with zero body segments would assign NULL and
// violate the not-null constraint. This matches reconcile_index_stats's
// COALESCE(AVG(...), 0) behavior.
