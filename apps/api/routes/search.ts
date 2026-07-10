// ABOUTME: Search API routes for querying indexes.
// ABOUTME: Handles hybrid search queries behind search key authentication.

import { Hono } from 'hono'
import { searchAuth } from '../middleware/auth'
import { withIndex } from '../middleware/deps'
import { hybridSearch, type LexicalScorer, type SearchMode } from '../services/search'
import { apiError } from '../middleware/error'
import { getAdapter } from '../services/adapter'
import type { AppEnv } from '../types'

export const searchRoutes = new Hono<AppEnv>()
searchRoutes.use('/public/search/:name', searchAuth)

searchRoutes.get('/public/search/:name', withIndex(async ({ pool, index }, c) => {
  const q = c.req.query('q')
  if (!q || q.trim() === '') return apiError(c, 'VALIDATION_ERROR', 'Missing required query parameter: q')

  const limitParam = c.req.query('limit')
  const limit = limitParam ? parseInt(limitParam, 10) : 10
  if (isNaN(limit) || limit < 1) return apiError(c, 'VALIDATION_ERROR', 'limit must be a positive integer')

  const modeParam = c.req.query('mode') as SearchMode | undefined
  const validModes: SearchMode[] = ['hybrid', 'bm25', 'semantic']
  if (modeParam && !validModes.includes(modeParam)) return apiError(c, 'VALIDATION_ERROR', `mode must be one of: ${validModes.join(', ')}`)

  // Undocumented lexical scorer selector for the ts_rank_cd relevance experiment (pgsearch-qpp).
  const lexicalParam = c.req.query('lexical') as LexicalScorer | undefined
  const validLexical: LexicalScorer[] = ['bm25f', 'tsrank']
  if (lexicalParam && !validLexical.includes(lexicalParam)) return apiError(c, 'VALIDATION_ERROR', `lexical must be one of: ${validLexical.join(', ')}`)

  const adapter = getAdapter(index.config)
  const results = await hybridSearch(pool, index, adapter, q.trim(), { limit, mode: modeParam, lexical: lexicalParam })
  return c.json(results, 200)
}))
