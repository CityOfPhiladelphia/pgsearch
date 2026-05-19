// ABOUTME: Health check endpoint with database connectivity verification.
// ABOUTME: Returns service status and database connection state.

import { Hono } from 'hono'
import { withPool } from '../middleware/deps'

export const healthRoutes = new Hono()

healthRoutes.get('/public/health', withPool(async ({ pool }, c) => {
  try {
    await pool.query('SELECT 1')
    return c.json({ status: 'healthy', database: 'connected', timestamp: new Date().toISOString() })
  } catch {
    return c.json({ status: 'unhealthy', database: 'disconnected', timestamp: new Date().toISOString() }, 503)
  }
}))
