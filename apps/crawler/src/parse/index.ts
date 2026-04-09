// ABOUTME: Pipeline registry and URL-to-pipeline-key router for the crawler.

import type { CheerioAPI } from 'cheerio'
import type { ParsedDocument } from '@phila/search-parse'
import { parseService } from './services'

export type ParseFn = (input: string | CheerioAPI) => Promise<ParsedDocument>

export const PIPELINE = {
  SERVICES: 'services',
  PROGRAMS: 'programs',
} as const

export type PipelineKey = (typeof PIPELINE)[keyof typeof PIPELINE]

export const pipelines: Partial<Record<PipelineKey, ParseFn>> = {
  [PIPELINE.SERVICES]: parseService,
}

export function pipelineKeyFor(url: string): PipelineKey | null {
  const path = new URL(url).pathname
  if (path.startsWith('/services/')) return PIPELINE.SERVICES
  if (path.startsWith('/programs/')) return PIPELINE.PROGRAMS
  return null
}
