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
