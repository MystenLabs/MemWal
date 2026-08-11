import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ requestChallenge: vi.fn(), verifyChallenge: vi.fn() }))
vi.mock('./securityDeleteApi', async importOriginal => {
    const original = await importOriginal<typeof import('./securityDeleteApi')>()
    return { ...original, ...api }
})

import { SdApiError } from './securityDeleteApi'
import { __resetAuthForTests, clearToken, getToken, withAuth } from './securityDeleteAuth'

const sign = vi.fn(async () => ({ signature: 'sig' }))

beforeEach(() => {
    __resetAuthForTests(); vi.clearAllMocks()
    api.requestChallenge.mockResolvedValue({ challengeId: 'challenge-id', challenge: 'exact message', expiresInSecs: 300 })
    api.verifyChallenge.mockResolvedValue({ token: 'token', expiresInSecs: 2700 })
})

describe('securityDeleteAuth', () => {
    it('signs exact bytes, echoes challenge id, and caches', async () => {
        expect(await getToken('0x1', sign)).toBe('token')
        expect(await getToken('0x01', sign)).toBe('token')
        expect(sign).toHaveBeenCalledTimes(1)
        expect(new TextDecoder().decode(sign.mock.calls[0][0])).toBe('exact message')
        expect(api.verifyChallenge).toHaveBeenCalledWith('challenge-id', expect.stringMatching(/^0x0+1$/), 'sig')
    })

    it('concurrent callers share one wallet popup', async () => {
        let release!: (value: { signature: string }) => void
        const slowSign = vi.fn(() => new Promise<{ signature: string }>(resolve => { release = resolve }))
        const first = getToken('0x2', slowSign)
        const second = getToken('0x2', slowSign)
        await vi.waitFor(() => expect(slowSign).toHaveBeenCalledOnce())
        release({ signature: 'sig' })
        await expect(Promise.all([first, second])).resolves.toEqual(['token', 'token'])
    })

    it('restarts a verify-expired challenge once', async () => {
        api.verifyChallenge.mockRejectedValueOnce(new SdApiError('AUTH_CHALLENGE_EXPIRED', 'REAUTH', true, 401, 'expired')).mockResolvedValueOnce({ token: 'fresh', expiresInSecs: 2700 })
        await expect(getToken('0x3', sign)).resolves.toBe('fresh')
        expect(api.requestChallenge).toHaveBeenCalledTimes(2)
    })

    it('withAuth refreshes once and never loops', async () => {
        const call = vi.fn().mockRejectedValue(new SdApiError('AUTH_TOKEN_EXPIRED', 'REAUTH', true, 401, 'expired'))
        await expect(withAuth('0x4', sign, call)).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' })
        expect(call).toHaveBeenCalledTimes(2)
    })

    it('clearToken is isolated by canonical owner', async () => {
        api.verifyChallenge.mockResolvedValueOnce({ token: 'a', expiresInSecs: 2700 }).mockResolvedValueOnce({ token: 'b', expiresInSecs: 2700 }).mockResolvedValueOnce({ token: 'a2', expiresInSecs: 2700 })
        await getToken('0xa', sign); await getToken('0xb', sign)
        clearToken('0x0a')
        expect(await getToken('0xb', sign)).toBe('b')
        expect(await getToken('0xa', sign)).toBe('a2')
    })

    it('does not repopulate a cleared owner from stale in-flight verification', async () => {
        let release!: (value: { token: string; expiresInSecs: number }) => void
        api.verifyChallenge.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
            .mockResolvedValueOnce({ token: 'new-token', expiresInSecs: 2700 })
        const stale = getToken('0xc', sign)
        await vi.waitFor(() => expect(api.verifyChallenge).toHaveBeenCalledOnce())
        clearToken('0xc')
        release({ token: 'stale-token', expiresInSecs: 2700 })
        await expect(stale).rejects.toMatchObject({ name: 'AbortError' })
        await expect(getToken('0xc', sign)).resolves.toBe('new-token')
        expect(api.requestChallenge).toHaveBeenCalledTimes(2)
    })
})
