// ABOUTME: Text chunking for document ingestion.
// ABOUTME: Splits body text into token-budgeted segments, preferring coarse boundaries.

// Conservative chars-per-token: real English averages ~4, so dividing by 3
// over-counts tokens and skews segments smaller — headroom below the embedding
// model's hard input limit, which sits far above any sane per-segment budget.
const CHARS_PER_TOKEN = 3

// Split candidates, coarse to fine. '' is the terminal case: split between every
// character, so an unbreakable token (a long URL, a data: URI) is always reducible
// to fit the budget rather than emitted whole.
const SEPARATORS = ['\n\n', '\n', '. ', ' ', '']

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

// Whitespace word count, used for BM25 length normalization — not for chunk sizing.
export function wordCount(text: string): number {
  const trimmed = text.trim()
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length
}

export function chunkText(text: string, maxTokens: number): string[] {
  return pack(splitToFit(text, maxTokens, SEPARATORS), maxTokens)
}

// Break text into atoms that each fit the budget. Separators stay attached to
// their piece, so the atoms concatenate back into the original text losslessly.
function splitToFit(text: string, maxTokens: number, separators: string[]): string[] {
  if (estimateTokens(text) <= maxTokens) return text ? [text] : []
  const [separator, ...rest] = separators
  return splitOn(text, separator).flatMap((piece) =>
    !piece
      ? []
      : estimateTokens(piece) <= maxTokens
        ? [piece]
        : splitToFit(piece, maxTokens, rest.length ? rest : ['']),
  )
}

// Split on the separator while keeping it attached to the preceding piece.
function splitOn(text: string, separator: string): string[] {
  if (separator === '') return [...text]
  return text.split(new RegExp(`(?<=${escapeRegExp(separator)})`))
}

// Greedily concatenate adjacent atoms up to the budget.
function pack(atoms: string[], maxTokens: number): string[] {
  const segments: string[] = []
  let current = ''
  for (const atom of atoms) {
    if (current && estimateTokens(current + atom) > maxTokens) {
      if (current.trim()) segments.push(current.trim())
      current = atom
    } else {
      current += atom
    }
  }
  if (current.trim()) segments.push(current.trim())
  return segments
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
