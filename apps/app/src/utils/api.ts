/**
 * API Client — Ed25519-signed HTTP requests
 *
 * Reusable utilities for making authenticated API calls
 * to the MemWal server. Used by both Playground and any
 * future client-side integrations.
 */

/**
 * Sign a request using Ed25519 delegate key.
 *
 * Message format: "{timestamp}.{method}.{path}.{sha256(body)}"
 */
export async function signRequest(
    privateKeyHex: string,
    method: string,
    path: string,
    body: string,
) {
    const ed = await import('@noble/ed25519')
    const timestamp = Math.floor(Date.now() / 1000).toString()

    const bodyBytes = new TextEncoder().encode(body)
    const hashBuf = await crypto.subtle.digest('SHA-256', bodyBytes)
    const bodySha = Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

    const message = `${timestamp}.${method}.${path}.${bodySha}`
    const msgBytes = new TextEncoder().encode(message)

    const privKey = Uint8Array.from(
        { length: privateKeyHex.length / 2 },
        (_, i) => parseInt(privateKeyHex.slice(i * 2, i * 2 + 2), 16),
    )
    const pubKey = await ed.getPublicKeyAsync(privKey)
    const signature = await ed.signAsync(msgBytes, privKey)

    return {
        timestamp,
        publicKey: Array.from(pubKey)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
        signature: Array.from(signature)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
    }
}

/**
 * Make an authenticated API call to the MemWal server.
 *
 * Automatically signs the request with the delegate key
 * and includes the account object ID header if provided.
 */
export async function apiCall(
    privateKeyHex: string,
    serverUrl: string,
    path: string,
    body: object,
    accountId?: string,
) {
    const bodyStr = JSON.stringify(body)
    const { timestamp, publicKey, signature } = await signRequest(
        privateKeyHex,
        'POST',
        path,
        bodyStr,
    )

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-public-key': publicKey,
        'x-signature': signature,
        'x-timestamp': timestamp,
    }
    if (accountId) {
        headers['x-account-id'] = accountId
    }

    const resp = await fetch(`${serverUrl}${path}`, {
        method: 'POST',
        headers,
        body: bodyStr,
    })

    if (!resp.ok) {
        const err = await resp.text()
        throw new Error(`API error (${resp.status}): ${err}`)
    }

    return resp.json()
}
