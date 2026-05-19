// ABOUTME: Admin API routes for index management.
// ABOUTME: Handles CRUD operations on search indexes behind API Gateway key authentication.

import { Hono } from 'hono'
import { createIndex, getIndex, listIndexes, updateIndex, deleteIndex, mintKey, revokeKey } from '../services/indexes'
import { refreshIndex } from '../services/refresh'
import { apiError } from '../middleware/error'
import { getPool } from '../db/pool'

export const adminRoutes = new Hono()

adminRoutes.post('/private/key/admin/indexes', async (c) => {
  const body = await c.req.json()
  if (!body.name || typeof body.name !== 'string') {
    return apiError(c, 'VALIDATION_ERROR', 'Missing required field: name (string)')
  }

  const pool = await getPool()
  const result = await createIndex(pool, {
    name: body.name,
    description: body.description,
    config: body.config,
  })
  if (!result) return apiError(c, 'VALIDATION_ERROR', `Index '${body.name}' already exists`)
  return c.json(result, 201)
})

adminRoutes.get('/private/key/admin/indexes', async (c) => {
  const pool = await getPool()
  const indexes = await listIndexes(pool)
  return c.json(indexes)
})

adminRoutes.get('/private/key/admin/indexes/:name', async (c) => {
  const name = c.req.param('name')
  const pool = await getPool()
  const index = await getIndex(pool, name)
  if (!index) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  return c.json(index)
})

adminRoutes.patch('/private/key/admin/indexes/:name', async (c) => {
  const name = c.req.param('name')
  const body = await c.req.json()
  const pool = await getPool()
  const updated = await updateIndex(pool, name, body)
  if (!updated) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  return c.json(updated)
})

adminRoutes.delete('/private/key/admin/indexes/:name', async (c) => {
  const name = c.req.param('name')
  const pool = await getPool()
  const deleted = await deleteIndex(pool, name)
  if (!deleted) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  return c.json({ deleted: true })
})

adminRoutes.post('/private/key/admin/indexes/:name/refresh', async (c) => {
  const name = c.req.param('name')
  const pool = await getPool()
  const index = await getIndex(pool, name)
  if (!index) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)

  await refreshIndex(pool, index.index_id)
  return c.json({ status: 'refreshed' })
})

adminRoutes.post('/private/key/admin/indexes/:name/rag-key', async (c) => {
  const name = c.req.param('name')
  const pool = await getPool()
  const result = await mintKey(pool, name, 'rag')
  if (!result) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  return c.json({ rag_key: result.key }, 201)
})

adminRoutes.delete('/private/key/admin/indexes/:name/rag-key', async (c) => {
  const name = c.req.param('name')
  const pool = await getPool()
  const revoked = await revokeKey(pool, name, 'rag')
  if (!revoked) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  return c.json({ revoked: true })
})
