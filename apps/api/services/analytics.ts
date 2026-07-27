// ABOUTME: Analytics event log: query capture, feedback postbacks, and paginated pulls.
// ABOUTME: One generic search_events bucket; query rows are action='search' with null query_id.

import type { Pool } from 'pg'

// Returns the new query row's event_id — the query_id consumers post feedback against.
export async function logQuery(
  pool: Pool,
  indexId: number,
  data: Record<string, unknown>,
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO search_events (index_id, action, data)
     VALUES ($1, 'search', $2)
     RETURNING event_id`,
    [indexId, JSON.stringify(data)],
  )
  return result.rows[0].event_id
}

// Inserts a feedback event by copying index_id from the parent query row.
// The WHERE clause is the whole contract: parent must exist, belong to the
// authenticated index, and itself be a query row (query_id IS NULL) — feedback
// cannot chain to feedback. Returns null when no parent matched.
export async function logEvent(
  pool: Pool,
  indexId: number,
  queryId: string,
  action: string,
  data: Record<string, unknown>,
): Promise<string | null> {
  const result = await pool.query(
    `INSERT INTO search_events (index_id, query_id, action, data)
     SELECT index_id, event_id, $3, $4
     FROM search_events
     WHERE event_id = $1 AND index_id = $2 AND query_id IS NULL
     RETURNING event_id`,
    [queryId, indexId, action, JSON.stringify(data)],
  )
  return result.rows[0]?.event_id ?? null
}
