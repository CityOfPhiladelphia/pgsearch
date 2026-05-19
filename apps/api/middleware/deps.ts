// ABOUTME: Higher-order handler wrappers that inject shared deps (pool, resolved index).
// ABOUTME: Eliminates the boilerplate of calling getPool / c.get('index') in every handler.

import type { Context } from 'hono'
import type { Pool } from 'pg'
import type { AppEnv, SearchIndex } from '../types'
import { getPool } from '../db/pool'

// Wrapping handlers in a HOF erases Hono's path-literal type inference, so
// c.req.param('foo') resolves to string | undefined inside wrapped handlers
// even when the path registers `:foo`. Use `c.req.param('foo')!` on path
// params that the route guarantees — Hono only invokes the handler when the
// route matched, so the param is always present at runtime.

type AnyHandler<D, C> = (deps: D, c: C) => Promise<Response> | Response

// For handlers that need the pool but no resolved index — typically admin or
// health routes. getPool() is memoized so the call is a synchronous map
// lookup after the first invocation per Lambda container.
export function withPool<P extends string>(
  handler: AnyHandler<{ pool: Pool }, Context<AppEnv, P>>,
) {
  return async (c: Context<AppEnv, P>) => {
    const pool = await getPool()
    return handler({ pool }, c)
  }
}

// For handlers behind index/search/rag auth middleware, which resolves and
// sets the SearchIndex on the context. The index is non-null here because the
// auth middleware short-circuits the request before this wrapper runs.
export function withIndex<P extends string>(
  handler: AnyHandler<{ pool: Pool; index: SearchIndex }, Context<AppEnv, P>>,
) {
  return async (c: Context<AppEnv, P>) => {
    const pool = await getPool()
    const index = c.get('index')
    return handler({ pool, index }, c)
  }
}
