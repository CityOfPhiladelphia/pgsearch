// ABOUTME: Tests for time-based relevance decay on the fused score.
// ABOUTME: Covers the multiplier math and the config/request wiring; undated docs and unlisted kinds stay neutral.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { createIndex, getIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { hybridSearch, recencyMultiplier, type HybridSearchOptions } from '../services/search'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'
import type { RecencyRule } from '../types'

const DAY_MS = 86_400_000

describe('recencyMultiplier', () => {
  const rule: RecencyRule = { kinds: ['posts'], half_life_days: 180, floor: 0.85 }
  const now = Date.parse('2026-07-13')

  it('is neutral for a doc published today', () => {
    expect(recencyMultiplier(rule, 'posts', { published_at: '2026-07-13' }, now)).toBeCloseTo(1.0, 10)
  })

  it('sits halfway between 1 and the floor at one half-life', () => {
    const published = new Date(now - 180 * DAY_MS).toISOString().slice(0, 10)
    expect(recencyMultiplier(rule, 'posts', { published_at: published }, now)).toBeCloseTo(0.925, 10)
  })

  it('converges to the floor for ancient docs', () => {
    expect(recencyMultiplier(rule, 'posts', { published_at: '2015-01-01' }, now)).toBeCloseTo(0.85, 4)
  })

  it('clamps future dates to neutral', () => {
    expect(recencyMultiplier(rule, 'posts', { published_at: '2027-01-01' }, now)).toBe(1)
  })

  it('is neutral without a rule, for unlisted kinds, and for missing or malformed dates', () => {
    expect(recencyMultiplier(undefined, 'posts', { published_at: '2015-01-01' }, now)).toBe(1)
    expect(recencyMultiplier(rule, 'services', { published_at: '2015-01-01' }, now)).toBe(1)
    expect(recencyMultiplier(rule, null, { published_at: '2015-01-01' }, now)).toBe(1)
    expect(recencyMultiplier(rule, 'posts', {}, now)).toBe(1)
    expect(recencyMultiplier(rule, 'posts', { published_at: 'not-a-date' }, now)).toBe(1)
  })
})

describe('recency decay at fusion', () => {
  let pool: Pool
  let indexId: number
  const adapter = createTestAdapter(384)
  const rule: RecencyRule = { kinds: ['posts'], half_life_days: 180, floor: 0.85 }
  const today = new Date().toISOString().slice(0, 10)

  // bm25 mode keeps ordering fully deterministic (no synthetic-embedding ranks);
  // the recency multiplier applies at fusion in every mode.
  const search = async (queryText: string, options: HybridSearchOptions = {}) =>
    hybridSearch(pool, (await getIndex(pool, 'recency-test'))!, adapter, queryText, { mode: 'bm25', ...options })

  const ids = (response: { results: { external_id: string }[] }) => response.results.map(r => r.external_id)

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    await createIndex(pool, {
      name: 'recency-test',
      config: { recency: rule, embedding: { dimensions: 384 } as any },
    })
    const row = await pool.query("SELECT index_id FROM search_indexes WHERE name = 'recency-test'")
    indexId = row.rows[0].index_id
    const config = mergeConfig({ recency: rule })

    // The stale post is the stronger lexical match (query terms in title and a
    // term-dense body), so undecayed it outranks the fresh post.
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'stale',
      kind: 'posts',
      title: 'Snow emergency declared for city snow routes',
      body: 'Snow emergency declared: the snow emergency covers all snow emergency routes citywide.',
      metadata: { published_at: '2015-01-15' },
    }, config)
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'fresh',
      kind: 'posts',
      title: 'Snow emergency declared',
      body: 'A snow emergency takes effect tonight.',
      metadata: { published_at: today },
    }, config)
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'undated',
      kind: 'posts',
      title: 'Snow emergency information',
      body: 'General information page.',
    }, config)
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'evergreen',
      kind: 'services',
      title: 'Snow emergency routes',
      body: 'Snow emergency routes must stay clear during a snow emergency.',
      metadata: { published_at: '2015-01-15' },
    }, config)
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('decays a stale post below a fresh one it lexically outranks', async () => {
    const order = ids(await search('snow emergency declared'))
    expect(order.indexOf('fresh')).toBeLessThan(order.indexOf('stale'))
  })

  it('request-level recency replaces the config rule', async () => {
    // A floorless, near-instant decay via request override sinks the stale post
    // to the bottom regardless of the gentler config rule.
    const order = ids(await search('snow emergency declared', { recency: { kinds: ['posts'], half_life_days: 1, floor: 0 } }))
    expect(order[order.length - 1]).toBe('stale')
  })

  it('leaves unlisted kinds and undated docs in baseline order relative to each other', async () => {
    // 'evergreen' (kind not listed, despite an old published_at) and 'undated'
    // carry multiplier 1 either way.
    const baseline = ids(await search('snow emergency declared', { recency: { kinds: [], half_life_days: 180, floor: 0.85 } }))
    const decayed = ids(await search('snow emergency declared'))
    const neutralOnly = (list: string[]) => list.filter(id => id === 'evergreen' || id === 'undated')
    expect(neutralOnly(decayed)).toEqual(neutralOnly(baseline))
  })
})
