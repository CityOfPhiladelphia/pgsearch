// ABOUTME: Compares two eval capture fixtures with overlap@k and Spearman rank correlation.
// ABOUTME: Reports per-category and overall agreement per mode, flagging the most divergent queries.

import { readFileSync } from 'node:fs'
import { overlapAtK, spearmanShared } from './metrics'

const K = 10

interface Capture {
  label: string
  queries: Array<{
    q: string
    category: string
    modes: Record<string, Array<{ external_id: string }>>
  }>
}

interface QueryMetrics {
  q: string
  category: string
  mode: string
  overlap: number | null
  rho: number | null
}

function load(path: string): Capture {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

const fmt = (value: number | null): string => (value == null ? '  n/a' : value.toFixed(2).padStart(5))

function mean(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v != null)
  if (present.length === 0) return null
  return present.reduce((sum, v) => sum + v, 0) / present.length
}

function main(): void {
  const [pathA, pathB] = process.argv.slice(2)
  if (!pathA || !pathB) {
    console.error('[compare] usage: tsx compare.ts <captureA.json> <captureB.json>')
    process.exit(1)
  }

  const a = load(pathA)
  const b = load(pathB)
  const byQuery = new Map(b.queries.map(entry => [entry.q, entry]))

  const rows: QueryMetrics[] = []
  for (const entryA of a.queries) {
    const entryB = byQuery.get(entryA.q)
    if (!entryB) {
      console.warn(`[compare] query missing from ${b.label}: "${entryA.q}"`)
      continue
    }
    for (const mode of Object.keys(entryA.modes)) {
      const idsA = entryA.modes[mode].map(r => r.external_id)
      const idsB = (entryB.modes[mode] ?? []).map(r => r.external_id)
      rows.push({
        q: entryA.q,
        category: entryA.category,
        mode,
        overlap: overlapAtK(idsA, idsB, K),
        rho: spearmanShared(idsA, idsB),
      })
    }
  }

  console.log(`\ncomparing: ${a.label}  vs  ${b.label}   (overlap@${K} / spearman rho on shared)\n`)

  const modes = [...new Set(rows.map(r => r.mode))]
  const categories = [...new Set(rows.map(r => r.category))]

  const header = ['category'.padEnd(18), ...modes.map(m => `${m} ovl   rho`.padStart(20))].join('')
  console.log(header)
  for (const category of [...categories, null]) {
    const inCategory = category ? rows.filter(r => r.category === category) : rows
    const cells = modes.map(mode => {
      const inMode = inCategory.filter(r => r.mode === mode)
      return `${fmt(mean(inMode.map(r => r.overlap)))} ${fmt(mean(inMode.map(r => r.rho)))}`.padStart(20)
    })
    console.log([(category ?? 'ALL').padEnd(18), ...cells].join(''))
  }

  const divergent = rows
    .filter(r => r.overlap != null && r.overlap < 0.7)
    .sort((x, y) => (x.overlap ?? 0) - (y.overlap ?? 0))
    .slice(0, 15)
  if (divergent.length > 0) {
    console.log(`\nmost divergent (overlap@${K} < 0.7) — eyeball these, divergence may be a bug being fixed:`)
    for (const row of divergent) {
      console.log(`  ${fmt(row.overlap)}  ${row.mode.padEnd(9)} ${row.q}`)
    }
  }
}

main()
