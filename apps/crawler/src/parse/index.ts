// ABOUTME: Pipeline registry and URL-to-pipeline-key router for the crawler.
// ABOUTME: pipelineKeyFor returns a PIPELINE key for /services/ leaves (>=3 path segments) and /programs/ leaves (exactly 2), or null.

import type { CheerioAPI } from 'cheerio'
import type { ParsedDocument } from '@phila/search-parse'
import { parseService } from './services'
import { parseProgram } from './programs'

export type ParseFn = (input: string | CheerioAPI) => Promise<ParsedDocument>

export const PIPELINE = {
  SERVICES: 'services',
  PROGRAMS: 'programs',
} as const

export type PipelineKey = (typeof PIPELINE)[keyof typeof PIPELINE]

export const pipelines: Record<PipelineKey, ParseFn> = {
  [PIPELINE.SERVICES]: parseService,
  [PIPELINE.PROGRAMS]: parseProgram,
}

export function pipelineKeyFor(url: string): PipelineKey | null {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return null
  }
  const segments = path.split('/').filter(Boolean)
  if (segments[0] === 'services' && segments.length >= 3) return PIPELINE.SERVICES
  if (segments[0] === 'programs' && segments.length === 2) return PIPELINE.PROGRAMS
  return null
}
