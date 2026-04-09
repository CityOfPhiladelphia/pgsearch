// ABOUTME: Placeholder enqueueLinks-based Discoverer; throws NotImplementedError on call.

import type { Discoverer } from './types'

export const enqueueDiscoverer: Discoverer = {
  // eslint-disable-next-line require-yield
  async *discover() {
    throw new Error(
      'NotImplementedError: enqueue-based discovery is not yet implemented. ' +
      'See docs/superpowers/specs/2026-04-09-crawler-and-local-dev-design.md.'
    )
  },
}
