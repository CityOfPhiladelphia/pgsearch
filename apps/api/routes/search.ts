// ABOUTME: Search API routes for querying indexes.
// ABOUTME: Handles hybrid search queries and the feedback postback endpoint, both behind search key authentication.

import { Hono } from 'hono'
import { searchAuth } from '../middleware/auth'
import { withIndex } from '../middleware/deps'
import { hybridSearch, type SearchMode } from '../services/search'
import { apiError } from '../middleware/error'
import { getAdapter } from '../services/adapter'
import { logQuery, logEvent } from '../services/analytics'
import { parseBody, ValidationError } from '../middleware/validate'
import * as param from '../middleware/params'
import type { AppEnv } from '../types'

export const searchRoutes = new Hono<AppEnv>()
searchRoutes.use('/public/search/:name', searchAuth)
searchRoutes.use('/public/search/:name/events', searchAuth)

const MAX_EVENT_DATA_BYTES = 4096

interface FeedbackBody {
  group_id: string
  action: string
  data?: Record<string, unknown>
}

searchRoutes.get('/public/search/:name', withIndex(async ({ pool, index }, c) => {
  const query = param.required(c, 'q')
  const limit = param.int(c, 'limit', { fallback: 10 })
  const mode = param.oneOf<SearchMode>(c, 'mode', ['hybrid', 'lexical', 'semantic'])
  // kind_weights and recency replace their index-config counterparts for this
  // request when present; kinds restricts results (e.g. kinds=posts,services).
  const kindWeights = param.weights(c, 'kind_weights')
  const recency = param.recency(c, 'recency')
  const kinds = param.list(c, 'kinds')

  const adapter = getAdapter(index.config)
  const results = await hybridSearch(pool, index, adapter, query, { limit, mode, kindWeights, recency, kinds })

  // Capture failures degrade to a response without group_id — analytics never breaks search.
  // Awaited, not fire-and-forget: Lambda freezes the container after the response, dropping in-flight writes.
  const groupId = await logQuery(pool, index.index_id, {
    q: query,
    mode: mode ?? 'hybrid',
    kinds: kinds ?? null,
    limit,
    total: results.total,
    result_ids: results.results.map(r => r.external_id),
  }).catch((err: unknown) => {
    console.error('analytics capture failed:', err)
    return undefined
  })

  return c.json(groupId ? { group_id: groupId, ...results } : results, 200)
}))

searchRoutes.post('/public/search/:name/events', withIndex(async ({ pool, index }, c) => {
  const body = await parseBody<FeedbackBody>(c, {
    group_id: [['typeof', 'string'], ['nonEmpty']],
    action: [['typeof', 'string'], ['nonEmpty'], ['maxLength', 64]],
    'data?': ['object'],
  })
  const data = body.data ?? {}
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_EVENT_DATA_BYTES) {
    throw new ValidationError(`data must serialize to at most ${MAX_EVENT_DATA_BYTES} bytes`)
  }

  const eventId = await logEvent(pool, index.index_id, body.group_id, body.action, data)
  if (!eventId) return apiError(c, 'NOT_FOUND', 'Unknown group_id')
  return c.json({ event_id: eventId }, 201)
}))
