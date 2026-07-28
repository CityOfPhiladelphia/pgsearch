// ABOUTME: Consistent error response formatting for all API endpoints.
// ABOUTME: Provides helper functions to return standardized error JSON.

import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ValidationError } from './validate'

type ErrorCode = 'UNAUTHORIZED' | 'NOT_FOUND' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR'

const STATUS_MAP: Record<ErrorCode, ContentfulStatusCode> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INTERNAL_ERROR: 500,
}

export function apiError(c: Context, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } }, STATUS_MAP[code])
}

// Global error handler: thrown ValidationError → 400; anything else is logged
// and collapsed to a generic 500. Registered by the app entry point and by
// route tests that mount routes on a bare Hono app.
export function onError(err: Error, c: Context) {
  if (err instanceof ValidationError) {
    return apiError(c, 'VALIDATION_ERROR', err.message)
  }
  console.error('Unhandled error:', err)
  return apiError(c, 'INTERNAL_ERROR', 'Internal server error')
}
