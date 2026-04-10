// ABOUTME: Search API routes for querying indexes.
// ABOUTME: Handles hybrid search queries behind search key authentication.

import { Hono } from 'hono'
import { searchAuth } from '../middleware/auth'
import { hybridSearch } from '../services/search'
import { apiError } from '../middleware/error'
import { getPool } from '../db/pool'
import { getAdapter } from '../services/adapter'
import type { AppEnv } from '../types'

export const searchRoutes = new Hono<AppEnv>()
searchRoutes.use('/public/search/:name', searchAuth)

searchRoutes.get('/public/search/:name', async (c) => {
  const q = c.req.query('q')
  if (!q || typeof q !== 'string' || q.trim() === '') {
    return apiError(c, 'VALIDATION_ERROR', 'Missing required query parameter: q')
  }

  const limitParam = c.req.query('limit')
  const limit = limitParam ? parseInt(limitParam, 10) : 10
  if (isNaN(limit) || limit < 1) {
    return apiError(c, 'VALIDATION_ERROR', 'limit must be a positive integer')
  }

  const index = c.get('index')
  const pool = await getPool()
  const adapter = getAdapter(index.config)

  console.log(`[search-debug] q="${q}" index=${index.name} index_id=${index.index_id}`)
  const results = await hybridSearch(pool, index.index_id, adapter, q.trim(), { limit })
  console.log(`[search-debug] returned ${results.results.length} results, first ext_id=${results.results[0]?.external_id}`)
  return c.json(results, 200)
})
