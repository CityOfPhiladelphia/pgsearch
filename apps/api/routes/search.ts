// ABOUTME: Search API routes for querying indexes.
// ABOUTME: Handles hybrid search queries behind search key authentication.

import { Hono } from 'hono'
import { searchAuth } from '../middleware/auth'
import { withIndex } from '../middleware/deps'
import { hybridSearch, type SearchMode } from '../services/search'
import { apiError } from '../middleware/error'
import { getAdapter } from '../services/adapter'
import { logQuery, logEvent, UUID_PATTERN } from '../services/analytics'
import { parseBody, ValidationError } from '../middleware/validate'
import type { AppEnv, RecencyRule } from '../types'

export const searchRoutes = new Hono<AppEnv>()
searchRoutes.use('/public/search/:name', searchAuth)
searchRoutes.use('/public/search/:name/events', searchAuth)

const MAX_EVENT_DATA_BYTES = 4096

interface FeedbackBody {
  query_id: string
  action: string
  data?: Record<string, unknown>
}

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

  const query = q.trim()
  const adapter = getAdapter(index.config)
  const results = await hybridSearch(pool, index, adapter, query, { limit, mode: modeParam, kindWeights, recency, kinds })

  // Capture failures degrade to a response without query_id — analytics never breaks search.
  // Awaited, not fire-and-forget: Lambda freezes the container after the response, dropping in-flight writes.
  const queryId = await logQuery(pool, index.index_id, {
    q: query,
    mode: modeParam ?? 'hybrid',
    kinds: kinds ?? null,
    limit,
    total: results.total,
    result_ids: results.results.map(r => r.external_id),
  }).catch((err: unknown) => {
    console.error('analytics capture failed:', err)
    return undefined
  })

  return c.json(queryId ? { query_id: queryId, ...results } : results, 200)
}))

searchRoutes.post('/public/search/:name/events', withIndex(async ({ pool, index }, c) => {
  const body = await parseBody<FeedbackBody>(c, {
    query_id: [['typeof', 'string'], ['nonEmpty']],
    action: [['typeof', 'string'], ['nonEmpty'], ['maxLength', 64]],
    'data?': ['object'],
  })
  // Malformed UUIDs would otherwise surface as a Postgres cast error (500), not a 400.
  if (!UUID_PATTERN.test(body.query_id)) throw new ValidationError('query_id must be a UUID')
  const data = body.data ?? {}
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_EVENT_DATA_BYTES) {
    throw new ValidationError(`data must serialize to at most ${MAX_EVENT_DATA_BYTES} bytes`)
  }

  const eventId = await logEvent(pool, index.index_id, body.query_id, body.action, data)
  if (!eventId) return apiError(c, 'NOT_FOUND', 'Unknown query_id')
  return c.json({ event_id: eventId }, 201)
}))
