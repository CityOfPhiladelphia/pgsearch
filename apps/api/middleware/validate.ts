// ABOUTME: Tiny schema-based validator for incoming request bodies.
// ABOUTME: Each schema entry maps a key to one or more validator tuples.

import type { Context } from 'hono'

// ValidationError bubbles to app.onError which translates it to a 400
// VALIDATION_ERROR response. Routes don't catch it — they call assertValid /
// parseBody and let the global handler do the response shaping.
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

// A Rule is a tuple of [validatorName, ...args]. A Schema entry can be a
// single Rule or an array of Rules applied in order (e.g. typeof then min).
// Append a `?` to a key name to mark the field optional (validated only when
// present, skipped when undefined).
export type Rule =
  | readonly ['typeof', 'string' | 'number' | 'boolean']
  | readonly ['oneOf', readonly unknown[]]
  | readonly ['min', number]
  | readonly ['nonEmpty']
  | readonly ['array']
  | readonly ['object']
  | readonly ['schema', Schema]

export type Schema = {
  readonly [key: string]: Rule | readonly Rule[]
}

export type ValidateResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; message: string }

// Returns a Result. Use assertValid for the throwing variant.
export function validate<T = unknown>(input: unknown, schema: Schema): ValidateResult<T> {
  if (input === null || typeof input !== 'object') {
    return { ok: false, message: 'body must be an object' }
  }
  const obj = input as Record<string, unknown>

  for (const rawKey of Object.keys(schema)) {
    const optional = rawKey.endsWith('?')
    const key = optional ? rawKey.slice(0, -1) : rawKey

    if (!(key in obj) || obj[key] === undefined) {
      if (optional) continue
      return { ok: false, message: `${key} is required` }
    }

    const rules = normalizeRules(schema[rawKey])
    for (const rule of rules) {
      const message = applyRule(obj[key], rule, key)
      if (message) return { ok: false, message }
    }
  }

  return { ok: true, value: obj as T }
}

// Throwing variant. Use at route boundaries — the throw bubbles to
// app.onError which returns a 400 with the message.
export function assertValid<T = unknown>(input: unknown, schema: Schema): T {
  const result = validate<T>(input, schema)
  if (!result.ok) throw new ValidationError(result.message)
  return result.value
}

// Parse a JSON request body, throwing ValidationError on malformed JSON.
// Routes get a clean 400 (via app.onError) without their own try/catch.
export async function parseJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new ValidationError('Request body must be valid JSON')
  }
}

// Parse and validate in one call. Returns the body typed as T (the schema
// drives the runtime shape; T is the static annotation the caller supplies).
export async function parseBody<T = unknown>(c: Context, schema: Schema): Promise<T> {
  const body = await parseJson(c)
  return assertValid<T>(body, schema)
}

function normalizeRules(r: Rule | readonly Rule[]): readonly Rule[] {
  // A single Rule has a string verb at index 0; a list of Rules has an array.
  return Array.isArray(r[0]) ? (r as readonly Rule[]) : [r as Rule]
}

function applyRule(value: unknown, rule: Rule, key: string): string | null {
  switch (rule[0]) {
    case 'typeof':
      if (typeof value !== rule[1]) return `${key} must be a ${rule[1]}`
      return null
    case 'oneOf':
      if (!rule[1].includes(value)) {
        return `${key} must be one of: ${rule[1].join(', ')}`
      }
      return null
    case 'min':
      if (typeof value !== 'number' || value < rule[1]) {
        return `${key} must be >= ${rule[1]}`
      }
      return null
    case 'nonEmpty':
      if (typeof value === 'string' && value.trim() === '') return `${key} must not be empty`
      if (Array.isArray(value) && value.length === 0) return `${key} must not be empty`
      return null
    case 'array':
      if (!Array.isArray(value)) return `${key} must be an array`
      return null
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return `${key} must be an object`
      }
      return null
    case 'schema': {
      const sub = validate(value, rule[1])
      if (!sub.ok) return `${key}.${sub.message}`
      return null
    }
  }
}
