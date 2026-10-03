import { fetchObjectJson, publicKeyToHex } from './suiClientCompat'

export function normalizeDelegatePrivateKey(raw: string): string | null {
    const normalized = raw.trim().replace(/^0x/i, '').replace(/\s+/g, '').toLowerCase()
    return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null
}

export async function deriveDelegatePublicKeyHex(privateKeyHex: string): Promise<string> {
    const ed = await import('@noble/ed25519')
    const privateKey = Uint8Array.from(privateKeyHex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)))
    const publicKey = await ed.getPublicKeyAsync(privateKey)
    return Array.from(publicKey).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function assertDelegateKeyRegistered(
    suiClient: Parameters<typeof fetchObjectJson>[0],
    accountId: string,
    publicKeyHex: string,
): Promise<void> {
    const json = await fetchObjectJson(suiClient, accountId) as
        { delegate_keys?: { public_key?: unknown }[] } | null
    const registered = (json?.delegate_keys ?? []).some((key) =>
        publicKeyToHex(key.public_key).replace(/^0x/i, '').toLowerCase() === publicKeyHex,
    )
    if (!registered) {
        throw new Error('This delegate key is not registered on-chain for the connected wallet.')
    }
}
