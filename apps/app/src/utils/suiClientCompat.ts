/**
 * Sui client compatibility layer — App.tsx's SuiClientProvider hands out a
 * SuiGrpcClient for testnet (SUI_GRPC_URL opt-in, testnet's public JSON-RPC
 * endpoint currently returns 404) and a SuiJsonRpcClient for mainnet/other
 * networks. The two have different getObject/dynamic-field method shapes —
 * these helpers branch on which one is actually present so callers work
 * correctly under either, instead of assuming one shape unconditionally.
 */

function isGrpcClient(suiClient: unknown): boolean {
    return typeof (suiClient as { getDynamicField?: unknown })?.getDynamicField === 'function'
}

function hexToBytes32(address: string): Uint8Array {
    const clean = address.replace(/^0x/i, '').padStart(64, '0')
    return new Uint8Array(
        Array.from({ length: clean.length / 2 }, (_, i) => parseInt(clean.slice(i * 2, i * 2 + 2), 16))
    )
}

function bytesToHex(bytes: Uint8Array | number[]): string {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function base64ToBytes(b64: string): number[] {
    return Array.from(atob(b64), (c) => c.charCodeAt(0))
}

// JSON-RPC's showContent wraps every nested Move struct in its own
// {type, fields, hasPublicTransfer} envelope (e.g. accounts.fields.id.id);
// gRPC's .json is fully flat (accounts.id). Strip every such wrapper
// recursively so both transports produce the same flat shape.
function unwrapJsonRpcFields(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(unwrapJsonRpcFields)
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>
        const inner = 'fields' in obj && typeof obj.fields === 'object' && obj.fields !== null ? obj.fields : obj
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(inner as Record<string, unknown>)) {
            out[k] = unwrapJsonRpcFields(v)
        }
        return out
    }
    return value
}

/** Fetch a Move object's fields as a flat JS object, regardless of client transport. */
export async function fetchObjectJson(suiClient: unknown, objectId: string): Promise<Record<string, any> | null> {
    if (isGrpcClient(suiClient)) {
        const res = await (suiClient as any).getObject({ objectId, include: { json: true } })
        return (res?.object?.json as Record<string, any>) ?? null
    }

    const res = await (suiClient as any).getObject({ id: objectId, options: { showContent: true } })
    const content = res?.data?.content
    if (!content || !('fields' in content)) return null
    return unwrapJsonRpcFields(content.fields) as Record<string, any>
}

/** Resolve a MemWalAccount object ID for `ownerAddress` via the registry's Table<address, ID>. */
export async function fetchAccountIdForOwner(
    suiClient: unknown,
    registryId: string,
    ownerAddress: string,
): Promise<string | null> {
    const registryJson = await fetchObjectJson(suiClient, registryId)
    const tableId = (registryJson?.accounts as { id?: string } | undefined)?.id
    if (!tableId) return null

    if (isGrpcClient(suiClient)) {
        const dynFieldRes = await (suiClient as any).getDynamicField({
            parentId: tableId,
            name: { type: 'address', bcs: hexToBytes32(ownerAddress) },
        })
        const valueBytes = dynFieldRes?.dynamicField?.value?.bcs
        if (!valueBytes || valueBytes.length !== 32) return null
        return '0x' + bytesToHex(valueBytes)
    }

    const dynField = await (suiClient as any).getDynamicFieldObject({
        parentId: tableId,
        name: { type: 'address', value: ownerAddress },
    })
    const content = dynField?.data?.content
    if (!content || !('fields' in content)) return null
    const value = (content.fields as Record<string, unknown>)?.value
    return typeof value === 'string' ? value : null
}

/** Normalize a delegate key's public_key field to hex — gRPC encodes it as base64, JSON-RPC as number[]. */
export function publicKeyToHex(publicKey: unknown): string {
    if (typeof publicKey === 'string') return bytesToHex(base64ToBytes(publicKey))
    if (Array.isArray(publicKey)) return bytesToHex(publicKey as number[])
    return ''
}
