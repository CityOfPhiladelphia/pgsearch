// ABOUTME: Per-index authentication middleware for pgsearch API.
// ABOUTME: Verifies index, search, and RAG keys against bcrypt hashes stored per index.

import { createMiddleware } from 'hono/factory'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import type { AppEnv, SearchIndex } from '../types'
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

type KeyHashField = 'index_key_hash' | 'search_key_hash' | 'rag_key_hash'

interface KeyAuthConfig {
  header: string
  hashField: KeyHashField
  keyLabel: string
}

function keyAuth(config: KeyAuthConfig) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const key = c.req.header(config.header)
    if (!key) {
      return apiError(c, 'UNAUTHORIZED', `Missing ${config.header} header`)
    }
    const indexName = c.req.param('name')
    if (!indexName) {
      return apiError(c, 'VALIDATION_ERROR', 'Missing index name')
    }

    const { getIndex } = await import('../services/indexes')
    const { getPool } = await import('../db/pool')
    const pool = await getPool()
    const index: SearchIndex | null = await getIndex(pool, indexName)
    if (!index) return apiError(c, 'NOT_FOUND', `Index '${indexName}' not found`)

    const hash = index[config.hashField]
    // Null hash and bad key both surface as the same 401. A null rag_key_hash
    // (RAG not enabled) is informative to the caller but technically
    // indistinguishable from "wrong key" by verifyKey alone; collapsing them
    // keeps the middleware one shape and the API surface predictable.
    if (!hash || !(await verifyKey(key, hash))) {
      return apiError(c, 'UNAUTHORIZED', `Invalid ${config.keyLabel} key`)
    }

    c.set('index', index)
    await next()
    return
  })
}

export const indexAuth = keyAuth({ header: 'x-index-key', hashField: 'index_key_hash', keyLabel: 'index' })
export const searchAuth = keyAuth({ header: 'x-search-key', hashField: 'search_key_hash', keyLabel: 'search' })
export const ragAuth = keyAuth({ header: 'x-rag-key', hashField: 'rag_key_hash', keyLabel: 'RAG' })
