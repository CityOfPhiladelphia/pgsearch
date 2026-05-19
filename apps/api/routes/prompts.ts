// ABOUTME: Prompt CRUD routes for per-index RAG prompts.
// ABOUTME: Gated by x-index-key — the team owning the index owns its prompts.

import { Hono } from 'hono'
import { indexAuth } from '../middleware/auth'
import { withIndex } from '../middleware/deps'
import { apiError } from '../middleware/error'
import { parseBody, type Schema } from '../middleware/validate'
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

const retrievalSchema: Schema = {
  mode: ['oneOf', ['hybrid', 'bm25', 'semantic']],
  limit: [['typeof', 'number'], ['min', 1]],
  max_chunks_per_doc: [['typeof', 'number'], ['min', 1]],
  min_bm25_score: ['typeof', 'number'],
  min_vector_score: ['typeof', 'number'],
}

const promptContentSchema: Schema = {
  system: ['typeof', 'string'],
  response_format: ['typeof', 'string'],
  model: ['typeof', 'string'],
  max_tokens: ['typeof', 'number'],
  temperature: ['typeof', 'number'],
  retrieval: ['schema', retrievalSchema],
}

const createPromptSchema: Schema = {
  name: [['typeof', 'string'], ['nonEmpty']],
  content: ['schema', promptContentSchema],
}

const patchPromptSchema: Schema = {
  content: ['schema', promptContentSchema],
}

promptsRoutes.post('/public/index/:name/prompts', withIndex(async ({ pool, index }, c) => {
  const { name, content } = await parseBody<{ name: string; content: PromptContent }>(c, createPromptSchema)
  const created = await createPrompt(pool, index.index_id, name, content)
  if (!created) return apiError(c, 'VALIDATION_ERROR', `Prompt '${name}' already exists`)
  return c.json(created, 201)
}))

promptsRoutes.get('/public/index/:name/prompts', withIndex(async ({ pool, index }, c) => {
  const list = await listPrompts(pool, index.index_id)
  return c.json(list)
}))

promptsRoutes.get('/public/index/:name/prompts/:promptName', withIndex(async ({ pool, index }, c) => {
  const promptName = c.req.param('promptName')!
  const prompt = await getPrompt(pool, index.index_id, promptName)
  if (!prompt) return apiError(c, 'NOT_FOUND', `Prompt '${promptName}' not found`)
  return c.json(prompt)
}))

promptsRoutes.patch('/public/index/:name/prompts/:promptName', withIndex(async ({ pool, index }, c) => {
  const promptName = c.req.param('promptName')!
  const { content } = await parseBody<{ content: PromptContent }>(c, patchPromptSchema)
  const updated = await updatePrompt(pool, index.index_id, promptName, content)
  if (!updated) return apiError(c, 'NOT_FOUND', `Prompt '${promptName}' not found`)
  return c.json(updated)
}))

promptsRoutes.delete('/public/index/:name/prompts/:promptName', withIndex(async ({ pool, index }, c) => {
  const promptName = c.req.param('promptName')!
  const deleted = await deletePrompt(pool, index.index_id, promptName)
  if (!deleted) return apiError(c, 'NOT_FOUND', `Prompt '${promptName}' not found`)
  return c.json({ deleted: true })
}))
