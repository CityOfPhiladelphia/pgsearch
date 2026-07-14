// ABOUTME: Tests for the kinds filter — restricting search to listed document kinds.
// ABOUTME: Filtering happens in SQL in both passes so membership, not just ordering, respects the filter.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { createIndex, getIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { hybridSearch, type HybridSearchOptions } from '../services/search'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

describe('kinds filter', () => {
  let pool: Pool
  const adapter = createTestAdapter(384)

  const search = async (queryText: string, options: HybridSearchOptions = {}) =>
    hybridSearch(pool, (await getIndex(pool, 'kinds-test'))!, adapter, queryText, options)

  const ids = (response: { results: { external_id: string }[] }) => response.results.map(r => r.external_id)

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    await createIndex(pool, { name: 'kinds-test', config: { embedding: { dimensions: 384 } as any } })
    const row = await pool.query("SELECT index_id FROM search_indexes WHERE name = 'kinds-test'")
    const indexId = row.rows[0].index_id
    const config = mergeConfig({})

    await ingestDocument(pool, indexId, adapter, {
      external_id: 'svc', kind: 'services',
      title: 'Water bill assistance', body: 'Apply for water bill help.',
    }, config)
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'post', kind: 'posts',
      title: 'Water bill assistance expands', body: 'The water bill program grows.',
    }, config)
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'kindless',
      title: 'Water bill questions', body: 'Answers about water bills.',
    }, config)
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('returns only the listed kind in every mode', async () => {
    for (const mode of ['hybrid', 'lexical', 'semantic'] as const) {
      const got = ids(await search('water bill', { mode, kinds: ['posts'] }))
      expect(got, mode).toEqual(['post'])
    }
  })

  it('accepts multiple kinds', async () => {
    const got = ids(await search('water bill', { kinds: ['posts', 'services'] }))
    expect(new Set(got)).toEqual(new Set(['post', 'svc']))
  })

  it('excludes kindless documents when a filter is present', async () => {
    const got = ids(await search('water bill', { kinds: ['services'] }))
    expect(got).not.toContain('kindless')
  })

  it('no filter returns everything', async () => {
    const got = ids(await search('water bill'))
    expect(new Set(got)).toEqual(new Set(['svc', 'post', 'kindless']))
  })
})
