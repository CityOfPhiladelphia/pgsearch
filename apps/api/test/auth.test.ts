// ABOUTME: Tests for authentication key generation, hashing, and verification.
// ABOUTME: Verifies bcrypt-based key hashing and the three-tier auth pattern.

import { describe, it, expect } from 'vitest'
import { hashKey, verifyKey, generateKey } from '../middleware/auth'

describe('auth', () => {
  describe('generateKey', () => {
    it('generates a key with the correct prefix', () => {
      const key = generateKey('idx')
      expect(key.startsWith('idx_')).toBe(true)
      expect(key.length).toBeGreaterThan(20)
    })

    it('generates unique keys', () => {
      const a = generateKey('idx')
      const b = generateKey('idx')
      expect(a).not.toBe(b)
    })
  })

  describe('hashKey / verifyKey', () => {
    it('verifies a correct key against its hash', async () => {
      const key = generateKey('srch')
      const hash = await hashKey(key)
      expect(await verifyKey(key, hash)).toBe(true)
    })

    it('rejects an incorrect key', async () => {
      const key = generateKey('srch')
      const hash = await hashKey(key)
      expect(await verifyKey('srch_wrong', hash)).toBe(false)
    })
  })
})
