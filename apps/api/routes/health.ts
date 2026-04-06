// ABOUTME: Health check endpoint with database connectivity verification.
// ABOUTME: Returns service status and database connection state.

import { Hono } from 'hono'

export const healthRoutes = new Hono()

healthRoutes.get('/public/health', async (c) => {
  try {
    const { getPool } = await import('../db/pool')
    const pool = await getPool()
    await pool.query('SELECT 1')
    return c.json({ status: 'healthy', database: 'connected', timestamp: new Date().toISOString() })
  } catch (error) {
    return c.json({ status: 'unhealthy', database: 'disconnected', timestamp: new Date().toISOString() }, 503)
  }
})
