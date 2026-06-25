// ABOUTME: Route wiring tests — pin ingest and search endpoints to the /public/* prefix.
// ABOUTME: API Gateway only forwards /public/{proxy+} and /private/key/{proxy+}; paths outside
// ABOUTME: those prefixes return 403 "Missing Authentication Token" before reaching the Lambda.

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { ingestRoutes } from '../routes/ingest'
import { searchRoutes } from '../routes/search'
import { promptsRoutes } from '../routes/prompts'
import { ragRoutes } from '../routes/rag'

// Minimal app that wires only the routes under test, skipping the DB + migration middleware
// from the full app. The auth middleware short-circuits on missing header before any DB access,
// so these tests don't need a live Postgres.
const app = new Hono()
app.route('/', ingestRoutes)
app.route('/', searchRoutes)

const promptsApp = new Hono()
promptsApp.route('/', promptsRoutes)

describe('ingest route wiring', () => {
  it('mounts POST /public/index/:name/documents behind indexAuth', async () => {
    const res = await app.request('/public/index/any-index/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ external_id: 'x', title: 'y', body: 'z' }),
    })
    // indexAuth short-circuits on missing x-index-key → 401, proving the route is mounted.
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('mounts DELETE /public/index/:name/documents/:external_id behind indexAuth', async () => {
    const res = await app.request('/public/index/any-index/documents/some-id', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  it('mounts GET /public/index/:name/documents behind indexAuth', async () => {
    const res = await app.request('/public/index/any-index/documents')
    // indexAuth short-circuits on missing x-index-key → 401, proving the route is mounted.
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('does not expose /index/:name/documents outside /public/*', async () => {
    const res = await app.request('/index/any-index/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ external_id: 'x', title: 'y', body: 'z' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('search route wiring', () => {
  it('mounts GET /public/search/:name behind searchAuth', async () => {
    const res = await app.request('/public/search/any-index?q=hello')
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('does not expose /search/:name outside /public/*', async () => {
    const res = await app.request('/search/any-index?q=hello')
    expect(res.status).toBe(404)
  })
})

const ragApp = new Hono()
ragApp.route('/', ragRoutes)

describe('rag route wiring', () => {
  it('mounts POST /public/rag/:name behind ragAuth (missing key → 401)', async () => {
    const res = await ragApp.request('/public/rag/any-index?prompt=any', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'q' }),
    })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('does not expose /rag/:name outside /public/*', async () => {
    const res = await ragApp.request('/rag/any-index?prompt=any', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'q' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('prompt route wiring', () => {
  it('mounts POST /public/index/:name/prompts behind indexAuth', async () => {
    const res = await promptsApp.request('/public/index/any-index/prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'p', content: {} }),
    })
    expect(res.status).toBe(401)
  })

  it('mounts GET /public/index/:name/prompts behind indexAuth', async () => {
    const res = await promptsApp.request('/public/index/any-index/prompts')
    expect(res.status).toBe(401)
  })

  it('mounts GET /public/index/:name/prompts/:promptName behind indexAuth', async () => {
    const res = await promptsApp.request('/public/index/any-index/prompts/foo')
    expect(res.status).toBe(401)
  })

  it('mounts PATCH /public/index/:name/prompts/:promptName behind indexAuth', async () => {
    const res = await promptsApp.request('/public/index/any-index/prompts/foo', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: {} }),
    })
    expect(res.status).toBe(401)
  })

  it('mounts DELETE /public/index/:name/prompts/:promptName behind indexAuth', async () => {
    const res = await promptsApp.request('/public/index/any-index/prompts/foo', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })
})
