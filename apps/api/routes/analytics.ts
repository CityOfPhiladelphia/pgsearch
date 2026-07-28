// ABOUTME: Analytics pull route for index owners to export raw search events.
// ABOUTME: Flat rows behind the per-index analytics key, keyset-paginated.

import { Hono } from 'hono'
import { analyticsAuth } from '../middleware/auth'
import { withIndex } from '../middleware/deps'
import { apiError } from '../middleware/error'
import { pullEvents, decodeCursor } from '../services/analytics'
import * as param from '../middleware/params'
import type { AppEnv } from '../types'

const MAX_PULL_LIMIT = 500

export const analyticsRoutes = new Hono<AppEnv>()
analyticsRoutes.use('/public/analytics/:name/events', analyticsAuth)

analyticsRoutes.get('/public/analytics/:name/events', withIndex(async ({ pool, index }, c) => {
  const from = c.req.query('from')
  const to = c.req.query('to')

  const afterParam = c.req.query('after')
  const after = afterParam !== undefined ? decodeCursor(afterParam) ?? undefined : undefined
  if (afterParam !== undefined && !after) {
    return apiError(c, 'VALIDATION_ERROR', 'after must be a cursor from a previous response')
  }

  const limit = param.int(c, 'limit', { fallback: MAX_PULL_LIMIT, max: MAX_PULL_LIMIT })

  // Postgres is the parser of record for from/to and cursor contents. JS-side
  // parsing is deliberately absent — Date.parse's lenient fallback reinterprets
  // garbage ("1" → 2001, Feb 30 → Mar 2) instead of rejecting it. A value
  // Postgres can't read raises SQLSTATE class 22 (data exception): a 400.
  const result = await pullEvents(pool, index.index_id, { from, to, after, limit }).catch((err: unknown) => {
    if (String((err as { code?: string }).code).startsWith('22')) return null
    throw err
  })
  if (!result) return apiError(c, 'VALIDATION_ERROR', 'from, to, and after must be timestamps Postgres can read')
  return c.json(result, 200)
}))
