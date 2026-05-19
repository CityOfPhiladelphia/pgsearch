// ABOUTME: Tests for the schema-based validator in middleware/validate.ts.
// ABOUTME: Covers typeof / oneOf / min / nonEmpty / array / schema / optional + assertValid.

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { validate, assertValid, parseJson, parseBody, ValidationError } from '../middleware/validate'

describe('validate', () => {
  it('accepts a body that matches a simple typeof schema', () => {
    const r = validate({ name: 'foo' }, { name: ['typeof', 'string'] })
    expect(r.ok).toBe(true)
  })

  it('rejects non-object input', () => {
    expect(validate(null, { name: ['typeof', 'string'] }).ok).toBe(false)
    expect(validate('string', { name: ['typeof', 'string'] }).ok).toBe(false)
    expect(validate(42, { name: ['typeof', 'string'] }).ok).toBe(false)
  })

  it('reports missing required fields', () => {
    const r = validate({}, { name: ['typeof', 'string'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/name is required/)
  })

  it('skips optional fields when absent (?-suffix)', () => {
    const schema = { name: ['typeof', 'string'], 'extra?': ['typeof', 'number'] } as const
    const r = validate({ name: 'foo' }, schema)
    expect(r.ok).toBe(true)
  })

  it('validates optional fields when present', () => {
    const schema = { name: ['typeof', 'string'], 'extra?': ['typeof', 'number'] } as const
    const r = validate({ name: 'foo', extra: 'wrong-type' }, schema)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/extra must be a number/)
  })

  it('applies multiple rules per key in order', () => {
    const schema = { n: [['typeof', 'number'], ['min', 1]] } as const
    expect(validate({ n: 'x' }, schema).ok).toBe(false)
    expect(validate({ n: 0 }, schema).ok).toBe(false)
    expect(validate({ n: 1 }, schema).ok).toBe(true)
  })

  it('oneOf restricts to enumerated values', () => {
    const schema = { mode: ['oneOf', ['a', 'b', 'c']] } as const
    expect(validate({ mode: 'a' }, schema).ok).toBe(true)
    expect(validate({ mode: 'z' }, schema).ok).toBe(false)
  })

  it('nonEmpty rejects whitespace-only strings', () => {
    const schema = { q: [['typeof', 'string'], ['nonEmpty']] } as const
    expect(validate({ q: '' }, schema).ok).toBe(false)
    expect(validate({ q: '   ' }, schema).ok).toBe(false)
    expect(validate({ q: 'hello' }, schema).ok).toBe(true)
  })

  it('nonEmpty rejects empty arrays', () => {
    const schema = { items: [['array'], ['nonEmpty']] } as const
    expect(validate({ items: [] }, schema).ok).toBe(false)
    expect(validate({ items: [1] }, schema).ok).toBe(true)
  })

  it('array rejects non-arrays', () => {
    const schema = { items: ['array'] } as const
    expect(validate({ items: 'not array' }, schema).ok).toBe(false)
    expect(validate({ items: [] }, schema).ok).toBe(true)
  })

  it('object rejects null, arrays, and primitives', () => {
    const schema = { x: ['object'] } as const
    expect(validate({ x: null }, schema).ok).toBe(false)
    expect(validate({ x: [] }, schema).ok).toBe(false)
    expect(validate({ x: 'foo' }, schema).ok).toBe(false)
    expect(validate({ x: 42 }, schema).ok).toBe(false)
    expect(validate({ x: {} }, schema).ok).toBe(true)
    expect(validate({ x: { y: 1 } }, schema).ok).toBe(true)
  })

  it('schema rule recurses into nested objects', () => {
    const subSchema = { x: ['typeof', 'number'] } as const
    const schema = { obj: ['schema', subSchema] } as const
    expect(validate({ obj: { x: 1 } }, schema).ok).toBe(true)
    const r = validate({ obj: { x: 'wrong' } }, schema)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/obj\.x must be a number/)
  })

  it('schema rule reports missing nested keys', () => {
    const subSchema = { x: ['typeof', 'number'] } as const
    const schema = { obj: ['schema', subSchema] } as const
    const r = validate({ obj: {} }, schema)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/obj\.x is required/)
  })
})

describe('assertValid', () => {
  it('returns the value on success', () => {
    const v = assertValid<{ name: string }>({ name: 'foo' }, { name: ['typeof', 'string'] })
    expect(v.name).toBe('foo')
  })

  it('throws ValidationError on failure', () => {
    expect(() => assertValid({}, { name: ['typeof', 'string'] })).toThrow(ValidationError)
    expect(() => assertValid({}, { name: ['typeof', 'string'] })).toThrow(/name is required/)
  })
})

describe('parseJson / parseBody', () => {
  // Small Hono app: route under test on POST /, ValidationError → 400 in onError.
  function buildApp(handler: (c: any) => Promise<Response>) {
    const app = new Hono()
    app.post('/', handler)
    app.onError((err, c) => {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400)
      throw err
    })
    return app
  }

  it('parseJson returns the parsed body for valid JSON', async () => {
    const app = buildApp(async (c) => {
      const body = await parseJson(c)
      return c.json({ received: body })
    })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: { x: 1 } })
  })

  it('parseJson returns 400 on malformed JSON', async () => {
    const app = buildApp(async (c) => {
      await parseJson(c)
      return c.json({ ok: true })
    })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Request body must be valid JSON' })
  })

  it('parseBody parses then validates', async () => {
    const schema = { name: [['typeof', 'string'], ['nonEmpty']] } as const
    const app = buildApp(async (c) => {
      const body = await parseBody<{ name: string }>(c, schema)
      return c.json(body)
    })

    const ok = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'foo' }),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ name: 'foo' })

    const bad = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })
    expect(bad.status).toBe(400)

    const malformed = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(malformed.status).toBe(400)
  })
})
