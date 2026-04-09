// ABOUTME: Tests for the URL-to-pipeline-key router.
// ABOUTME: Validates that paths under /services/ and /programs/ map to the correct PipelineKey.

import { describe, it, expect } from 'vitest'
import { pipelineKeyFor, PIPELINE } from '../src/parse'

describe('pipelineKeyFor', () => {
  it('routes /services/<...> to PIPELINE.SERVICES', () => {
    expect(pipelineKeyFor('https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/pay-a-water-bill/'))
      .toBe(PIPELINE.SERVICES)
  })

  it('routes /programs/<...> to PIPELINE.PROGRAMS', () => {
    expect(pipelineKeyFor('https://www.phila.gov/programs/camp-philly/'))
      .toBe(PIPELINE.PROGRAMS)
  })

  it('returns null for the site root', () => {
    expect(pipelineKeyFor('https://www.phila.gov/')).toBeNull()
  })

  it('returns null for unrelated paths', () => {
    expect(pipelineKeyFor('https://www.phila.gov/departments/')).toBeNull()
    expect(pipelineKeyFor('https://www.phila.gov/news/some-article/')).toBeNull()
  })
})
