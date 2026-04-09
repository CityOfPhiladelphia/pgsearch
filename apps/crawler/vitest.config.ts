// ABOUTME: Vitest configuration for the search-crawler package.
// ABOUTME: Targets test files under the test/ directory.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
