// ABOUTME: Integration tests for result-type weighting via document kind.
// ABOUTME: Config kind_weights damp/boost fused scores; request-level kindWeights replace them; missing kinds are neutral.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { createIndex, getIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { hybridSearch, type HybridSearchOptions } from '../services/search'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

describe('kind weighting', () => {
  let pool: Pool
  let indexId: number
  const adapter = createTestAdapter(384)

  // lexical mode keeps ordering fully deterministic (no synthetic-embedding ranks);
  // the kind multiplier applies at fusion in every mode.
  const search = async (queryText: string, options: HybridSearchOptions = {}) =>
    hybridSearch(pool, (await getIndex(pool, 'kind-weights-test'))!, adapter, queryText, { mode: 'lexical', ...options })

  const ids = (response: { results: { external_id: string }[] }) => response.results.map(r => r.external_id)

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    await createIndex(pool, {
      name: 'kind-weights-test',
      config: { kind_weights: { reports: 0.5 }, embedding: { dimensions: 384 } as any },
    })
    const row = await pool.query("SELECT index_id FROM search_indexes WHERE name = 'kind-weights-test'")
    indexId = row.rows[0].index_id
    const config = mergeConfig({ kind_weights: { reports: 0.5 } })

    // The report page is the stronger lexical match (query terms in title and a
    // term-dense body), so undamped it outranks the service page.
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'rpt',
      kind: 'reports',
      title: 'Water bill assistance program annual report',
      body: 'Annual report on the water bill assistance program: assistance enrollment, water bill relief totals, and program outcomes.',
    }, config)
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'svc',
      kind: 'services',
      title: 'Water bill assistance program',
      body: 'Apply online to lower your monthly charges.',
    }, config)
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'faq',
      title: 'Water bill assistance program questions',
      body: 'Answers about the assistance program.',
    }, config)
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('request-level kindWeights replace config weights (empty override restores baseline order)', async () => {
    const response = await search('water bill assistance program', { kindWeights: {} })
    expect(ids(response)[0]).toBe('rpt')
  })

  it('config kind_weights damp a kind below an undamped competitor', async () => {
    const response = await search('water bill assistance program')
    const order = ids(response)
    expect(order.indexOf('svc')).toBeLessThan(order.indexOf('rpt'))
  })

  it('unlisted and missing kinds are neutral', async () => {
    // 'services' (unlisted) and the kindless faq doc keep their relative baseline
    // order while only 'reports' is damped.
    const baseline = ids(await search('water bill assistance program', { kindWeights: {} }))
    const damped = ids(await search('water bill assistance program'))
    const withoutRpt = (list: string[]) => list.filter(id => id !== 'rpt')
    expect(withoutRpt(damped)).toEqual(withoutRpt(baseline))
  })

  it('returns kind on results, null when the document has none', async () => {
    const response = await search('water bill assistance program')
    const byId = new Map(response.results.map(r => [r.external_id, r.kind]))
    expect(byId.get('svc')).toBe('services')
    expect(byId.get('rpt')).toBe('reports')
    expect(byId.get('faq')).toBeNull()
  })
})
