// ABOUTME: Captures ranked search results for the golden query set in all three modes.
// ABOUTME: Writes a timestamped fixture JSON used as ground truth for before/after relevance comparison.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODES = ['hybrid', 'bm25', 'semantic'] as const
const LIMIT = 50
const REQUEST_GAP_MS = 250 // stay under the WAF rate limit (see pgsearch-by3)

interface QueryEntry {
  q: string
  category: string
}

interface CapturedResult {
  external_id: string
  score: number
  title: string
}

function loadEnv(): { apiBase: string; searchKey: string } {
  for (const candidate of ['.env.local', '../../.env.local', '../../../.env.local']) {
    const envPath = join(process.cwd(), candidate)
    if (!existsSync(envPath)) continue
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 0) continue
      const k = trimmed.slice(0, eq).trim()
      const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (!(k in process.env)) process.env[k] = v
    }
  }
  const apiBase = process.env.PGSEARCH_API_BASE
  const searchKey = process.env.SEARCH_KEY
  if (!apiBase || !searchKey) {
    console.error('[capture] missing PGSEARCH_API_BASE and/or SEARCH_KEY (set in .env.local or shell)')
    process.exit(1)
  }
  return { apiBase: apiBase.replace(/\/$/, ''), searchKey }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const indexName = process.env.EVAL_INDEX ?? 'phila-gov-en'
  const label = process.argv[2]
  const extraParams = process.argv[3] ?? ''
  if (!label) {
    console.error('[capture] usage: tsx capture.ts <label> [extraParams]   (e.g. "variant-tsrank" "lexical=tsrank")')
    process.exit(1)
  }

  const { apiBase, searchKey } = loadEnv()
  const { queries } = JSON.parse(readFileSync(join(HERE, 'queries.json'), 'utf-8')) as { queries: QueryEntry[] }

  let gitCommit = 'unknown'
  try {
    gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  } catch { /* not fatal: capture still identifies itself by label and timestamp */ }

  const captured: Array<QueryEntry & { modes: Record<string, CapturedResult[]> }> = []
  let emptyCount = 0

  for (const entry of queries) {
    const modes: Record<string, CapturedResult[]> = {}
    for (const mode of MODES) {
      const url = `${apiBase}/public/search/${indexName}?q=${encodeURIComponent(entry.q)}&limit=${LIMIT}&mode=${mode}${extraParams ? `&${extraParams}` : ''}`
      const response = await fetch(url, { headers: { 'x-search-key': searchKey } })
      if (!response.ok) {
        throw new Error(`[capture] ${mode} "${entry.q}" -> ${response.status} ${await response.text()}`)
      }
      const body = await response.json() as { results: CapturedResult[] }
      modes[mode] = body.results.map(r => ({ external_id: r.external_id, score: r.score, title: r.title }))
      await sleep(REQUEST_GAP_MS)
    }
    if (modes.hybrid.length === 0) {
      emptyCount++
      console.warn(`[capture] zero hybrid results: "${entry.q}"`)
    }
    console.log(`[capture] ${entry.q} — hybrid:${modes.hybrid.length} bm25:${modes.bm25.length} semantic:${modes.semantic.length}`)
    captured.push({ ...entry, modes })
  }

  const fixture = {
    label,
    captured_at: new Date().toISOString(),
    git_commit: gitCommit,
    api_base: apiBase,
    index: indexName,
    limit: LIMIT,
    extra_params: extraParams,
    queries: captured,
  }

  const outDir = join(HERE, 'captures')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${label}.json`)
  writeFileSync(outPath, JSON.stringify(fixture, null, 2))
  console.log(`[capture] wrote ${outPath} (${captured.length} queries, ${emptyCount} with zero hybrid results)`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
