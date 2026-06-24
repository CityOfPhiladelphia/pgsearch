// ABOUTME: RAG synthesis route — POST /public/rag/:name?prompt=<name>
// ABOUTME: Gated by x-rag-key (separate credential from search/index keys).

import { Hono } from 'hono'
import { ragAuth } from '../middleware/auth'
import { withIndex } from '../middleware/deps'
import { apiError } from '../middleware/error'
import { parseBody, type Schema } from '../middleware/validate'
import { getAdapter } from '../services/adapter'
import { getLlmAdapter } from '../services/llm-adapter'
import { getPrompt } from '../services/prompts'
import { runRag } from '../services/rag'
import type { AppEnv } from '../types'

const ragRequestSchema: Schema = {
  question: [['typeof', 'string'], ['nonEmpty']],
  'messages?': ['array'],
}

export const ragRoutes = new Hono<AppEnv>()
ragRoutes.use('/public/rag/:name', ragAuth)

ragRoutes.post('/public/rag/:name', withIndex(async ({ pool, index }, c) => {
  const promptName = c.req.query('prompt')
  if (!promptName) return apiError(c, 'VALIDATION_ERROR', 'Missing required query parameter: prompt')

  const { question, messages } = await parseBody<{
    question: string
    messages?: { role: 'user' | 'assistant'; content: string }[]
  }>(c, ragRequestSchema)

  const prompt = await getPrompt(pool, index.index_id, promptName)
  if (!prompt) return apiError(c, 'NOT_FOUND', `Prompt '${promptName}' not found`)

  const embedAdapter = getAdapter(index.config)
  const llmAdapter = getLlmAdapter(prompt.content)

  const result = await runRag(pool, index, embedAdapter, llmAdapter, {
    promptName,
    promptContent: prompt.content,
    question: question.trim(),
    messages,
  })
  return c.json(result, 200)
}))
