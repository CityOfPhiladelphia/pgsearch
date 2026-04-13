// ABOUTME: One-shot ingestion of Philly 311 Salesforce Knowledge articles into a pgsearch index.
// ABOUTME: Exports fetch/transform/push as pure functions so a future scheduled runner can reuse them.

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

async function main(): Promise<void> {
  const env = loadEnv()
  console.log(`[ingest-311-kb] starting`)
  console.log(`  KB source:  ${env.kbApiBase}`)
  console.log(`  pgsearch:   ${env.pgsearchApiBase}`)
  console.log(`  index:      ${INDEX_NAME}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[ingest-311-kb] failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
