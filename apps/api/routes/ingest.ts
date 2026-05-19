// ABOUTME: Ingest API routes for document management.
// ABOUTME: Handles document ingestion and deletion behind index key authentication.

import { Hono } from 'hono'
import { indexAuth } from '../middleware/auth'
import { withIndex } from '../middleware/deps'
import { ingestDocument, deleteDocument } from '../services/ingest'
import { apiError } from '../middleware/error'
import { assertValid, type Schema } from '../middleware/validate'
import { getAdapter } from '../services/adapter'
import type { AppEnv } from '../types'

const ingestSchema: Schema = {
  external_id: [['typeof', 'string'], ['nonEmpty']],
  title: [['typeof', 'string'], ['nonEmpty']],
  body: [['typeof', 'string'], ['nonEmpty']],
}

export const ingestRoutes = new Hono<AppEnv>()
ingestRoutes.use('/public/index/:name/*', indexAuth)

ingestRoutes.post('/public/index/:name/documents', withIndex(async ({ pool, index }, c) => {
  const json = await c.req.json()
  const { external_id, title, body } = assertValid<{ external_id: string; title: string; body: string }>(json, ingestSchema)

  const adapter = getAdapter(index.config)

  try {
    const result = await ingestDocument(pool, index.index_id, adapter, {
      external_id,
      title,
      body,
      metadata: json.metadata,
    })
    return c.json(result, 200)
  } catch (err: any) {
    if (err.message?.includes('exceeding limit')) {
      return apiError(c, 'VALIDATION_ERROR', err.message)
    }
    throw err
  }
}))

ingestRoutes.delete('/public/index/:name/documents/:external_id', withIndex(async ({ pool, index }, c) => {
  const externalId = c.req.param('external_id')!
  await deleteDocument(pool, index.index_id, externalId)
  return c.json({ deleted: true })
}))
