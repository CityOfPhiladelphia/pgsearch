// ABOUTME: Analytics pull route for index owners to export raw search events.
// ABOUTME: Flat rows behind the per-index analytics key, keyset-paginated.

import { Hono } from 'hono'
import { analyticsAuth } from '../middleware/auth'
import { withIndex } from '../middleware/deps'
import { apiError } from '../middleware/error'
import { pullEvents, decodeCursor } from '../services/analytics'
import type { AppEnv } from '../types'

const MAX_PULL_LIMIT = 500

// Date.parse falls back to a lenient, implementation-defined parser for any
// string outside the ECMA-262 Date Time String Format (e.g. "1" silently
// becomes 2001-01-01) — so Date.parse alone can't reject what Postgres would.
// Requiring this shape first keeps Date.parse in its spec-compliant path.
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}(:?\d{2})?)?)?$/

export const analyticsRoutes = new Hono<AppEnv>()
analyticsRoutes.use('/public/analytics/:name/events', analyticsAuth)

analyticsRoutes.get('/public/analytics/:name/events', withIndex(async ({ pool, index }, c) => {
  const fromParam = c.req.query('from')
  const toParam = c.req.query('to')
  for (const [label, value] of [['from', fromParam], ['to', toParam]] as const) {
    if (value !== undefined && (!TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value)))) {
      return apiError(c, 'VALIDATION_ERROR', `${label} must be an ISO 8601 timestamp`)
    }
  }
  // Normalized before it reaches Postgres — passing the raw string through
  // would make Postgres re-parse it, reopening the same ambiguity.
  const from = fromParam !== undefined ? new Date(fromParam).toISOString() : undefined
  const to = toParam !== undefined ? new Date(toParam).toISOString() : undefined

  const afterParam = c.req.query('after')
  const after = afterParam !== undefined ? decodeCursor(afterParam) : null
  if (afterParam !== undefined && !after) {
    return apiError(c, 'VALIDATION_ERROR', 'after must be a cursor from a previous response')
  }

  const limitParam = c.req.query('limit')
  let limit = limitParam ? parseInt(limitParam, 10) : MAX_PULL_LIMIT
  if (isNaN(limit) || limit < 1) return apiError(c, 'VALIDATION_ERROR', 'limit must be a positive integer')
  limit = Math.min(limit, MAX_PULL_LIMIT)

  const result = await pullEvents(pool, index.index_id, { from, to, after, limit })
  return c.json(result, 200)
}))
