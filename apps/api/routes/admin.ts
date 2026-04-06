// ABOUTME: Admin API routes for index management.
// ABOUTME: Handles CRUD operations on search indexes behind admin key authentication.

import { Hono } from 'hono'
import { adminAuth } from '../middleware/auth'
import { createIndex, getIndex, listIndexes, updateIndex, deleteIndex } from '../services/indexes'
import { apiError } from '../middleware/error'
import { getPool } from '../db/pool'

export const adminRoutes = new Hono()
adminRoutes.use('/*', adminAuth)

adminRoutes.post('/admin/indexes', async (c) => {
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
  return c.json(result, 201)
})

adminRoutes.get('/admin/indexes', async (c) => {
  const pool = await getPool()
  const indexes = await listIndexes(pool)
  return c.json(indexes)
})

adminRoutes.get('/admin/indexes/:name', async (c) => {
  const name = c.req.param('name')
  const pool = await getPool()
  const index = await getIndex(pool, name)
  if (!index) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  return c.json(index)
})

adminRoutes.patch('/admin/indexes/:name', async (c) => {
  const name = c.req.param('name')
  const body = await c.req.json()

  const pool = await getPool()
  try {
    await updateIndex(pool, name, body)
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      return apiError(c, 'NOT_FOUND', err.message)
    }
    throw err
  }

  const updated = await getIndex(pool, name)
  return c.json(updated)
})

adminRoutes.delete('/admin/indexes/:name', async (c) => {
  const name = c.req.param('name')
  const pool = await getPool()
  try {
    await deleteIndex(pool, name)
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      return apiError(c, 'NOT_FOUND', err.message)
    }
    throw err
  }
  return c.json({ deleted: true })
})

adminRoutes.post('/admin/indexes/:name/refresh', async (c) => {
  // Stub: materialized view refresh will be implemented in Task 9
  return c.json({ status: 'not_implemented' }, 501)
})
