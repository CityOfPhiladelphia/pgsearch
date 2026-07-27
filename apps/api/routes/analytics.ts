// ABOUTME: Analytics pull route for index owners to export raw search events.
// ABOUTME: Flat rows behind the per-index analytics key, keyset-paginated.

import { Hono } from 'hono'
import { analyticsAuth } from '../middleware/auth'
import { withIndex } from '../middleware/deps'
import { apiError } from '../middleware/error'
import { pullEvents, decodeCursor } from '../services/analytics'
import type { AppEnv } from '../types'

const MAX_PULL_LIMIT = 500

export const analyticsRoutes = new Hono<AppEnv>()
analyticsRoutes.use('/public/analytics/:name/events', analyticsAuth)

analyticsRoutes.get('/public/analytics/:name/events', withIndex(async ({ pool, index }, c) => {
  const from = c.req.query('from')
  const to = c.req.query('to')
  for (const [label, value] of [['from', from], ['to', to]] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      return apiError(c, 'VALIDATION_ERROR', `${label} must be an ISO 8601 timestamp`)
    }
  }

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
