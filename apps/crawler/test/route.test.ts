// ABOUTME: Tests for the URL-to-pipeline-key router.
// ABOUTME: Validates path-prefix and segment-count rules for services and programs leaves.

import { describe, it, expect } from 'vitest'
import { pipelineKeyFor, PIPELINE } from '../src/parse'

describe('pipelineKeyFor', () => {
  it('routes /services/<category>/<leaf>/ to PIPELINE.SERVICES', () => {
    expect(pipelineKeyFor('https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/pay-a-water-bill/'))
      .toBe(PIPELINE.SERVICES)
    expect(pipelineKeyFor('https://www.phila.gov/services/birth-marriage-life-events/get-a-marriage-license/'))
      .toBe(PIPELINE.SERVICES)
  })

  it('routes /programs/<leaf>/ to PIPELINE.PROGRAMS', () => {
    expect(pipelineKeyFor('https://www.phila.gov/programs/camp-philly/'))
      .toBe(PIPELINE.PROGRAMS)
  })

  it('returns null for the services category root', () => {
    expect(pipelineKeyFor('https://www.phila.gov/services/')).toBeNull()
  })

  it('returns null for services intermediate category pages', () => {
    expect(pipelineKeyFor('https://www.phila.gov/services/water-gas-utilities/')).toBeNull()
  })

  it('returns null for the programs category root', () => {
    expect(pipelineKeyFor('https://www.phila.gov/programs/')).toBeNull()
  })

  it('returns null for the site root', () => {
    expect(pipelineKeyFor('https://www.phila.gov/')).toBeNull()
  })

  it('returns null for unrelated paths', () => {
    expect(pipelineKeyFor('https://www.phila.gov/departments/')).toBeNull()
    expect(pipelineKeyFor('https://www.phila.gov/news/some-article/')).toBeNull()
  })

  it('returns null for malformed URLs', () => {
    expect(pipelineKeyFor('not-a-url')).toBeNull()
  })
})
