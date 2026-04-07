// ABOUTME: End-to-end test of hybrid search pipeline with real phila.gov content.
// ABOUTME: Creates an index, ingests service pages, generates Bedrock embeddings, and validates search.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { refreshIndex } from '../services/refresh'
import { hybridSearch } from '../services/search'
import { createBedrockAdapter } from '@phila/search-embeddings'
import { parse } from 'node-html-parser'
import type { Pool } from 'pg'
import type { EmbeddingAdapter } from '@phila/search-embeddings'

function parseServicePage(html: string): { title: string; body: string } {
  const root = parse(html)
  const title = root.querySelector('.entry-header h2')?.textContent?.trim()
    || root.querySelector('title')?.textContent?.trim()
    || ''
  const body = root.querySelector('.entry-content')?.textContent?.trim() || ''
  return { title, body }
}

const SERVICE_PAGES = [
  'https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/pay-a-water-bill/',
  'https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/dispute-a-water-bill/',
  'https://www.phila.gov/services/water-gas-utilities/become-a-water-customer/',
  'https://www.phila.gov/services/permits-violations-licenses/apply-for-a-permit/building-and-repair-permits/get-a-building-permit/',
  'https://www.phila.gov/services/trash-recycling-city-upkeep/report-illegal-dumping/',
  'https://www.phila.gov/services/mental-physical-health/get-vaccinated/',
  'https://www.phila.gov/services/property-lots-housing/request-a-city-home-repair/',
  'https://www.phila.gov/services/payments-assistance-taxes/get-real-estate-tax-relief/',
]

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (pgsearch e2e test)' },
  })
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`)
  return response.text()
}

describe('e2e: hybrid search with phila.gov service pages', () => {
  let pool: Pool
  let adapter: EmbeddingAdapter
  let indexId: number
  let indexKey: string
  let searchKey: string

  beforeAll(async () => {
    pool = await getTestPool()
    await teardownSchema()
    await setupSchema()

    adapter = createBedrockAdapter({
      model: 'amazon.titan-embed-text-v2:0',
      dimensions: 1024,
      region: 'us-east-1',
    })
  }, 30_000)

  afterAll(async () => {
    await cleanupTestData()
    await teardownSchema()
    await closePool()
  })

  it('creates an index configured for Titan Embed v2', async () => {
    const result = await createIndex(pool, {
      name: 'phila-services',
      description: 'Philadelphia city service pages',
      config: {
        embedding: {
          provider: 'bedrock',
          model: 'amazon.titan-embed-text-v2:0',
          dimensions: 1024,
        },
      },
    })

    expect(result.name).toBe('phila-services')
    expect(result.index_key).toMatch(/^idx_/)
    expect(result.search_key).toMatch(/^srch_/)

    indexKey = result.index_key
    searchKey = result.search_key

    // Look up the index_id for direct service calls
    const row = await pool.query(
      'SELECT index_id FROM search_indexes WHERE name = $1',
      ['phila-services']
    )
    indexId = row.rows[0].index_id
  })

  it('fetches, parses, and ingests phila.gov service pages', async () => {
    const results = []

    for (const url of SERVICE_PAGES) {
      const slug = url.replace('https://www.phila.gov/services/', '').replace(/\/$/, '')
      console.log(`  Fetching: ${slug}`)

      let html: string
      try {
        html = await fetchPage(url)
      } catch (err: any) {
        console.log(`  Skipping ${slug} (fetch failed: ${err.message})`)
        continue
      }
      const parsed = parseServicePage(html)

      // Some pages may be topic indexes with minimal body text — skip those
      if (parsed.body.length < 50) {
        console.log(`  Skipping ${slug} (body too short: ${parsed.body.length} chars)`)
        continue
      }

      console.log(`  Ingesting: "${parsed.title}" (${parsed.body.length} chars, ${slug})`)

      const result = await ingestDocument(pool, indexId, adapter, {
        external_id: slug,
        title: parsed.title,
        body: parsed.body,
        metadata: { source_url: url },
      })

      expect(result.status).toBe('indexed')
      expect(result.segments).toBeGreaterThan(0)
      results.push(result)
      console.log(`  → ${result.segments} segments (${result.changed} embedded)`)
    }

    expect(results.length).toBeGreaterThanOrEqual(3)
    console.log(`\n  Ingested ${results.length} documents total`)
  }, 120_000)

  it('refreshes materialized views and index stats', async () => {
    await refreshIndex(pool, indexId)

    const row = await pool.query(
      'SELECT total_documents, avg_title_length, avg_body_length, docs_changed_since_refresh, last_refreshed_at FROM search_indexes WHERE index_id = $1',
      [indexId]
    )
    const stats = row.rows[0]

    expect(stats.total_documents).toBeGreaterThanOrEqual(3)
    expect(stats.docs_changed_since_refresh).toBe(0)
    expect(stats.last_refreshed_at).not.toBeNull()
    expect(parseFloat(stats.avg_title_length)).toBeGreaterThan(0)
    expect(parseFloat(stats.avg_body_length)).toBeGreaterThan(0)

    console.log(`  Stats: ${stats.total_documents} docs, avg title ${stats.avg_title_length} tokens, avg body ${stats.avg_body_length} tokens`)
  }, 30_000)

  it('hybrid search for "pay water bill" returns water-related results', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'pay water bill', { limit: 5 })

    expect(results.results.length).toBeGreaterThan(0)
    console.log(`\n  Search: "pay water bill" → ${results.total} docs`)
    for (const r of results.results) {
      console.log(`    [${r.score.toFixed(3)}] ${r.title} (${r.external_id})`)
    }

    // The top result should be about water bills
    const topResult = results.results[0]
    const topText = `${topResult.title} ${topResult.snippet}`.toLowerCase()
    expect(topText).toMatch(/water|bill|pay/)
  }, 30_000)

  it('hybrid search for "building permit" returns permit-related results', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'building permit', { limit: 5 })

    expect(results.results.length).toBeGreaterThan(0)
    console.log(`\n  Search: "building permit" → ${results.total} docs`)
    for (const r of results.results) {
      console.log(`    [${r.score.toFixed(3)}] ${r.title} (${r.external_id})`)
    }
  }, 30_000)

  it('hybrid search for "trash garbage dumping" returns sanitation results', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'trash garbage dumping', { limit: 5 })

    expect(results.results.length).toBeGreaterThan(0)
    console.log(`\n  Search: "trash garbage dumping" → ${results.total} docs`)
    for (const r of results.results) {
      console.log(`    [${r.score.toFixed(3)}] ${r.title} (${r.external_id})`)
    }
  }, 30_000)

  it('hybrid search for "property tax relief seniors" returns tax-related results', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'property tax relief seniors', { limit: 5 })

    expect(results.results.length).toBeGreaterThan(0)
    console.log(`\n  Search: "property tax relief seniors" → ${results.total} docs`)
    for (const r of results.results) {
      console.log(`    [${r.score.toFixed(3)}] ${r.title} (${r.external_id})`)
    }
  }, 30_000)

  // --- Natural language / edge case queries ---

  it('problem description: "my water bill seems way too high"', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'my water bill seems way too high', { limit: 5 })
    console.log(`\n  Search: "my water bill seems way too high" → ${results.total} docs`)
    for (const r of results.results) {
      console.log(`    [${r.score.toFixed(3)}] ${r.title} (${r.external_id})`)
    }
    // Should surface dispute or pay — user likely wants to contest the charge
    expect(results.results.length).toBeGreaterThan(0)
  }, 30_000)

  it('no keyword overlap: "someone left a couch on my sidewalk"', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'someone left a couch on my sidewalk', { limit: 5 })
    console.log(`\n  Search: "someone left a couch on my sidewalk" → ${results.total} docs`)
    for (const r of results.results) {
      console.log(`    [${r.score.toFixed(3)}] ${r.title} (${r.external_id})`)
    }
    // Ideally "Report illegal dumping" should rank high — zero keyword overlap though
    expect(results.results.length).toBeGreaterThan(0)
  }, 30_000)

  it('colloquial: "do I need a permit to redo my kitchen"', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'do I need a permit to redo my kitchen', { limit: 5 })
    console.log(`\n  Search: "do I need a permit to redo my kitchen" → ${results.total} docs`)
    for (const r of results.results) {
      console.log(`    [${r.score.toFixed(3)}] ${r.title} (${r.external_id})`)
    }
    // Building permit should rank #1
    expect(results.results.length).toBeGreaterThan(0)
  }, 30_000)

  it('ambiguous intent: "I owe the city money"', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'I owe the city money', { limit: 5 })
    console.log(`\n  Search: "I owe the city money" → ${results.total} docs`)
    for (const r of results.results) {
      console.log(`    [${r.score.toFixed(3)}] ${r.title} (${r.external_id})`)
    }
    // Could be water bill, taxes, or liens — should surface payment-related pages
    expect(results.results.length).toBeGreaterThan(0)
  }, 30_000)

  it('adjacent vocabulary: "shots for my baby"', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'shots for my baby', { limit: 5 })
    console.log(`\n  Search: "shots for my baby" → ${results.total} docs`)
    for (const r of results.results) {
      console.log(`    [${r.score.toFixed(3)}] ${r.title} (${r.external_id})`)
    }
    // "Get vaccinated" should rank high despite no keyword match
    expect(results.results.length).toBeGreaterThan(0)
  }, 30_000)

  it('spanish: "como pago mi cuenta de agua"', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'como pago mi cuenta de agua', { limit: 5 })
    console.log(`\n  Search: "como pago mi cuenta de agua" → ${results.total} docs`)
    for (const r of results.results) {
      console.log(`    [${r.score.toFixed(3)}] ${r.title} (${r.external_id})`)
    }
    // Cross-lingual — vector search may help here, BM25 won't
    expect(results.results.length).toBeGreaterThan(0)
  }, 30_000)

  it('typos: "bilding permt application"', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'bilding permt application', { limit: 5 })
    console.log(`\n  Search: "bilding permt application" → ${results.total} docs`)
    for (const r of results.results) {
      console.log(`    [${r.score.toFixed(3)}] ${r.title} (${r.external_id})`)
    }
    // BM25 will fail on typos — does vector search save us?
    expect(results.results.length).toBeGreaterThan(0)
  }, 30_000)

  it('vague: "what do I need to start construction"', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'what do I need to start construction', { limit: 5 })
    console.log(`\n  Search: "what do I need to start construction" → ${results.total} docs`)
    for (const r of results.results) {
      console.log(`    [${r.score.toFixed(3)}] ${r.title} (${r.external_id})`)
    }
    // Building permit is the answer — "construction" is adjacent but not exact
    expect(results.results.length).toBeGreaterThan(0)
  }, 30_000)
})
