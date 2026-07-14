import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    create: vi.fn(), readBlob: vi.fn(), decrypt: vi.fn(), build: vi.fn(),
    computeBlobMetadata: vi.fn(),
}))
const config = vi.hoisted(() => ({ suiNetwork: 'testnet' as const, memwalPackageId: '0x1', legacyMemwalPackageId: '0x1', sealKeyServers: [] as string[], legacySealKeyServers: [] as string[], walrusAggregatorUrl: '' }))
vi.mock('../config', () => ({ config }))
vi.mock('./walrusBlobs', () => ({ getWalrusClient: () => ({ readBlob: mocks.readBlob, computeBlobMetadata: mocks.computeBlobMetadata }) }))
vi.mock('@mysten/sui/transactions', () => ({ Transaction: class {
    pure = vi.fn(() => 'pure')
    object = vi.fn(() => 'object')
    moveCall = vi.fn()
    build = mocks.build
} }))
vi.mock('@mysten/seal', () => ({
    EncryptedObject: { parse: () => ({ id: '00'.repeat(32) }) },
    SessionKey: { create: mocks.create },
    SealClient: class { decrypt = mocks.decrypt },
}))

import { clearSealSession, fetchAndDecryptBlob } from './blobPreview'

const newSession = () => ({
    isExpired: () => false,
})

beforeEach(() => {
    clearSealSession(); vi.clearAllMocks()
    config.walrusAggregatorUrl = ''
    mocks.create.mockImplementation(async ({ signer }: { signer: { signPersonalMessage: (message: Uint8Array) => Promise<unknown> } }) => {
        await signer.signPersonalMessage(new TextEncoder().encode('seal message'))
        return newSession()
    })
    mocks.readBlob.mockResolvedValue(new Uint8Array([1]))
    mocks.build.mockResolvedValue(new Uint8Array([2]))
    mocks.decrypt.mockResolvedValue(new TextEncoder().encode('hello'))
    mocks.computeBlobMetadata.mockImplementation(async () => ({ blobId: 'a' }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([9]))))
})

it('caches one identity-scoped Seal session', async () => {
    const sign = vi.fn(async () => ({ signature: 'sig' }))
    const opts = { suiClient: {} as never, address: '0x1', accountObjectId: '0x2', signPersonalMessage: sign }
    await fetchAndDecryptBlob({ ...opts, blobId: 'a' })
    await fetchAndDecryptBlob({ ...opts, blobId: 'b' })
    expect(sign).toHaveBeenCalledTimes(1)
    expect(mocks.decrypt).toHaveBeenCalledTimes(2)
})

it('shares concurrent session creation', async () => {
    let release!: (value: ReturnType<typeof newSession>) => void
    mocks.create.mockImplementation(({ signer }: { signer: { signPersonalMessage: (message: Uint8Array) => Promise<unknown> } }) => {
        void signer.signPersonalMessage(new TextEncoder().encode('seal message'))
        return new Promise(resolve => { release = resolve })
    })
    const sign = vi.fn(async () => ({ signature: 'sig' }))
    const opts = { suiClient: {} as never, address: '0x1', accountObjectId: '0x2', signPersonalMessage: sign }
    const first = fetchAndDecryptBlob({ ...opts, blobId: 'a' })
    const second = fetchAndDecryptBlob({ ...opts, blobId: 'b' })
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    release(newSession())
    await Promise.all([first, second])
    expect(sign).toHaveBeenCalledTimes(1)
})

it('never reuses a session across account objects and clear forces renewal', async () => {
    const sign = vi.fn(async () => ({ signature: 'sig' }))
    const base = { suiClient: {} as never, address: '0x1', signPersonalMessage: sign, blobId: 'a' }
    await fetchAndDecryptBlob({ ...base, accountObjectId: '0x2' })
    await fetchAndDecryptBlob({ ...base, accountObjectId: '0x3' })
    clearSealSession()
    await fetchAndDecryptBlob({ ...base, accountObjectId: '0x2' })
    expect(sign).toHaveBeenCalledTimes(3)
})

it('cancels stale preview work before plaintext decryption after identity cleanup', async () => {
    let release!: (value: Uint8Array) => void
    mocks.readBlob.mockReturnValue(new Promise(resolve => { release = resolve }))
    const pending = fetchAndDecryptBlob({
        suiClient: {} as never,
        address: '0x1',
        accountObjectId: '0x2',
        blobId: 'a',
        signPersonalMessage: vi.fn(async () => ({ signature: 'sig' })),
    })
    await vi.waitFor(() => expect(mocks.readBlob).toHaveBeenCalledOnce())
    clearSealSession()
    release(new Uint8Array([1]))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.decrypt).not.toHaveBeenCalled()
})

it('accepts aggregator bytes whose recomputed blob id matches the request', async () => {
    config.walrusAggregatorUrl = 'https://aggregator.example'
    mocks.computeBlobMetadata.mockResolvedValue({ blobId: 'requested-blob' })
    const opts = {
        suiClient: {} as never, address: '0x1', accountObjectId: '0x2', blobId: 'requested-blob',
        signPersonalMessage: vi.fn(async () => ({ signature: 'sig' })),
    }
    await expect(fetchAndDecryptBlob(opts)).resolves.toBe('hello')
    expect(fetch).toHaveBeenCalledWith('https://aggregator.example/v1/blobs/requested-blob', expect.anything())
})

it('rejects aggregator bytes for a substituted blob (id mismatch)', async () => {
    config.walrusAggregatorUrl = 'https://aggregator.example'
    // Aggregator returns bytes for a *different*, validly-formed blob than
    // the one requested -- the recomputed id must not match.
    mocks.computeBlobMetadata.mockResolvedValue({ blobId: 'substituted-blob' })
    const opts = {
        suiClient: {} as never, address: '0x1', accountObjectId: '0x2', blobId: 'requested-blob',
        signPersonalMessage: vi.fn(async () => ({ signature: 'sig' })),
    }
    await expect(fetchAndDecryptBlob(opts)).rejects.toThrow(/different blob/)
    expect(mocks.decrypt).not.toHaveBeenCalled()
})

it('strips a trailing slash from the configured aggregator URL', async () => {
    config.walrusAggregatorUrl = 'https://aggregator.example/'
    mocks.computeBlobMetadata.mockResolvedValue({ blobId: 'requested-blob' })
    const opts = {
        suiClient: {} as never, address: '0x1', accountObjectId: '0x2', blobId: 'requested-blob',
        signPersonalMessage: vi.fn(async () => ({ signature: 'sig' })),
    }
    await fetchAndDecryptBlob(opts)
    expect(fetch).toHaveBeenCalledWith('https://aggregator.example/v1/blobs/requested-blob', expect.anything())
})

it('binds the Seal session to the LEGACY package id at cutover', async () => {
    config.legacyMemwalPackageId = '0xold'
    try {
        const opts = {
            suiClient: {} as never, address: '0x1', accountObjectId: '0x2', blobId: 'a',
            signPersonalMessage: vi.fn(async () => ({ signature: 'sig' })),
        }
        await fetchAndDecryptBlob(opts)
        expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ packageId: '0xold' }))
    } finally {
        config.legacyMemwalPackageId = '0x1'
    }
})
