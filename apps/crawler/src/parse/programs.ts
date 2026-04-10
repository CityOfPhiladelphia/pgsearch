// ABOUTME: Parse pipeline for phila.gov programs pages.
// ABOUTME: Targets the page title in .program header h1 and body in .program.

import {
  pipeline,
  extractMeta,
  extractTitle,
  selectContent,
  cleanWhitespace,
  toMarkdown,
} from '@phila/search-parse'

export const parseProgram = pipeline(
  extractMeta(),
  extractTitle('.program header h1'),
  selectContent('.program'),
  cleanWhitespace(),
  toMarkdown(),
)
