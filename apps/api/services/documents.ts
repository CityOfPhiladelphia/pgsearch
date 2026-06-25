// ABOUTME: Document state listing for index sync / reconciliation.
// ABOUTME: Keyset-paginated read of external_id + updated_at + metadata, ordered by external_id.

import type { Pool } from 'pg'
import type { DocumentState, DocumentStateResponse } from '../types'

export const DEFAULT_PAGE_SIZE = 1000
export const MAX_PAGE_SIZE = 5000

// Clamp a raw ?limit query value into [1, MAX_PAGE_SIZE]. Absent or unparseable
// values fall back to DEFAULT_PAGE_SIZE — the endpoint favors a usable default
// over a 400 on a malformed page size.
export function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PAGE_SIZE
  const n = parseInt(raw, 10)
  if (isNaN(n)) return DEFAULT_PAGE_SIZE
  return Math.max(1, Math.min(n, MAX_PAGE_SIZE))
}

// One keyset page of index state ordered by external_id. `after` is an
// exclusive lower bound (the previous page's last external_id). next_cursor is
// the last external_id when the page is full, else null to end the walk.
export async function listDocumentState(
  pool: Pool,
  indexId: number,
  options: { limit: number; after?: string },
): Promise<DocumentStateResponse> {
  const { limit, after } = options
  const result = await pool.query(
    `SELECT external_id, updated_at, metadata
     FROM search_documents
     WHERE index_id = $1 AND ($2::text IS NULL OR external_id > $2)
     ORDER BY external_id ASC
     LIMIT $3`,
    [indexId, after ?? null, limit],
  )

  const documents: DocumentState[] = result.rows.map(row => ({
    external_id: row.external_id,
    updated_at: row.updated_at.toISOString(),
    metadata: row.metadata ?? {},
  }))

  const next_cursor = documents.length > 0 && documents.length === limit
    ? documents[documents.length - 1].external_id
    : null

  return { documents, next_cursor }
}
