import { normalizeSuiAddress } from '@mysten/sui/utils'
import { requestChallenge, SdApiError, verifyChallenge } from './securityDeleteApi'

export type SignPersonalMessage = (message: Uint8Array) => Promise<{ signature: string }>
interface CachedToken { token: string; expiresAtMs: number }
const tokens = new Map<string, CachedToken>()
const inflight = new Map<string, Promise<string>>()
const generations = new Map<string, number>()

const keyFor = (address: string) => normalizeSuiAddress(address)

async function issueToken(address: string, sign: SignPersonalMessage, generation: number): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const challenge = await requestChallenge(address)
            const { signature } = await sign(new TextEncoder().encode(challenge.challenge))
            const verified = await verifyChallenge(challenge.challengeId, address, signature)
            if ((generations.get(address) ?? 0) !== generation) {
                throw new DOMException('Authentication was invalidated by an identity change.', 'AbortError')
            }
            tokens.set(address, { token: verified.token, expiresAtMs: Date.now() + verified.expiresInSecs * 1000 })
            return verified.token
        } catch (error) {
            if (!(error instanceof SdApiError) || error.action !== 'REAUTH' || attempt === 1) throw error
        }
    }
    throw new Error('unreachable')
}

export async function getToken(rawAddress: string, sign: SignPersonalMessage): Promise<string> {
    const address = keyFor(rawAddress)
    const cached = tokens.get(address)
    if (cached && cached.expiresAtMs - Date.now() >= 60_000) return cached.token
    const existing = inflight.get(address)
    if (existing) return existing
    const generation = generations.get(address) ?? 0
    const promise = issueToken(address, sign, generation).finally(() => {
        if (inflight.get(address) === promise) inflight.delete(address)
    })
    inflight.set(address, promise)
    return promise
}

export function clearToken(rawAddress: string): void {
    const address = keyFor(rawAddress)
    generations.set(address, (generations.get(address) ?? 0) + 1)
    tokens.delete(address)
    inflight.delete(address)
}

export async function withAuth<T>(address: string, sign: SignPersonalMessage, call: (token: string) => Promise<T>): Promise<T> {
    let token = await getToken(address, sign)
    try { return await call(token) } catch (error) {
        if (!(error instanceof SdApiError) || error.action !== 'REAUTH') throw error
        clearToken(address)
        token = await getToken(address, sign)
        return call(token)
    }
}

export function __resetAuthForTests(): void { tokens.clear(); inflight.clear(); generations.clear() }
