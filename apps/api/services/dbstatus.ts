// ABOUTME: Read-only diagnostics for installed extensions and the vector storage layout.
// ABOUTME: Reports extension versions, per-index embedding indexes, and sampled vector dimensions.

import type { Pool } from 'pg'

export interface DbStatus {
  extensions: Array<{ name: string; version: string }>
  embedding_indexes: Array<{ index_name: string; definition: string; size: string }>
  segment_dimensions: Array<{ index_id: number; dimensions: number }>
}

export async function dbStatus(pool: Pool): Promise<DbStatus> {
  const ext = await pool.query(
    'SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname',
  )

  const idx = await pool.query(
    `SELECT indexname AS index_name, indexdef AS definition,
            pg_size_pretty(pg_relation_size(quote_ident(indexname)::regclass)) AS size
     FROM pg_indexes
     WHERE tablename = 'search_segments' AND indexname LIKE 'idx_segments_embedding_%'
     ORDER BY indexname`,
  )

  // One sampled row per index: dimensions are uniform within an index in practice,
  // and a full scan to prove it would detoast every embedding.
  const dims = await pool.query(
    `SELECT index_id, vector_dims(embedding) AS dimensions
     FROM (SELECT DISTINCT ON (index_id) index_id, embedding
           FROM search_segments ORDER BY index_id) sample
     ORDER BY index_id`,
  )

  return {
    extensions: ext.rows,
    embedding_indexes: idx.rows,
    segment_dimensions: dims.rows.map(r => ({ index_id: r.index_id, dimensions: r.dimensions })),
  }
}
