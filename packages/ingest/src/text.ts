// ABOUTME: Parses plain text into structured documents for search ingestion.
// ABOUTME: Extracts title from first line or uses provided title override.

interface ParseTextOptions {
  title?: string
  metadata?: Record<string, unknown>
}

interface ParsedDocument {
  title: string
  body: string
  metadata?: Record<string, unknown>
}

export function parseText(text: string, options?: ParseTextOptions): ParsedDocument {
  if (options?.title) {
    return { title: options.title, body: text, metadata: options?.metadata }
  }

  const firstBreak = text.indexOf('\n\n')
  if (firstBreak === -1) {
    return { title: text.trim(), body: '', metadata: options?.metadata }
  }

  return {
    title: text.substring(0, firstBreak).trim(),
    body: text.substring(firstBreak + 2).trim(),
    metadata: options?.metadata,
  }
}
