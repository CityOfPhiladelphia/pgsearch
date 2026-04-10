// ABOUTME: HTTP sink for posting parsed documents to the pgsearch ingest API.
// ABOUTME: Maps ParsedDocument to the ingest payload, stamps source_url and content_type.

import type { ParsedDocument } from '@phila/search-parse'
import type { PipelineKey } from '../parse'

export interface SinkConfig {
  endpoint: string
  indexName: string
  indexKey: string
}

export class SinkError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function postDocument(
  config: SinkConfig,
  doc: ParsedDocument,
  sourceUrl: string,
  contentType: PipelineKey,
): Promise<void> {
  const payload = {
    external_id: sourceUrl,
    title: doc.title,
    body: doc.body,
    metadata: {
      ...doc.metadata,
      content_type: contentType,
      source_url: sourceUrl,
    },
  }

  const url = `${config.endpoint.replace(/\/$/, '')}/public/index/${encodeURIComponent(config.indexName)}/documents`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-index-key': config.indexKey,
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new SinkError(res.status, `${res.status} ${res.statusText}: ${body}`)
  }
}
