// ABOUTME: Text chunking for document ingestion.
// ABOUTME: Splits body text into token-budgeted segments, preferring coarse boundaries.

// A byte-level BPE token is at least one byte, so a text's real token count never
// exceeds its UTF-8 byte length. Estimating tokens as bytes/3 therefore bounds a
// budget of B tokens to at most 3B real tokens for any input — English, CJK, or
// base64 alike — keeping segments safely below the embedding model's hard cap.
const BYTES_PER_TOKEN = 3

// Split candidates, coarse to fine. '' is the terminal case: split between every
// character, so an unbreakable token (a long URL, a data: URI) is always reducible
// to fit the budget rather than emitted whole.
const SEPARATORS = ['\n\n', '\n', '. ', ' ', '']

export const estimateTokens = (text: string): number =>
  Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN)

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
