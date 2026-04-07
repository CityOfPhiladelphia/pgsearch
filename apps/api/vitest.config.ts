// ABOUTME: Vitest configuration for the api application.
// ABOUTME: Targets test files under test/ with a setup file and extended timeout for integration tests.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 30000,
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
  },
})
