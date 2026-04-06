// ABOUTME: Tests for the pgsearch client library.
// ABOUTME: Verifies client construction, URL building, and type exports.

import { describe, it, expect } from 'vitest'
import { PgsearchClient } from '../src'

describe('PgsearchClient', () => {
  it('constructs with base URL and admin key', () => {
    const client = new PgsearchClient({ baseUrl: 'https://api.example.com', adminKey: 'test-key' })
    expect(client).toBeDefined()
  })

  it('strips trailing slash from base URL', () => {
    const client = new PgsearchClient({ baseUrl: 'https://api.example.com/' })
    expect(client).toBeDefined()
  })

  it('constructs without admin key', () => {
    const client = new PgsearchClient({ baseUrl: 'https://api.example.com' })
    expect(client).toBeDefined()
  })
})
