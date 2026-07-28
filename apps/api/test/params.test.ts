// ABOUTME: Tests for the query-parameter parsers: each validates and parses in
// ABOUTME: one step, throwing ValidationError (→ 400 via the shared onError).

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as param from '../middleware/params'
import { onError } from '../middleware/error'

// Mounts a parser on a throwaway app so each case runs through real Hono
// query parsing and the production error handler.
const run = (fn: (c: Context) => unknown) => {
  const app = new Hono()
  app.get('/', c => c.json({ value: fn(c) ?? null }))
  app.onError(onError)
  return async (qs: string) => {
    const res = await app.request(`/${qs}`)
    return { status: res.status, body: await res.json() as any }
  }
}

describe('param.required', () => {
  const get = run(c => param.required(c, 'q'))

  it('returns the trimmed value', async () => {
    expect((await get('?q=%20water%20')).body.value).toBe('water')
  })

  it('400s when missing or blank', async () => {
    expect((await get('')).status).toBe(400)
    expect((await get('?q=%20%20')).status).toBe(400)
  })
})

describe('param.int', () => {
  const get = run(c => param.int(c, 'limit', { fallback: 10, max: 500 }))

  it('falls back when absent and clamps to max', async () => {
    expect((await get('')).body.value).toBe(10)
    expect((await get('?limit=9999')).body.value).toBe(500)
    expect((await get('?limit=42')).body.value).toBe(42)
  })

  it('400s non-numeric and non-positive values', async () => {
    expect((await get('?limit=abc')).status).toBe(400)
    expect((await get('?limit=0')).status).toBe(400)
  })
})

describe('param.oneOf', () => {
  const get = run(c => param.oneOf(c, 'mode', ['hybrid', 'lexical', 'semantic']))

  it('passes through a valid value and absent as undefined', async () => {
    expect((await get('?mode=lexical')).body.value).toBe('lexical')
    expect((await get('')).body.value).toBeNull()
  })

  it('400s an unknown value', async () => {
    expect((await get('?mode=psychic')).status).toBe(400)
  })
})

describe('param.list', () => {
  const get = run(c => param.list(c, 'kinds'))

  it('splits, trims, and drops empty entries', async () => {
    expect((await get('?kinds=posts,%20services%20,')).body.value).toEqual(['posts', 'services'])
    expect((await get('')).body.value).toBeNull()
  })

  it('400s a present-but-empty list', async () => {
    expect((await get('?kinds=,,')).status).toBe(400)
  })
})

describe('param.weights', () => {
  const get = run(c => param.weights(c, 'kind_weights'))

  it('parses pairs, splitting on the last colon', async () => {
    expect((await get('?kind_weights=posts:0.9,a:b:1.5')).body.value).toEqual({ posts: 0.9, 'a:b': 1.5 })
  })

  it('400s bad weights and separator-less pairs', async () => {
    expect((await get('?kind_weights=posts:abc')).status).toBe(400)
    expect((await get('?kind_weights=posts:-1')).status).toBe(400)
    expect((await get('?kind_weights=posts')).status).toBe(400)
  })
})

describe('param.recency', () => {
  const get = run(c => param.recency(c, 'recency'))

  it('parses kinds:half_life_days:floor', async () => {
    expect((await get('?recency=posts,news:180:0.85')).body.value).toEqual({
      kinds: ['posts', 'news'], half_life_days: 180, floor: 0.85,
    })
  })

  it('400s missing fields and out-of-range values', async () => {
    expect((await get('?recency=posts:180')).status).toBe(400)
    expect((await get('?recency=posts:0:0.85')).status).toBe(400)
    expect((await get('?recency=posts:180:1.5')).status).toBe(400)
  })
})
