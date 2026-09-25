import { analyticsEventProperties } from './analytics'

const PUBLIC_KEY = 'ab'.repeat(32)
const PRIVATE_KEY = 'cd'.repeat(32)
const DIGEST = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk'

test('keeps the delegate public key and transaction digest used to join chain activity', () => {
    const params = analyticsEventProperties({
        delegate_public_key: `0x${PUBLIC_KEY.toUpperCase()}`,
        transaction_digest: DIGEST,
        location: 'setup',
    })

    expect(params.delegate_public_key).toBe(PUBLIC_KEY)
    expect(params.transaction_digest).toBe(DIGEST)
    expect(params.location).toBe('setup')
})

test('still redacts a private key even when it is passed as a public key or digest', () => {
    const params = analyticsEventProperties({
        delegate_public_key: PRIVATE_KEY.slice(0, 63),
        transaction_digest: PRIVATE_KEY,
        note: `seed ${PRIVATE_KEY}`,
    })

    expect(params.delegate_public_key).toBe('[redacted]')
    expect(params.transaction_digest).toBe('[redacted]')
    expect(params.note).toBe('[redacted]')
})
