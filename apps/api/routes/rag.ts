// ABOUTME: RAG synthesis route — POST /public/rag/:name?prompt=<name>
// ABOUTME: Gated by x-rag-key (separate credential from search/index keys).

import { Hono } from 'hono'
import { ragAuth } from '../middleware/auth'
import { apiError } from '../middleware/error'
import { getPool } from '../db/pool'
import { getAdapter } from '../services/adapter'
import { getLlmAdapter } from '../services/llm-adapter'
import { getPrompt } from '../services/prompts'
import { runRag } from '../services/rag'
import type { AppEnv } from '../types'

export const ragRoutes = new Hono<AppEnv>()
ragRoutes.use('/public/rag/:name', ragAuth)

ragRoutes.post('/public/rag/:name', async (c) => {
  const promptName = c.req.query('prompt')
  if (!promptName) {
    return apiError(c, 'VALIDATION_ERROR', 'Missing required query parameter: prompt')
  }

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return apiError(c, 'VALIDATION_ERROR', 'Request body must be valid JSON')
  }

  if (!body.question || typeof body.question !== 'string' || body.question.trim() === '') {
    return apiError(c, 'VALIDATION_ERROR', 'Missing required field: question (string)')
  }
  if (body.messages !== undefined && !Array.isArray(body.messages)) {
    return apiError(c, 'VALIDATION_ERROR', 'messages must be an array')
  }

  const index = c.get('index')
  const pool = await getPool()

  const prompt = await getPrompt(pool, index.index_id, promptName)
  if (!prompt) {
    return apiError(c, 'NOT_FOUND', `Prompt '${promptName}' not found`)
  }

  const embedAdapter = getAdapter(index.config)
  const llmAdapter = getLlmAdapter(prompt.content)

  const result = await runRag(pool, index.index_id, embedAdapter, llmAdapter, {
    promptName,
    promptContent: prompt.content,
    question: body.question.trim(),
    messages: body.messages,
  })

  return c.json(result, 200)
})
