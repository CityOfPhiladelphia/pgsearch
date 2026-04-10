// ABOUTME: Ingest API routes for document management.
// ABOUTME: Handles document ingestion and deletion behind index key authentication.

import { Hono } from 'hono'
import { indexAuth } from '../middleware/auth'
import { ingestDocument, deleteDocument } from '../services/ingest'
import { apiError } from '../middleware/error'
import { getPool } from '../db/pool'
import { getAdapter } from '../services/adapter'
import type { AppEnv } from '../types'

export const ingestRoutes = new Hono<AppEnv>()
ingestRoutes.use('/public/index/:name/*', indexAuth)

ingestRoutes.post('/public/index/:name/documents', async (c) => {
  const body = await c.req.json()

  if (!body.external_id || typeof body.external_id !== 'string') {
    return apiError(c, 'VALIDATION_ERROR', 'Missing required field: external_id (string)')
  }
  if (!body.title || typeof body.title !== 'string') {
    return apiError(c, 'VALIDATION_ERROR', 'Missing required field: title (string)')
  }
  if (!body.body || typeof body.body !== 'string') {
    return apiError(c, 'VALIDATION_ERROR', 'Missing required field: body (string)')
  }

  const index = c.get('index')
  const pool = await getPool()
  const adapter = getAdapter(index.config)

  try {
    const result = await ingestDocument(pool, index.index_id, adapter, {
      external_id: body.external_id,
      title: body.title,
      body: body.body,
      metadata: body.metadata,
    })
    return c.json(result, 200)
  } catch (err: any) {
    if (err.message?.includes('exceeding limit')) {
      return apiError(c, 'VALIDATION_ERROR', err.message)
    }
    throw err
  }
})

ingestRoutes.delete('/public/index/:name/documents/:external_id', async (c) => {
  const externalId = c.req.param('external_id')
  const index = c.get('index')
  const pool = await getPool()

  await deleteDocument(pool, index.index_id, externalId)
  return c.json({ deleted: true })
})
