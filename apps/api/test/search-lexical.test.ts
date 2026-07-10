// ABOUTME: Integration tests for the SQL-ranked lexical pass (ts_rank_cd with weighted tsvectors).
// ABOUTME: Verifies keyword relevance ordering, title-over-body weighting, and fusion compatibility.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { createIndex, getIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { hybridSearch, type HybridSearchOptions } from '../services/search'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

describe('lexical pass', () => {
  let pool: Pool
  let indexId: number
  const adapter = createTestAdapter(384)
  const config = mergeConfig({})

  const search = async (queryText: string, options: HybridSearchOptions = {}) =>
    hybridSearch(pool, (await getIndex(pool, 'tsrank-test'))!, adapter, queryText, options)

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    await createIndex(pool, { name: 'tsrank-test' })
    const row = await pool.query("SELECT index_id FROM search_indexes WHERE name = 'tsrank-test'")
    indexId = row.rows[0].index_id

    await ingestDocument(pool, indexId, adapter, {
      external_id: 'title-hit',
      title: 'Trash Collection Schedule',
      body: 'General information about city services and where to find them.',
    }, config)
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'body-hit',
      title: 'General Information',
      body: 'Trash is collected weekly. Trash trucks operate citywide. Put trash out by seven.',
    }, config)
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'no-hit',
      title: 'City Parks',
      body: 'Visit one of Philadelphia many city parks. Free admission to all parks.',
    }, config)
    // Filler matches pushing the candidate pool past the 200-row limit, ingested
    // before best-match so an unranked LIMIT would exclude it by heap order.
    for (let i = 0; i < 210; i++) {
      await ingestDocument(pool, indexId, adapter, {
        external_id: `filler-${i}`,
        title: `Department Notice ${i}`,
        body: `Notice ${i} mentions trash service updates for residents of district ${i}.`,
      }, config)
    }
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'best-match',
      title: 'Trash and Recycling Trash Day Lookup',
      body: 'Find your trash day. Trash and recycling schedules for every address, including trash holidays.',
    }, config)
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('returns keyword matches ranked in bm25 mode', async () => {
    const response = await search('trash', { mode: 'bm25' })
    const ids = response.results.map(r => r.external_id)
    expect(ids).toContain('title-hit')
    expect(ids).toContain('body-hit')
    expect(ids).not.toContain('no-hit')
  })

  it('ranks a title match above repeated body matches', async () => {
    const response = await search('trash', { mode: 'bm25' })
    const ids = response.results.map(r => r.external_id)
    expect(ids.indexOf('title-hit')).toBeLessThan(ids.indexOf('body-hit'))
  })

  it('ranks candidates before truncating: the best match survives a pool larger than the candidate limit', async () => {
    const response = await search('trash', { mode: 'bm25' })
    expect(response.results[0].external_id).toBe('best-match')
  })

  it('fuses with the vector pass in hybrid mode', async () => {
    const response = await search('trash collection', { mode: 'hybrid' })
    expect(response.results.length).toBeGreaterThan(0)
    // The keyword rank-1 can be tie-beaten only by the vector rank-1 (both score
    // 1/(k+1) and single-pass ties prefer the vector side), so top 2 at worst.
    const ids = response.results.slice(0, 2).map(r => r.external_id)
    expect(ids).toContain('title-hit')
    const scores = response.results.map(r => r.score)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  })

  it('returns no results for non-matching terms in bm25 mode', async () => {
    const response = await search('zeppelin', { mode: 'bm25' })
    expect(response.results).toEqual([])
  })

})
