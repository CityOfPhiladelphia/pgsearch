// ABOUTME: Materialized view refresh and corpus statistics recomputation.
// ABOUTME: Refreshes term_document_frequencies and updates avg field lengths on the index.

import type { Pool } from 'pg'

export async function refreshIndex(pool: Pool, indexId: number): Promise<void> {
  // Attempt concurrent refresh; fall back to non-concurrent if the view is empty
  // (empty view cannot satisfy the unique index requirement for CONCURRENTLY).
  try {
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY term_document_frequencies')
  } catch {
    await pool.query('REFRESH MATERIALIZED VIEW term_document_frequencies')
  }

  const titleResult = await pool.query(
    'SELECT COALESCE(AVG(title_length), 0) AS avg FROM search_documents WHERE index_id = $1',
    [indexId]
  )
  const bodyResult = await pool.query(
    'SELECT COALESCE(AVG(body_length), 0) AS avg FROM search_segments WHERE index_id = $1',
    [indexId]
  )

  const avgTitle = titleResult.rows[0].avg
  const avgBody = bodyResult.rows[0].avg

  await pool.query(
    `UPDATE search_indexes
     SET avg_title_length = $1, avg_body_length = $2, docs_changed_since_refresh = 0, last_refreshed_at = NOW()
     WHERE index_id = $3`,
    [avgTitle, avgBody, indexId]
  )
}

export async function checkAndRefresh(pool: Pool, indexId: number, threshold: number): Promise<void> {
  const result = await pool.query(
    'SELECT docs_changed_since_refresh FROM search_indexes WHERE index_id = $1',
    [indexId]
  )

  if (result.rows.length === 0) return

  if (result.rows[0].docs_changed_since_refresh >= threshold) {
    await refreshIndex(pool, indexId)
  }
}
