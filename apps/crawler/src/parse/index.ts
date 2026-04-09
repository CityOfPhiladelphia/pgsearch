// ABOUTME: Routes URLs to their content-type pipeline by path prefix.

export const PIPELINE = {
  SERVICES: 'services',
  PROGRAMS: 'programs',
} as const

export type PipelineKey = (typeof PIPELINE)[keyof typeof PIPELINE]

export function pipelineKeyFor(url: string): PipelineKey | null {
  const path = new URL(url).pathname
  if (path.startsWith('/services/')) return PIPELINE.SERVICES
  if (path.startsWith('/programs/')) return PIPELINE.PROGRAMS
  return null
}
