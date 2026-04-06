// ABOUTME: Consistent error response formatting for all API endpoints.
// ABOUTME: Provides helper functions to return standardized error JSON.

import type { Context } from 'hono'

type ErrorCode = 'UNAUTHORIZED' | 'NOT_FOUND' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR'

const STATUS_MAP: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INTERNAL_ERROR: 500,
}

export function apiError(c: Context, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } }, STATUS_MAP[code])
}
