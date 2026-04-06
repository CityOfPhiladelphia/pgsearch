// ABOUTME: Three-tier authentication middleware for pgsearch API.
// ABOUTME: Verifies admin, index, and search keys against bcrypt hashes.

import { createMiddleware } from 'hono/factory'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import type { Context, Next } from 'hono'
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

export const adminAuth = createMiddleware(async (c: Context, next: Next) => {
  const apiKey = c.req.header('x-api-key')
  if (!apiKey) {
    return apiError(c, 'UNAUTHORIZED', 'Missing x-api-key header')
  }
  const adminKeyHash = process.env.ADMIN_KEY_HASH
  if (!adminKeyHash || !(await verifyKey(apiKey, adminKeyHash))) {
    return apiError(c, 'UNAUTHORIZED', 'Invalid admin key')
  }
  await next()
})

export const indexAuth = createMiddleware(async (c: Context, next: Next) => {
  const indexKey = c.req.header('x-index-key')
  if (!indexKey) {
    return apiError(c, 'UNAUTHORIZED', 'Missing x-index-key header')
  }
  const indexName = c.req.param('name')
  if (!indexName) {
    return apiError(c, 'VALIDATION_ERROR', 'Missing index name')
  }
  // Placeholder: full DB verification will be added in Task 5 when index service exists.
  // For now, store key and name on context for route handler to verify.
  c.set('indexKey', indexKey)
  c.set('indexName', indexName)
  await next()
})

export const searchAuth = createMiddleware(async (c: Context, next: Next) => {
  const searchKey = c.req.header('x-search-key')
  if (!searchKey) {
    return apiError(c, 'UNAUTHORIZED', 'Missing x-search-key header')
  }
  c.set('searchKey', searchKey)
  c.set('indexName', c.req.param('name'))
  await next()
})
