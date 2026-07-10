// ABOUTME: Admin API routes for index management.
// ABOUTME: Handles CRUD operations on search indexes behind API Gateway key authentication.

import { Hono } from 'hono'
import { createIndex, getIndex, listIndexes, updateIndex, deleteIndex, mintKey, revokeKey } from '../services/indexes'
import { dbStatus } from '../services/dbstatus'
import { apiError } from '../middleware/error'
import { withPool } from '../middleware/deps'
import { parseBody, type Schema } from '../middleware/validate'
import type { AppEnv } from '../types'

const createIndexSchema: Schema = {
  name: [['typeof', 'string'], ['nonEmpty']],
  'description?': ['typeof', 'string'],
  'config?': ['object'],
}

// Typed Hono<AppEnv> even though admin routes don't read the `index` variable —
// matches what the withPool HOF expects so Hono's path-param inference flows
// through to handlers without resolving c.req.param to string | undefined.
export const adminRoutes = new Hono<AppEnv>()

adminRoutes.post('/private/key/admin/indexes', withPool(async ({ pool }, c) => {
  const body = await parseBody<{ name: string; description?: string; config?: any }>(c, createIndexSchema)
  const result = await createIndex(pool, body)
  if (!result) return apiError(c, 'VALIDATION_ERROR', `Index '${body.name}' already exists`)
  return c.json(result, 201)
}))

adminRoutes.get('/private/key/admin/indexes', withPool(async ({ pool }, c) => {
  const indexes = await listIndexes(pool)
  return c.json(indexes)
}))

adminRoutes.get('/private/key/admin/indexes/:name', withPool(async ({ pool }, c) => {
  const name = c.req.param('name')!
  const index = await getIndex(pool, name)
  if (!index) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  return c.json(index)
}))

adminRoutes.patch('/private/key/admin/indexes/:name', withPool(async ({ pool }, c) => {
  const name = c.req.param('name')!
  const body = await c.req.json()
  const updated = await updateIndex(pool, name, body)
  if (!updated) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  return c.json(updated)
}))

adminRoutes.delete('/private/key/admin/indexes/:name', withPool(async ({ pool }, c) => {
  const name = c.req.param('name')!
  const deleted = await deleteIndex(pool, name)
  if (!deleted) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  return c.json({ deleted: true })
}))

adminRoutes.get('/private/key/admin/db-status', withPool(async ({ pool }, c) => {
  return c.json(await dbStatus(pool))
}))

adminRoutes.post('/private/key/admin/indexes/:name/rag-key', withPool(async ({ pool }, c) => {
  const name = c.req.param('name')!
  const result = await mintKey(pool, name, 'rag')
  if (!result) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  return c.json({ rag_key: result.key }, 201)
}))

// Mints (rotates) the search key — search keys are otherwise only issued at index
// creation, leaving no way to recover or roll one that was lost or leaked.
adminRoutes.post('/private/key/admin/indexes/:name/search-key', withPool(async ({ pool }, c) => {
  const name = c.req.param('name')!
  const result = await mintKey(pool, name, 'search')
  if (!result) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  return c.json({ search_key: result.key }, 201)
}))

adminRoutes.delete('/private/key/admin/indexes/:name/rag-key', withPool(async ({ pool }, c) => {
  const name = c.req.param('name')!
  const revoked = await revokeKey(pool, name, 'rag')
  if (!revoked) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  return c.json({ revoked: true })
}))
