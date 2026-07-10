/**
 * Sui client compatibility layer — App.tsx's SuiClientProvider hands out a
 * SuiGrpcClient when VITE_SUI_GRPC_URL is set for the active network (opt-in,
 * mirroring the sidecar's SUI_GRPC_URL migration for the JSON-RPC sunset) and
 * a SuiJsonRpcClient otherwise. The two have different getObject /
 * dynamic-field / execute method shapes — these helpers branch on which one
 * is actually present so callers work correctly under either, instead of
 * assuming one shape unconditionally.
 */

import { fromBase64, fromHex, normalizeSuiAddress, toHex } from '@mysten/sui/utils'

/**
 * Single transport discriminator shared by every cross-transport helper —
 * gRPC clients expose getDynamicField, JSON-RPC clients don't.
 */
export function isGrpcClient(suiClient: unknown): boolean {
    return typeof (suiClient as { getDynamicField?: unknown })?.getDynamicField === 'function'
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

// The registry's inner Table object ID is an immutable on-chain constant —
// cache it so repeat account lookups skip the registry round trip.
const registryTableIdCache = new Map<string, string>()

/** Resolve a MemWalAccount object ID for `ownerAddress` via the registry's Table<address, ID>. */
export async function fetchAccountIdForOwner(
    suiClient: unknown,
    registryId: string,
    ownerAddress: string,
): Promise<string | null> {
    let tableId = registryTableIdCache.get(registryId)
    if (!tableId) {
        const registryJson = await fetchObjectJson(suiClient, registryId)
        // gRPC json flattens the Table's UID to a plain string; JSON-RPC keeps
        // Move's nested UID shape ({ id: { id: "0x…" } }) even after field
        // unwrapping. Accept both, or the JSON-RPC path passes an object as
        // parentId and every lookup dies with "Invalid params".
        const rawId = (registryJson?.accounts as { id?: string | { id?: string } } | undefined)?.id
        tableId = typeof rawId === 'string' ? rawId : rawId?.id
        if (!tableId) return null
        registryTableIdCache.set(registryId, tableId)
    }

    if (isGrpcClient(suiClient)) {
        const dynFieldRes = await (suiClient as any).getDynamicField({
            parentId: tableId,
            name: { type: 'address', bcs: fromHex(normalizeSuiAddress(ownerAddress)) },
        })
        const valueBytes = dynFieldRes?.dynamicField?.value?.bcs
        if (!valueBytes || valueBytes.length !== 32) return null
        return '0x' + toHex(valueBytes)
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
    if (typeof publicKey === 'string') return toHex(fromBase64(publicKey))
    if (Array.isArray(publicKey)) return toHex(new Uint8Array(publicKey as number[]))
    console.warn('[suiClientCompat] unrecognized public_key encoding', typeof publicKey)
    return ''
}

/**
 * Execute a signed transaction, regardless of client transport. dapp-kit's
 * default useSignAndExecuteTransaction execute step calls the JSON-RPC-only
 * client.executeTransactionBlock(); gRPC's core API only has
 * executeTransaction(), with a {Transaction:{digest}} | {FailedTransaction:
 * {digest}} union response instead of a flat one.
 */
export async function executeTransactionCompat(
    client: unknown,
    { bytes, signature }: { bytes: string; signature: string },
): Promise<{ digest: string; rawEffects?: number[] }> {
    if (!isGrpcClient(client)) {
        const res = await (client as any).executeTransactionBlock({
            transactionBlock: bytes,
            signature,
            options: { showRawEffects: true },
        })
        return { digest: res.digest, rawEffects: res.rawEffects }
    }

    const res = await (client as any).executeTransaction({ transaction: fromBase64(bytes), signatures: [signature] })
    const digest = res?.Transaction?.digest ?? res?.FailedTransaction?.digest
    if (!digest) throw new Error('executeTransaction: could not resolve digest from result')
    return { digest }
}
