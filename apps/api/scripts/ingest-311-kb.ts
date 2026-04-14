// ABOUTME: One-shot ingestion of Philly 311 Salesforce Knowledge articles into a pgsearch index.
// ABOUTME: Exports fetch/transform/push as pure functions so a future scheduled runner can reuse them.

import { pathToFileURL } from 'node:url'
import { pipeline, cleanWhitespace, remove, toMarkdown } from '@phila/search-parse'

const REQUIRED_ENV = ['KB_API_BASE', 'KB_API_KEY', 'PGSEARCH_API_BASE', 'PGSEARCH_ADMIN_KEY'] as const
export const ARTICLE_URL_BASE = 'https://philly311.my.salesforce-sites.com/Articles/'
export const INDEX_NAME = 'knowledge-311'

export type Env = {
  kbApiBase: string
  kbApiKey: string
  pgsearchApiBase: string
  pgsearchAdminKey: string
  knowledge311IndexKey: string | undefined
}

export function loadEnv(): Env {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k])
  if (missing.length > 0) {
    console.error(`[ingest-311-kb] missing required env vars: ${missing.join(', ')}`)
    process.exit(1)
  }
  return {
    kbApiBase: process.env.KB_API_BASE!,
    kbApiKey: process.env.KB_API_KEY!,
    pgsearchApiBase: process.env.PGSEARCH_API_BASE!,
    pgsearchAdminKey: process.env.PGSEARCH_ADMIN_KEY!,
    knowledge311IndexKey: process.env.KNOWLEDGE_311_INDEX_KEY,
  }
}

export type RawArticleListItem = {
  id: string
  title: string
  lastPublishedAt: string
  url: string
}

export type RawArticle = RawArticleListItem & {
  content: string | null
}

export type ArticleListPage = {
  articles: RawArticleListItem[]
  nextLink: string | null
}

export type IngestDocument = {
  external_id: string
  title: string
  body: string
  metadata: {
    source: 'phila-311-kb'
    source_slug: string
    source_url: string
    last_published_at: string
  }
}

// NOTE: remove('table') strips tables entirely. Salesforce Knowledge articles
// use tables as formatting scaffolds, and Turndown's GFM fallback emits raw
// HTML for tables whose cells contain block-level content (lists, divs). If a
// future search-quality eval shows we're missing useful table content, revisit
// this decision — see the Known Limitations section of the plan.
const parseKbHtml = pipeline(cleanWhitespace(), remove('table'), toMarkdown())

export async function transform(raw: RawArticle): Promise<IngestDocument | null> {
  let parsed
  try {
    parsed = await parseKbHtml(raw.content ?? '')
  } catch (err) {
    console.warn(`[ingest-311-kb] parse failed for ${raw.id}:`, err instanceof Error ? err.message : err)
    return null
  }
  const body = parsed.body.trim()
  if (body.length === 0) return null
  return {
    external_id: raw.id,
    title: raw.title,
    body,
    metadata: {
      source: 'phila-311-kb',
      source_slug: raw.url,
      source_url: `${ARTICLE_URL_BASE}${raw.url}`,
      last_published_at: raw.lastPublishedAt,
    },
  }
}

// Matches RFC 8288 Link headers of the form `<url>; rel="next"` with
// double-quoted rel values — the shape Salesforce Communities emits.
const LINK_NEXT_RE = /<([^>]+)>;\s*rel="next"/

export async function fetchArticleList(
  base: string,
  apiKey: string,
  offset: number,
  limit: number,
): Promise<ArticleListPage> {
  const url = `${base}/private/key/knowledge-articles?offset=${offset}&limit=${limit}`
  const res = await fetch(url, { headers: { 'x-api-key': apiKey } })
  if (!res.ok) {
    throw new Error(`list fetch failed: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { articles: RawArticleListItem[] }
  const linkHeader = res.headers.get('link') ?? ''
  const match = LINK_NEXT_RE.exec(linkHeader)
  return { articles: body.articles, nextLink: match ? match[1] : null }
}

export async function fetchArticle(
  base: string,
  apiKey: string,
  id: string,
): Promise<RawArticle> {
  const res = await fetch(`${base}/private/key/knowledge-articles/${id}`, {
    headers: { 'x-api-key': apiKey },
  })
  if (!res.ok) {
    throw new Error(`detail fetch failed for ${id}: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as RawArticle
}

export async function* iterateArticleIds(
  base: string,
  apiKey: string,
): AsyncGenerator<RawArticleListItem> {
  let offset = 0
  const limit = 50
  while (true) {
    const page = await fetchArticleList(base, apiKey, offset, limit)
    for (const a of page.articles) yield a
    if (!page.nextLink) return
    // Parse offset from the next link, resolving relative URLs against base.
    // We don't assume fixed-stride pagination — if upstream ever changes the
    // stride, this still advances correctly.
    const nextUrl = new URL(page.nextLink, base)
    const nextOffset = Number(nextUrl.searchParams.get('offset'))
    if (!Number.isFinite(nextOffset) || nextOffset <= offset) {
      throw new Error(
        `pagination stalled at offset=${offset}, nextLink=${page.nextLink}`,
      )
    }
    offset = nextOffset
  }
}

export type IndexInfo = {
  name: string
  description?: string
  // Other fields returned by GET /private/key/admin/indexes/:name exist but
  // we don't destructure specifics — ensureIndex only needs to know the call
  // succeeded.
}

export type CreateIndexResponse = {
  name: string
  index_key: string
  search_key: string
  created_at: string
}

export type IngestResponse = {
  external_id: string
  segments: number
  changed: number
  unchanged: number
  status: 'indexed'
}

export type EnsureIndexResult =
  | { created: true; index_key: string; search_key: string }
  | { created: false }

export async function ensureIndex(
  pgsearchBase: string,
  adminKey: string,
  name: string,
): Promise<EnsureIndexResult> {
  const getRes = await fetch(`${pgsearchBase}/private/key/admin/indexes/${name}`, {
    headers: { 'x-api-key': adminKey },
  })
  if (getRes.status === 200) {
    return { created: false }
  }
  if (getRes.status !== 404) {
    throw new Error(`getIndex unexpected status ${getRes.status}: ${await getRes.text()}`)
  }
  const createRes = await fetch(`${pgsearchBase}/private/key/admin/indexes`, {
    method: 'POST',
    headers: {
      'x-api-key': adminKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name,
      description: 'Philly 311 knowledge base articles (Salesforce Knowledge export)',
      // The default `local` embedding provider is a dev-machine-only shim.
      // Deployed Lambdas bundle only the bedrock adapter, so any index
      // created with defaults gets 500 errors on every ingest. Pin to the
      // same Titan v2 config as the phila-services-programs index.
      config: {
        embedding: {
          provider: 'bedrock',
          model: 'amazon.titan-embed-text-v2:0',
          region: 'us-east-1',
          dimensions: 1024,
        },
      },
    }),
  })
  if (!createRes.ok) {
    throw new Error(`createIndex failed ${createRes.status}: ${await createRes.text()}`)
  }
  const created = (await createRes.json()) as CreateIndexResponse
  return {
    created: true,
    index_key: created.index_key,
    search_key: created.search_key,
  }
}

export async function pushDocument(
  pgsearchBase: string,
  indexName: string,
  indexKey: string,
  doc: IngestDocument,
): Promise<IngestResponse> {
  const res = await fetch(`${pgsearchBase}/public/index/${indexName}/documents`, {
    method: 'POST',
    headers: {
      'x-index-key': indexKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(doc),
  })
  if (!res.ok) {
    throw new Error(`ingest failed for ${doc.external_id} ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as IngestResponse
}

export async function refreshIndex(
  pgsearchBase: string,
  adminKey: string,
  indexName: string,
): Promise<void> {
  const res = await fetch(`${pgsearchBase}/private/key/admin/indexes/${indexName}/refresh`, {
    method: 'POST',
    headers: { 'x-api-key': adminKey },
  })
  if (!res.ok) {
    throw new Error(`refresh failed ${res.status}: ${await res.text()}`)
  }
}

async function main(): Promise<void> {
  const env = loadEnv()

  console.log(`[ingest-311-kb] ensuring index '${INDEX_NAME}' at ${env.pgsearchApiBase}`)
  const ensured = await ensureIndex(env.pgsearchApiBase, env.pgsearchAdminKey, INDEX_NAME)

  let indexKey: string
  if (ensured.created) {
    console.log(``)
    console.log(`  ================================================================`)
    console.log(`  >>> SAVE THESE KEYS — they will not be retrievable again <<<`)
    console.log(`  index_key:  ${ensured.index_key}`)
    console.log(`  search_key: ${ensured.search_key}`)
    console.log(`  ================================================================`)
    console.log(``)
    console.log(`  Paste search_key into apps/api/dev/search.html for evaluation.`)
    console.log(`  Set KNOWLEDGE_311_INDEX_KEY=${ensured.index_key} for future re-runs.`)
    console.log(``)
    indexKey = ensured.index_key
  } else {
    if (!env.knowledge311IndexKey) {
      console.error(
        `[ingest-311-kb] index '${INDEX_NAME}' already exists but KNOWLEDGE_311_INDEX_KEY is not set.`,
      )
      console.error(`[ingest-311-kb] keys are bcrypt-hashed and unretrievable; use the value from the first-run banner.`)
      process.exit(1)
    }
    indexKey = env.knowledge311IndexKey
  }

  console.log(`[ingest-311-kb] collecting article ids...`)
  const ids: RawArticleListItem[] = []
  for await (const item of iterateArticleIds(env.kbApiBase, env.kbApiKey)) {
    ids.push(item)
  }
  const total = ids.length
  console.log(`[ingest-311-kb] catalog size: ${total}`)

  let indexed = 0
  let skipped = 0
  let failed = 0
  const startedAt = Date.now()

  for (let i = 0; i < total; i++) {
    const item = ids[i]
    try {
      const raw = await fetchArticle(env.kbApiBase, env.kbApiKey, item.id)
      const doc = await transform(raw)
      if (doc === null) {
        skipped++
        console.warn(`  skip ${item.id}: empty body`)
      } else {
        await pushDocument(env.pgsearchApiBase, INDEX_NAME, indexKey, doc)
        indexed++
      }
    } catch (err) {
      failed++
      console.warn(`  skip ${item.id}: ${err instanceof Error ? err.message : err}`)
    }
    if ((i + 1) % 50 === 0) {
      console.log(`[${i + 1}/${total}] indexed=${indexed} skipped=${skipped} failed=${failed}`)
    }
  }

  console.log(`[ingest-311-kb] refreshing index`)
  try {
    await refreshIndex(env.pgsearchApiBase, env.pgsearchAdminKey, INDEX_NAME)
  } catch (err) {
    console.warn(`[ingest-311-kb] refresh failed (documents still indexed):`, err instanceof Error ? err.message : err)
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(``)
  console.log(`[ingest-311-kb] done in ${elapsedSec}s`)
  console.log(`  total:   ${total}`)
  console.log(`  indexed: ${indexed}`)
  console.log(`  skipped: ${skipped}`)
  console.log(`  failed:  ${failed}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[ingest-311-kb] failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
