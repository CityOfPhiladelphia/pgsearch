// ABOUTME: RAG pipeline orchestration — retrieve, render context, call LLM, parse citations.
// ABOUTME: Pure orchestration. No HTTP. No direct DB queries beyond delegating to hybridSearch.

import type { Pool } from 'pg'
import type { EmbeddingAdapter } from '@phila/search-embeddings'
import type { LlmAdapter } from '@phila/llm'
import { hybridSearch } from './search'
import type { PromptContent, RagResponse, Citation, RetrievedRef } from '../types'

export interface RunRagInput {
  promptName: string
  promptContent: PromptContent
  question: string
  messages?: { role: 'user' | 'assistant'; content: string }[]
}

export async function runRag(
  pool: Pool,
  indexId: number,
  embedAdapter: EmbeddingAdapter,
  llmAdapter: LlmAdapter,
  input: RunRagInput,
): Promise<RagResponse> {
  const { promptName, promptContent, question } = input
  const messages = input.messages ?? []

  const searchResponse = await hybridSearch(pool, indexId, embedAdapter, question, {
    mode: promptContent.retrieval.mode,
    limit: promptContent.retrieval.limit,
    maxChunksPerDoc: promptContent.retrieval.max_chunks_per_doc,
    minBm25Score: promptContent.retrieval.min_bm25_score,
    minVectorScore: promptContent.retrieval.min_vector_score,
  })

  const chunks = searchResponse.results

  const contextBlock = chunks
    .map((c, i) => `Source [${i + 1}]: ${c.title}\n${c.snippet}`)
    .join('\n\n')

  const finalUserContent =
    `${contextBlock}\n\n${promptContent.response_format}\n\nQuestion: ${question}`

  const llmMessages = [
    ...messages,
    { role: 'user' as const, content: finalUserContent },
  ]

  const completion = await llmAdapter.complete({
    system: promptContent.system,
    messages: llmMessages,
    max_tokens: promptContent.max_tokens,
    temperature: promptContent.temperature,
  })

  // Parse [N] markers from the answer; keep only unique, in-range, sorted.
  // Strip "Source [N]:" labels because a real model that quotes the context format
  // back ("According to Source [1]:...") would otherwise produce a false citation hit.
  const answerForCitationScan = completion.text.replace(/Source \[\d+\]:/g, 'Source:')
  const markerSet = new Set<number>()
  for (const match of answerForCitationScan.matchAll(/\[(\d+)\]/g)) {
    const n = parseInt(match[1], 10)
    if (n >= 1 && n <= chunks.length) markerSet.add(n)
  }
  const markers = Array.from(markerSet).sort((a, b) => a - b)

  const citations: Citation[] = markers.map(marker => {
    const chunk = chunks[marker - 1]
    return {
      marker,
      external_id: chunk.external_id,
      title: chunk.title,
      url: typeof chunk.metadata?.source_url === 'string' ? chunk.metadata.source_url : '',
      snippet: chunk.snippet,
    }
  })

  // Collapse retrieved to one entry per document so `used` is unambiguous.
  // With max_chunks_per_doc > 1, multiple chunks share an external_id; the
  // response shape has no chunk-level identifier, so chunk-level `used` would
  // be misleading (both siblings flagged the same regardless of which was cited).
  const usedExternalIds = new Set(citations.map(c => c.external_id))
  const bestPerDoc = new Map<string, RetrievedRef>()
  for (const c of chunks) {
    const existing = bestPerDoc.get(c.external_id)
    if (!existing || c.score > existing.score) {
      bestPerDoc.set(c.external_id, {
        external_id: c.external_id,
        score: c.score,
        used: usedExternalIds.has(c.external_id),
      })
    }
  }
  const retrieved = Array.from(bestPerDoc.values())

  return {
    answer: completion.text,
    citations,
    retrieved,
    model: completion.model,
    prompt: promptName,
    usage: completion.usage,
    history_sig: null,
  }
}
