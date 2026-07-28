// ABOUTME: Analytics event log: query capture, feedback postbacks, and paginated pulls.
// ABOUTME: One generic events bucket; anchor rows are action='search' with group_id = event_id.

import type { Pool } from 'pg'

// Inserts the group's anchor event and returns its id — the group_id consumers
// post feedback against. The subselect evaluates gen_random_uuid() once so the
// anchor self-points (group_id = event_id) in a single statement.
export async function logQuery(
  pool: Pool,
  indexId: number,
  data: Record<string, unknown>,
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO events (event_id, group_id, index_id, action, data)
     SELECT id, id, $1, 'search', $2
     FROM (SELECT gen_random_uuid() AS id) g
     RETURNING event_id`,
    [indexId, JSON.stringify(data)],
  )
  return result.rows[0].event_id
}

// Inserts a feedback event into the anchor's group by copying its group_id and
// index_id. The WHERE clause is the whole contract: the anchor must exist,
// belong to the authenticated index, and itself be an anchor (group_id =
// event_id) — feedback cannot chain to feedback. Returns null when no anchor
// matched.
export async function logEvent(
  pool: Pool,
  indexId: number,
  groupId: string,
  action: string,
  data: Record<string, unknown>,
): Promise<string | null> {
  const result = await pool.query(
    `INSERT INTO events (index_id, group_id, action, data)
     SELECT index_id, group_id, $3, $4
     FROM events
     WHERE event_id = $1 AND index_id = $2 AND group_id = event_id
     RETURNING event_id`,
    [groupId, indexId, action, JSON.stringify(data)],
  )
  return result.rows[0]?.event_id ?? null
}

export interface AnalyticsEvent {
  event_id: string
  group_id: string
  action: string
  data: Record<string, unknown>
  created_at: string
}

export interface PullOptions {
  from?: string
  to?: string
  after?: { createdAt: string; eventId: string }
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

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Returns null when the token isn't a base64url JSON pair of strings. Content
// is not inspected here — Postgres parses the timestamp and uuid casts, and
// the route maps its data-exception errors to a 400.
export function decodeCursor(cursor: string): { createdAt: string; eventId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [createdAt, eventId] = parsed
    if (typeof createdAt !== 'string' || typeof eventId !== 'string') return null
    return { createdAt, eventId }
  } catch {
    return null
  }
}

export async function pullEvents(pool: Pool, indexId: number, options: PullOptions): Promise<PullResult> {
  // Fetch one extra row to know whether a next page exists.
  // Unnamed statement on purpose: a prepared/named statement gets a generic plan
  // where the $n IS NULL guards can't const-fold, dropping the keyset out of the Index Cond.
  const result = await pool.query(
    `SELECT event_id, group_id, action, data, created_at, created_at::text AS created_at_text
     FROM events
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
      options.after?.createdAt ?? null,
      options.after?.eventId ?? null,
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
      group_id: row.group_id,
      action: row.action,
      data: row.data,
      created_at: row.created_at.toISOString(),
    })),
    next,
  }
}
