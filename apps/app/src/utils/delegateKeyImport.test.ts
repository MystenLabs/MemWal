import { describe, expect, it } from 'vitest'
import { normalizeDelegatePrivateKey } from './delegateKeyImport'

describe('normalizeDelegatePrivateKey', () => {
    it('accepts a 64-character hex key and ignores 0x plus whitespace', () => {
        const hex = 'ab'.repeat(32)
        expect(normalizeDelegatePrivateKey(`0x${hex.slice(0, 8)} ${hex.slice(8)}`)).toBe(hex)
    })

    it('rejects anything that is not 64 hex characters', () => {
        expect(normalizeDelegatePrivateKey('')).toBeNull()
        expect(normalizeDelegatePrivateKey('zz'.repeat(32))).toBeNull()
        expect(normalizeDelegatePrivateKey('ab'.repeat(31))).toBeNull()
    })
})
