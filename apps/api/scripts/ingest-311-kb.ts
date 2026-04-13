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
  console.log(`[ingest-311-kb] walking article catalog...`)
  let count = 0
  for await (const item of iterateArticleIds(env.kbApiBase, env.kbApiKey)) {
    void item
    count++
    if (count % 50 === 0) console.log(`  ...${count}`)
  }
  console.log(`[ingest-311-kb] total articles: ${count}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[ingest-311-kb] failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
