// ABOUTME: DISCOVER constants, the Discoverer type re-export, and named factory exports.

export const DISCOVER = {
  SITEMAP: 'sitemap',
  ENQUEUE: 'enqueue',
} as const

export type DiscoverKey = (typeof DISCOVER)[keyof typeof DISCOVER]

export type { Discoverer } from './types'
export { createSitemapDiscoverer } from './sitemap'
export type { SitemapDiscovererOptions } from './sitemap'
export { enqueueDiscoverer } from './enqueue'
