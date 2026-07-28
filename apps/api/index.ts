// ABOUTME: Lambda entry point for the pgsearch hybrid search API.
// ABOUTME: Wires all route groups (admin, ingest, search, health) with cold-start migrations.

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { handle } from 'hono/aws-lambda'
import { adminRoutes } from './routes/admin'
import { ingestRoutes } from './routes/ingest'
import { searchRoutes } from './routes/search'
import { promptsRoutes } from './routes/prompts'
import { ragRoutes } from './routes/rag'
import { analyticsRoutes } from './routes/analytics'
import { healthRoutes } from './routes/health'
import { getPool, registerVectorType } from './db/pool'
import { runMigrations } from './db/migrate'
import { onError } from './middleware/error'

export const app = new Hono()

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-index-key', 'x-search-key', 'x-rag-key', 'x-analytics-key'],
}))

app.use('*', async (c, next) => {
  const pool = await getPool()
  await runMigrations(pool)
  await registerVectorType()
  await next()
})

app.route('/', healthRoutes)
app.route('/', adminRoutes)
app.route('/', ingestRoutes)
app.route('/', searchRoutes)
app.route('/', promptsRoutes)
app.route('/', ragRoutes)
app.route('/', analyticsRoutes)

app.onError(onError)

export const handler = handle(app)
