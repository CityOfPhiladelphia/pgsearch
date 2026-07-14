// ABOUTME: Search API routes for querying indexes.
// ABOUTME: Handles hybrid search queries behind search key authentication.

import { Hono } from 'hono'
import { searchAuth } from '../middleware/auth'
import { withIndex } from '../middleware/deps'
import { hybridSearch, type SearchMode } from '../services/search'
import { apiError } from '../middleware/error'
import { getAdapter } from '../services/adapter'
import type { AppEnv, RecencyRule } from '../types'

export const searchRoutes = new Hono<AppEnv>()
searchRoutes.use('/public/search/:name', searchAuth)

searchRoutes.get('/public/search/:name', withIndex(async ({ pool, index }, c) => {
  const q = c.req.query('q')
  if (!q || q.trim() === '') return apiError(c, 'VALIDATION_ERROR', 'Missing required query parameter: q')

  const limitParam = c.req.query('limit')
  const limit = limitParam ? parseInt(limitParam, 10) : 10
  if (isNaN(limit) || limit < 1) return apiError(c, 'VALIDATION_ERROR', 'limit must be a positive integer')

  const modeParam = c.req.query('mode') as SearchMode | undefined
  const validModes: SearchMode[] = ['hybrid', 'lexical', 'semantic']
  if (modeParam && !validModes.includes(modeParam)) return apiError(c, 'VALIDATION_ERROR', `mode must be one of: ${validModes.join(', ')}`)

  // Replaces the index-config kind_weights for this request when present.
  const kindWeightsParam = c.req.query('kind_weights')
  let kindWeights: Record<string, number> | undefined
  if (kindWeightsParam) {
    kindWeights = {}
    for (const pair of kindWeightsParam.split(',')) {
      const sep = pair.lastIndexOf(':')
      const kind = pair.slice(0, sep).trim()
      const weight = Number(pair.slice(sep + 1))
      if (sep < 1 || !kind || !Number.isFinite(weight) || weight < 0) {
        return apiError(c, 'VALIDATION_ERROR', 'kind_weights must be comma-separated kind:weight pairs with weights >= 0')
      }
      kindWeights[kind] = weight
    }
  }

  // Replaces the index-config recency rule for this request when present.
  // Format: kinds:half_life_days:floor, kinds comma-separated (e.g. posts:180:0.85).
  const recencyParam = c.req.query('recency')
  let recency: RecencyRule | undefined
  if (recencyParam) {
    const parts = recencyParam.split(':')
    const floor = Number(parts.pop())
    const halfLife = Number(parts.pop())
    const kinds = parts.join(':').split(',').map(k => k.trim()).filter(Boolean)
    if (kinds.length === 0 || !Number.isFinite(halfLife) || halfLife <= 0 || !Number.isFinite(floor) || floor < 0 || floor > 1) {
      return apiError(c, 'VALIDATION_ERROR', 'recency must be kinds:half_life_days:floor with half_life_days > 0 and floor in [0,1]')
    }
    recency = { kinds, half_life_days: halfLife, floor }
  }

  // Restricts results to the listed kinds (comma-separated), e.g. kinds=posts,services.
  const kindsParam = c.req.query('kinds')
  let kinds: string[] | undefined
  if (kindsParam != null) {
    kinds = kindsParam.split(',').map(k => k.trim()).filter(Boolean)
    if (kinds.length === 0) {
      return apiError(c, 'VALIDATION_ERROR', 'kinds must be a comma-separated list of kind labels')
    }
  }

  const adapter = getAdapter(index.config)
  const results = await hybridSearch(pool, index, adapter, q.trim(), { limit, mode: modeParam, kindWeights, recency, kinds })
  return c.json(results, 200)
}))
