// ABOUTME: One-time helper that creates the dev search index and prints its keys.
// ABOUTME: Idempotent — if the index already exists, prints a notice and exits 0 unless --force is set.

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000'
const INDEX_NAME = process.env.INDEX_NAME ?? 'phila-services-programs'
const FORCE = process.argv.includes('--force')

async function main(): Promise<void> {
  const existing = await fetch(`${API_BASE}/private/key/admin/indexes/${INDEX_NAME}`)
  if (existing.status === 200) {
    if (!FORCE) {
      console.log(`[bootstrap] index '${INDEX_NAME}' already exists at ${API_BASE}.`)
      console.log(`[bootstrap] keys cannot be retrieved after creation. Pass --force to drop and recreate.`)
      return
    }
    console.log(`[bootstrap] --force set; deleting existing index '${INDEX_NAME}'`)
    const del = await fetch(`${API_BASE}/private/key/admin/indexes/${INDEX_NAME}`, { method: 'DELETE' })
    if (!del.ok) {
      throw new Error(`delete failed: ${del.status} ${await del.text()}`)
    }
  } else if (existing.status !== 404) {
    throw new Error(`unexpected status checking index existence: ${existing.status} ${await existing.text()}`)
  }

  const create = await fetch(`${API_BASE}/private/key/admin/indexes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: INDEX_NAME,
      description: 'phila.gov services and programs (dev)',
    }),
  })
  if (!create.ok) {
    throw new Error(`create failed: ${create.status} ${await create.text()}`)
  }
  const result = await create.json() as { name: string; index_key: string; search_key: string; created_at: string }

  console.log(`[bootstrap] created index '${result.name}'`)
  console.log(``)
  console.log(`  index_key:  ${result.index_key}`)
  console.log(`  search_key: ${result.search_key}`)
  console.log(``)
  console.log(`Set INDEX_KEY in your shell for the crawler:`)
  console.log(`  export INDEX_KEY=${result.index_key}`)
  console.log(``)
  console.log(`Paste search_key into the test-drive page (apps/api/dev/search.html):`)
  console.log(`  ${result.search_key}`)
}

main().catch((err) => {
  console.error('[bootstrap] failed:', err.message)
  process.exit(1)
})
