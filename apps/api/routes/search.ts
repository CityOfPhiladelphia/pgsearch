// ABOUTME: Search API routes for querying indexes.
// ABOUTME: Handles hybrid search queries behind search key authentication.

import { Hono } from 'hono'
import { searchAuth } from '../middleware/auth'
import { withIndex } from '../middleware/deps'
import { hybridSearch, type SearchMode } from '../services/search'
import { apiError } from '../middleware/error'
import { getAdapter } from '../services/adapter'
import type { AppEnv } from '../types'

export const searchRoutes = new Hono<AppEnv>()
searchRoutes.use('/public/search/:name', searchAuth)

searchRoutes.get('/public/search/:name', withIndex(async ({ pool, index }, c) => {
  const q = c.req.query('q')
  if (!q || typeof q !== 'string' || q.trim() === '') {
    return apiError(c, 'VALIDATION_ERROR', 'Missing required query parameter: q')
  }

  const limitParam = c.req.query('limit')
  const limit = limitParam ? parseInt(limitParam, 10) : 10
  if (isNaN(limit) || limit < 1) {
    return apiError(c, 'VALIDATION_ERROR', 'limit must be a positive integer')
  }

  const modeParam = c.req.query('mode') as SearchMode | undefined
  const validModes: SearchMode[] = ['hybrid', 'bm25', 'semantic']
  if (modeParam && !validModes.includes(modeParam)) {
    return apiError(c, 'VALIDATION_ERROR', `mode must be one of: ${validModes.join(', ')}`)
  }

  const adapter = getAdapter(index.config)
  const results = await hybridSearch(pool, index.index_id, adapter, q.trim(), { limit, mode: modeParam })
  return c.json(results, 200)
}))
