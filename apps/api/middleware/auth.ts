// ABOUTME: Per-index authentication middleware for pgsearch API.
// ABOUTME: Verifies index, search, and RAG keys against bcrypt hashes stored per index.

import { createMiddleware } from 'hono/factory'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import type { AppEnv } from '../types'
import { apiError } from './error'

const BCRYPT_ROUNDS = 10

export function generateKey(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`
}

export async function hashKey(key: string): Promise<string> {
  return bcrypt.hash(key, BCRYPT_ROUNDS)
}

export async function verifyKey(key: string, hash: string): Promise<boolean> {
  return bcrypt.compare(key, hash)
}

export const indexAuth = createMiddleware<AppEnv>(async (c, next) => {
  const indexKey = c.req.header('x-index-key')
  if (!indexKey) {
    return apiError(c, 'UNAUTHORIZED', 'Missing x-index-key header')
  }
  const indexName = c.req.param('name')
  if (!indexName) {
    return apiError(c, 'VALIDATION_ERROR', 'Missing index name')
  }

  const { getIndex } = await import('../services/indexes')
  const { getPool } = await import('../db/pool')
  const pool = await getPool()
  const index = await getIndex(pool, indexName)
  if (!index) return apiError(c, 'NOT_FOUND', `Index '${indexName}' not found`)
  if (!(await verifyKey(indexKey, index.index_key_hash))) {
    return apiError(c, 'UNAUTHORIZED', 'Invalid index key')
  }

  c.set('index', index)
  await next()
  return
})

export const searchAuth = createMiddleware<AppEnv>(async (c, next) => {
  const searchKey = c.req.header('x-search-key')
  if (!searchKey) {
    return apiError(c, 'UNAUTHORIZED', 'Missing x-search-key header')
  }
  const indexName = c.req.param('name')
  if (!indexName) {
    return apiError(c, 'VALIDATION_ERROR', 'Missing index name')
  }

  const { getIndex } = await import('../services/indexes')
  const { getPool } = await import('../db/pool')
  const pool = await getPool()
  const index = await getIndex(pool, indexName)
  if (!index) return apiError(c, 'NOT_FOUND', `Index '${indexName}' not found`)
  if (!(await verifyKey(searchKey, index.search_key_hash))) {
    return apiError(c, 'UNAUTHORIZED', 'Invalid search key')
  }

  c.set('index', index)
  await next()
  return
})

export const ragAuth = createMiddleware<AppEnv>(async (c, next) => {
  const ragKey = c.req.header('x-rag-key')
  if (!ragKey) {
    return apiError(c, 'UNAUTHORIZED', 'Missing x-rag-key header')
  }
  const indexName = c.req.param('name')
  if (!indexName) {
    return apiError(c, 'VALIDATION_ERROR', 'Missing index name')
  }

  const { getIndex } = await import('../services/indexes')
  const { getPool } = await import('../db/pool')
  const pool = await getPool()
  const index = await getIndex(pool, indexName)
  if (!index) return apiError(c, 'NOT_FOUND', `Index '${indexName}' not found`)
  if (!index.rag_key_hash) {
    return apiError(c, 'FORBIDDEN', 'RAG is not enabled for this index')
  }
  if (!(await verifyKey(ragKey, index.rag_key_hash))) {
    return apiError(c, 'UNAUTHORIZED', 'Invalid RAG key')
  }

  c.set('index', index)
  await next()
  return
})
