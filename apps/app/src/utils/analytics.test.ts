import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { analyticsEventProperties, pathAllowsAnalytics } from './analytics'

const PUBLIC_KEY = 'ab'.repeat(32)
const PRIVATE_KEY = 'cd'.repeat(32)

// A 32-byte hex value is redacted whatever the property is called. A key-name
// exemption once let a real 64-hex private key through as delegate_public_key.
test('redacts any 64-hex value, including under a public-key name', () => {
    const params = analyticsEventProperties({
        delegate_public_key: PRIVATE_KEY,
        public_key: `0x${PUBLIC_KEY}`,
        note: `seed ${PRIVATE_KEY}`,
        location: 'setup',
    })

    expect(params.delegate_public_key).toBe('[redacted]')
    expect(params.public_key).toBe('[redacted]')
    expect(params.note).toBe('[redacted]')
    expect(params.location).toBe('setup')
})

// A transaction digest is not secret, but it resolves on-chain to the sender's
// wallet, so sending one ties the analytics profile to an address. The key
// events must not carry chain ids at all.
test('delegate key events do not send the public key or a transaction digest', () => {
    // Paths are from the app directory, where vitest runs.
    for (const file of ['src/pages/SetupWizard.tsx', 'src/pages/Dashboard.tsx']) {
        const source = readFileSync(resolve(file), 'utf8')
        expect(source, file).not.toMatch(/delegate_public_key\s*:/)
        expect(source, file).not.toMatch(/transaction_digest\s*:/)
    }
})

test('the admin page never loads third-party analytics', () => {
    expect(pathAllowsAnalytics('/admin')).toBe(false)
    expect(pathAllowsAnalytics('/admin/')).toBe(false)
    expect(pathAllowsAnalytics('/administrator')).toBe(true)
    expect(pathAllowsAnalytics('/dashboard')).toBe(true)
})

test('the Statsig script is pinned by version and by integrity hash', () => {
    const source = readFileSync(resolve('src/utils/analytics.ts'), 'utf8')
    expect(source).toMatch(/js-client@\d+\.\d+\.\d+\//)
    expect(source).toMatch(/STATSIG_SCRIPT_INTEGRITY = 'sha384-[A-Za-z0-9+/]{64}'/)
    expect(source).toMatch(/script\.integrity = STATSIG_SCRIPT_INTEGRITY/)
})
