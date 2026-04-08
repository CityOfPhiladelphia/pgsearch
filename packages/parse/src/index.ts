// ABOUTME: Public exports for the @phila/search-parse package.
// ABOUTME: Exports pipeline runner, built-in transforms, and core types.

export { pipeline } from './pipeline'
export type { Transform, ParseContext, ParsedDocument } from './pipeline'
export { extractMeta } from './transforms/extract-meta'
export type { ExtractMetaOptions } from './transforms/extract-meta'
export { extractTitle } from './transforms/extract-title'
export type { ExtractTitleOptions } from './transforms/extract-title'
