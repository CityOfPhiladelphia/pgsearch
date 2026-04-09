// ABOUTME: Parse pipeline for phila.gov services pages.
// ABOUTME: Targets the WordPress entry-content template (.entry-header h2 + .entry-content).

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
