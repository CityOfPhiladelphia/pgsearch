// ABOUTME: Prompt CRUD routes for per-index RAG prompts.
// ABOUTME: Gated by x-index-key — the team owning the index owns its prompts.

import { Hono } from 'hono'
import { indexAuth } from '../middleware/auth'
import { apiError } from '../middleware/error'
import { getPool } from '../db/pool'
import {
  createPrompt,
  getPrompt,
  listPrompts,
  updatePrompt,
  deletePrompt,
} from '../services/prompts'
import type { AppEnv, PromptContent } from '../types'

export const promptsRoutes = new Hono<AppEnv>()
promptsRoutes.use('/public/index/:name/prompts', indexAuth)
promptsRoutes.use('/public/index/:name/prompts/*', indexAuth)

function validateContent(c: any): { ok: true; content: PromptContent } | { ok: false; message: string } {
  if (!c || typeof c !== 'object') return { ok: false, message: 'content must be an object' }
  const required: (keyof PromptContent)[] = ['system', 'response_format', 'model', 'max_tokens', 'temperature', 'retrieval']
  for (const key of required) {
    if (!(key in c)) return { ok: false, message: `content.${key} is required` }
  }
  if (typeof c.system !== 'string') return { ok: false, message: 'content.system must be a string' }
  if (typeof c.response_format !== 'string') return { ok: false, message: 'content.response_format must be a string' }
  if (typeof c.model !== 'string') return { ok: false, message: 'content.model must be a string' }
  if (typeof c.max_tokens !== 'number') return { ok: false, message: 'content.max_tokens must be a number' }
  if (typeof c.temperature !== 'number') return { ok: false, message: 'content.temperature must be a number' }
  if (!c.retrieval || typeof c.retrieval !== 'object') return { ok: false, message: 'content.retrieval must be an object' }
  const r = c.retrieval
  const validModes = ['hybrid', 'bm25', 'semantic']
  if (!validModes.includes(r.mode)) {
    return { ok: false, message: `content.retrieval.mode must be one of: ${validModes.join(', ')}` }
  }
  if (typeof r.limit !== 'number' || r.limit < 1) {
    return { ok: false, message: 'content.retrieval.limit must be a positive number' }
  }
  if (typeof r.max_chunks_per_doc !== 'number' || r.max_chunks_per_doc < 1) {
    return { ok: false, message: 'content.retrieval.max_chunks_per_doc must be >= 1' }
  }
  if (typeof r.min_bm25_score !== 'number' || typeof r.min_vector_score !== 'number') {
    return { ok: false, message: 'content.retrieval.min_bm25_score and min_vector_score must be numbers' }
  }
  return { ok: true, content: c as PromptContent }
}

promptsRoutes.post('/public/index/:name/prompts', async (c) => {
  const body = await c.req.json()
  if (!body.name || typeof body.name !== 'string') {
    return apiError(c, 'VALIDATION_ERROR', 'Missing required field: name (string)')
  }
  const v = validateContent(body.content)
  if (!v.ok) return apiError(c, 'VALIDATION_ERROR', v.message)

  const index = c.get('index')
  const pool = await getPool()
  try {
    const created = await createPrompt(pool, index.index_id, body.name, v.content)
    return c.json(created, 201)
  } catch (err: any) {
    if (err.code === '23505') {
      return apiError(c, 'VALIDATION_ERROR', `Prompt '${body.name}' already exists`)
    }
    throw err
  }
})

promptsRoutes.get('/public/index/:name/prompts', async (c) => {
  const index = c.get('index')
  const pool = await getPool()
  const list = await listPrompts(pool, index.index_id)
  return c.json(list)
})

promptsRoutes.get('/public/index/:name/prompts/:promptName', async (c) => {
  const promptName = c.req.param('promptName')
  const index = c.get('index')
  const pool = await getPool()
  const prompt = await getPrompt(pool, index.index_id, promptName)
  if (!prompt) return apiError(c, 'NOT_FOUND', `Prompt '${promptName}' not found`)
  return c.json(prompt)
})

promptsRoutes.patch('/public/index/:name/prompts/:promptName', async (c) => {
  const promptName = c.req.param('promptName')
  const body = await c.req.json()
  const v = validateContent(body.content)
  if (!v.ok) return apiError(c, 'VALIDATION_ERROR', v.message)

  const index = c.get('index')
  const pool = await getPool()
  try {
    await updatePrompt(pool, index.index_id, promptName, v.content)
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      return apiError(c, 'NOT_FOUND', err.message)
    }
    throw err
  }
  const updated = await getPrompt(pool, index.index_id, promptName)
  if (!updated) return apiError(c, 'NOT_FOUND', `Prompt '${promptName}' not found`)
  return c.json(updated)
})

promptsRoutes.delete('/public/index/:name/prompts/:promptName', async (c) => {
  const promptName = c.req.param('promptName')
  const index = c.get('index')
  const pool = await getPool()
  try {
    await deletePrompt(pool, index.index_id, promptName)
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      return apiError(c, 'NOT_FOUND', err.message)
    }
    throw err
  }
  return c.json({ deleted: true })
})
