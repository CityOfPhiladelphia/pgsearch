// ABOUTME: Vitest workspace configuration for the pgsearch monorepo.
// ABOUTME: Aggregates vitest configs from apps and packages for unified test runs.
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'apps/api/vitest.config.ts',
  'packages/*/vitest.config.ts',
])
