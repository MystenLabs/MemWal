import { describe, expect, it } from 'vitest'
import { accountReadyCopy } from './accountReadyCopy'

describe('accountReadyCopy', () => {
    it('names the minted key and points at Connected agents', () => {
        expect(accountReadyCopy({ kind: 'mint', label: 'cli' })).toEqual({
            title: '"cli" is ready',
            description: 'Head back to Walrus Console. It will show up under Connected agents.',
        })
    })

    it('counts the removed keys', () => {
        expect(accountReadyCopy({ kind: 'revoke', count: 1 }).title).toBe('Key removed')
        expect(accountReadyCopy({ kind: 'revoke', count: 3 }).title).toBe('3 keys removed')
        expect(accountReadyCopy({ kind: 'revoke', count: 3 }).description).toBe(
            'Head back to Walrus Console to see the change.',
        )
    })

    it('keeps the new-account copy for a Set up arrival', () => {
        expect(accountReadyCopy(null)).toEqual({
            title: 'Your account is ready',
            description: 'Finish connecting your account in Walrus Console.',
        })
    })
})
