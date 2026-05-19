// ABOUTME: Tests for the schema-based validator in middleware/validate.ts.
// ABOUTME: Covers typeof / oneOf / min / nonEmpty / array / schema / optional + assertValid.

import { describe, it, expect } from 'vitest'
import { validate, assertValid, ValidationError } from '../middleware/validate'

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
