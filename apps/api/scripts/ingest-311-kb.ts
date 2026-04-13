// ABOUTME: One-shot ingestion of Philly 311 Salesforce Knowledge articles into a pgsearch index.
// ABOUTME: Exports fetch/transform/push as pure functions so a future scheduled runner can reuse them.

import { pathToFileURL } from 'node:url'

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
  content: string
}

export type ArticleListPage = {
  articles: RawArticleListItem[]
  nextLink: string | null
}

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
    // Parse offset from the next link to avoid assuming fixed-stride pagination.
    const nextOffset = Number(new URL(page.nextLink).searchParams.get('offset'))
    if (!Number.isFinite(nextOffset) || nextOffset <= offset) return
    offset = nextOffset
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
