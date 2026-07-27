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

export interface AnalyticsEvent {
  event_id: string
  query_id: string | null
  action: string
  data: Record<string, unknown>
  created_at: string
}

export interface PullOptions {
  from?: string
  to?: string
  after?: { createdAt: string; eventId: string } | null
  limit: number
}

export interface PullResult {
  events: AnalyticsEvent[]
  next: string | null
}

// Cursors carry the row's created_at::text (microsecond precision — a JS Date
// would truncate to milliseconds and re-return the boundary row) plus event_id,
// base64url-encoded as an opaque token.
function encodeCursor(createdAtText: string, eventId: string): string {
  return Buffer.from(JSON.stringify([createdAtText, eventId])).toString('base64url')
}

// Returns null on any malformed token; callers translate to a validation error.
export function decodeCursor(cursor: string): { createdAt: string; eventId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [createdAt, eventId] = parsed
    if (typeof createdAt !== 'string' || typeof eventId !== 'string') return null
    if (Number.isNaN(Date.parse(createdAt))) return null
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) return null
    return { createdAt, eventId }
  } catch {
    return null
  }
}

export async function pullEvents(pool: Pool, indexId: number, options: PullOptions): Promise<PullResult> {
  const after = options.after ?? null
  // Fetch one extra row to know whether a next page exists.
  // Unnamed statement on purpose: a prepared/named statement gets a generic plan
  // where the $n IS NULL guards can't const-fold, dropping the keyset out of the Index Cond.
  const result = await pool.query(
    `SELECT event_id, query_id, action, data, created_at, created_at::text AS created_at_text
     FROM search_events
     WHERE index_id = $1
       AND ($2::timestamptz IS NULL OR created_at >= $2)
       AND ($3::timestamptz IS NULL OR created_at < $3)
       AND ($4::timestamptz IS NULL OR (created_at, event_id) > ($4::timestamptz, $5::uuid))
     ORDER BY created_at, event_id
     LIMIT $6`,
    [
      indexId,
      options.from ?? null,
      options.to ?? null,
      after?.createdAt ?? null,
      after?.eventId ?? null,
      options.limit + 1,
    ],
  )

  const page = result.rows.slice(0, options.limit)
  const last = page[page.length - 1]
  const next = result.rows.length > options.limit && last
    ? encodeCursor(last.created_at_text, last.event_id)
    : null

  return {
    events: page.map(row => ({
      event_id: row.event_id,
      query_id: row.query_id,
      action: row.action,
      data: row.data,
      created_at: row.created_at.toISOString(),
    })),
    next,
  }
}
