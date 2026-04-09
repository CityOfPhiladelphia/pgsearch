// ABOUTME: Parse pipeline for phila.gov services pages.
// ABOUTME: Targets the page title in .entry-header h2 and body in .entry-content.

import {
  pipeline,
  extractMeta,
  extractTitle,
  selectContent,
  remove,
  cleanWhitespace,
  toMarkdown,
} from '@phila/search-parse'

export const parseService = pipeline(
  extractMeta(),
  extractTitle('.entry-header h2'),
  remove('.breadcrumbs', '.related-content'),
  selectContent('.entry-content'),
  cleanWhitespace(),
  toMarkdown(),
)
