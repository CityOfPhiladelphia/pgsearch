// ABOUTME: Public exports for the @phila/search-parse package.
// ABOUTME: Exports pipeline runner, built-in transforms, and core types.

export { pipeline } from './pipeline'
export type { Transform, ParseContext, ParsedDocument } from './pipeline'
export { extractMeta } from './transforms/extract-meta'
export type { ExtractMetaOptions } from './transforms/extract-meta'
export { extractTitle } from './transforms/extract-title'
export type { ExtractTitleOptions } from './transforms/extract-title'
export { selectContent } from './transforms/select-content'
export type { SelectContentOptions } from './transforms/select-content'
export { remove } from './transforms/remove'
export { unwrap } from './transforms/unwrap'
export { cleanWhitespace } from './transforms/clean-whitespace'
export { toMarkdown } from './transforms/to-markdown'
export { injectIntoBody } from './transforms/inject-into-body'
export type { InjectIntoBodyOptions } from './transforms/inject-into-body'
