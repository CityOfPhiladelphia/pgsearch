// ABOUTME: Query-parameter parsers for route handlers, imported as `param.*`.
// ABOUTME: Each validates and parses in one step, throwing ValidationError on bad input.

import type { Context } from 'hono'
import { ValidationError } from './validate'
import type { RecencyRule } from '../types'

// Required non-empty string, trimmed.
export function required(c: Context, name: string): string {
  const value = c.req.query(name)
  if (!value || value.trim() === '') throw new ValidationError(`Missing required query parameter: ${name}`)
  return value.trim()
}

// Positive integer, falling back when absent; values above max clamp rather than error.
export function int(c: Context, name: string, opts: { fallback: number; max?: number }): number {
  const raw = c.req.query(name)
  if (!raw) return opts.fallback
  const value = parseInt(raw, 10)
  if (isNaN(value) || value < 1) throw new ValidationError(`${name} must be a positive integer`)
  return opts.max ? Math.min(value, opts.max) : value
}

// One of a fixed set of values, or undefined when absent.
export function oneOf<T extends string>(c: Context, name: string, allowed: readonly T[]): T | undefined {
  const value = c.req.query(name)
  if (value === undefined) return undefined
  if (!allowed.includes(value as T)) throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}`)
  return value as T
}

// Comma-separated list, trimmed with empty entries dropped; undefined when absent.
// A present-but-empty list is an error rather than an empty filter.
export function list(c: Context, name: string): string[] | undefined {
  const raw = c.req.query(name)
  if (raw == null) return undefined
  const items = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (items.length === 0) throw new ValidationError(`${name} must be a comma-separated list`)
  return items
}

// Comma-separated name:weight pairs with weights >= 0 (e.g. services:1.3,posts:0.9).
// Splits on the last colon so names may themselves contain colons.
export function weights(c: Context, name: string): Record<string, number> | undefined {
  const raw = c.req.query(name)
  if (!raw) return undefined
  const parsed: Record<string, number> = {}
  for (const pair of raw.split(',')) {
    const sep = pair.lastIndexOf(':')
    const key = pair.slice(0, sep).trim()
    const weight = Number(pair.slice(sep + 1))
    if (sep < 1 || !key || !Number.isFinite(weight) || weight < 0) {
      throw new ValidationError(`${name} must be comma-separated name:weight pairs with weights >= 0`)
    }
    parsed[key] = weight
  }
  return parsed
}

// Recency rule as kinds:half_life_days:floor, kinds comma-separated (e.g. posts:180:0.85).
export function recency(c: Context, name: string): RecencyRule | undefined {
  const raw = c.req.query(name)
  if (!raw) return undefined
  const parts = raw.split(':')
  const floor = Number(parts.pop())
  const halfLife = Number(parts.pop())
  const kinds = parts.join(':').split(',').map(k => k.trim()).filter(Boolean)
  if (kinds.length === 0 || !Number.isFinite(halfLife) || halfLife <= 0 || !Number.isFinite(floor) || floor < 0 || floor > 1) {
    throw new ValidationError(`${name} must be kinds:half_life_days:floor with half_life_days > 0 and floor in [0,1]`)
  }
  return { kinds, half_life_days: halfLife, floor }
}
