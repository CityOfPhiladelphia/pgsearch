// ABOUTME: Discoverer interface — yields URLs to crawl as an async iterable.

export interface Discoverer {
  discover(): AsyncIterable<URL>
}
