// ABOUTME: Text chunking for document ingestion.
// ABOUTME: Splits body text on paragraph and sentence boundaries targeting a configurable token size.

export interface ChunkOptions {
  maxTokens: number
  minTokens: number
}

export function countTokens(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  return trimmed.split(/\s+/).length
}

export function chunkText(text: string, options: ChunkOptions): string[] {
  const { maxTokens, minTokens } = options
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0)

  if (paragraphs.length === 0) return []

  const segments: string[] = []
  let current = ''

  for (const paragraph of paragraphs) {
    const paragraphTokens = countTokens(paragraph)

    if (paragraphTokens > maxTokens) {
      // Flush current segment if non-empty
      if (current.trim()) {
        segments.push(current.trim())
        current = ''
      }
      // Split long paragraph on sentence boundaries, with word-count fallback
      const sentences = splitSentences(paragraph)
      for (const sentence of sentences) {
        const pieces = countTokens(sentence) > maxTokens
          ? splitByWordCount(sentence, maxTokens)
          : [sentence]
        for (const piece of pieces) {
          if (countTokens(current + ' ' + piece) > maxTokens && current.trim()) {
            segments.push(current.trim())
            current = piece
          } else {
            current = current ? current + ' ' + piece : piece
          }
        }
      }
    } else if (countTokens(current + '\n\n' + paragraph) > maxTokens && current.trim()) {
      segments.push(current.trim())
      current = paragraph
    } else {
      current = current ? current + '\n\n' + paragraph : paragraph
    }
  }

  if (current.trim()) {
    segments.push(current.trim())
  }

  // Merge short trailing segment into previous
  if (segments.length > 1 && countTokens(segments[segments.length - 1]) < minTokens) {
    const last = segments.pop()!
    segments[segments.length - 1] += '\n\n' + last
  }

  return segments
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.?!])\s+/).filter(s => s.trim().length > 0)
}

function splitByWordCount(text: string, maxTokens: number): string[] {
  const words = text.trim().split(/\s+/)
  const chunks: string[] = []
  for (let i = 0; i < words.length; i += maxTokens) {
    chunks.push(words.slice(i, i + maxTokens).join(' '))
  }
  return chunks
}
