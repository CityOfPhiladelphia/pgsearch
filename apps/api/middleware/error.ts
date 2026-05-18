// ABOUTME: Consistent error response formatting for all API endpoints.
// ABOUTME: Provides helper functions to return standardized error JSON.

import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

type ErrorCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR'

const STATUS_MAP: Record<ErrorCode, ContentfulStatusCode> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INTERNAL_ERROR: 500,
}

export function apiError(c: Context, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } }, STATUS_MAP[code])
}
