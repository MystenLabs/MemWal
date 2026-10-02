/**
 * Sui client compatibility layer. App.tsx's shared SuiClientProvider stays on
 * JSON-RPC (see the comment there for why), but callers may still receive a
 * SuiGrpcClient — e.g. the security-delete subsystem's own scoped client
 * (utils/suiClientFactory.ts). The two have different getObject and
 * dynamic-field shapes, so these helpers keep that cross-transport
 * compatibility at one boundary rather than letting every call site assume
 * one shape unconditionally.
 */

import { isSuiGrpcClient, type SuiGrpcClient } from '@mysten/sui/grpc'
import { fromBase64, fromHex, normalizeSuiAddress, toHex } from '@mysten/sui/utils'

interface JsonRpcClientLike {
    getObject(input: { id: string; options: { showContent: boolean } }): Promise<{
        data?: { content?: { fields?: unknown } }
    }>
    getDynamicFieldObject(input: {
        parentId: string
        name: { type: string; value: string }
    }): Promise<{ data?: { content?: { fields?: unknown } } }>
}

/**
 * Use the SDK brand rather than inferring transport from coincidental methods.
 */
export function isGrpcClient(suiClient: unknown): suiClient is SuiGrpcClient {
    return isSuiGrpcClient(suiClient)
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
export async function fetchObjectJson(suiClient: unknown, objectId: string): Promise<Record<string, unknown> | null> {
    if (isGrpcClient(suiClient)) {
        const res = await suiClient.getObject({ objectId, include: { json: true } })
        return res.object.json ?? null
    }

    const res = await (suiClient as JsonRpcClientLike).getObject({ id: objectId, options: { showContent: true } })
    const content = res?.data?.content
    if (!content?.fields) return null
    return unwrapJsonRpcFields(content.fields) as Record<string, unknown>
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
        // gRPC json flattens the Table's UID to a plain string. Keep the nested
        // form solely for the explicit local JSON-RPC browser suite.
        const rawId = (registryJson?.accounts as { id?: string | { id?: string } } | undefined)?.id
        tableId = typeof rawId === 'string' ? rawId : rawId?.id
        if (!tableId) return null
        registryTableIdCache.set(registryId, tableId)
    }

    if (isGrpcClient(suiClient)) {
        let dynFieldRes: Awaited<ReturnType<SuiGrpcClient['getDynamicField']>>
        try {
            dynFieldRes = await suiClient.getDynamicField({
                parentId: tableId,
                name: { type: 'address', bcs: fromHex(normalizeSuiAddress(ownerAddress)) },
            })
        } catch (err) {
            // getDynamicField throws when the field object doesn't exist —
            // the normal "no Account yet" case. grpc/core.mjs represents
            // that specific case as `new Error("Object <id> not found")`
            // (verified against the shipped @mysten/sui build) — match that
            // shape exactly. Any other per-object failure it can throw (e.g.
            // "Unexpected result type") is a genuine anomaly, not a missing
            // account, and a real transport failure throws a different error
            // class entirely (e.g. RpcError) — both must still propagate for
            // the caller to treat as a real failure.
            if (
                err instanceof Error &&
                err.constructor === Error &&
                /^Object 0x[0-9a-f]+ not found$/.test(err.message)
            ) {
                return null
            }
            throw err
        }
        const valueBytes = dynFieldRes?.dynamicField?.value?.bcs
        if (!valueBytes || valueBytes.length !== 32) return null
        return '0x' + toHex(valueBytes)
    }

    const dynField = await (suiClient as JsonRpcClientLike).getDynamicFieldObject({
        parentId: tableId,
        name: { type: 'address', value: ownerAddress },
    })
    const content = dynField?.data?.content
    if (!content?.fields || typeof content.fields !== 'object') return null
    const value = (content.fields as Record<string, unknown>).value
    return typeof value === 'string' ? value : null
}

/** Normalize a delegate key's public_key field to hex — gRPC encodes it as base64, JSON-RPC as number[]. */
export function publicKeyToHex(publicKey: unknown): string {
    if (typeof publicKey === 'string') return toHex(fromBase64(publicKey))
    if (Array.isArray(publicKey)) return toHex(new Uint8Array(publicKey as number[]))
    console.warn('[suiClientCompat] unrecognized public_key encoding', typeof publicKey)
    return ''
}
