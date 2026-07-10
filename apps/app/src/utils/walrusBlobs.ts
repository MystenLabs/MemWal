/**
 * Walrus blob enumeration for the V1 memory-deletion flow (WALM-264).
 *
 * Layers, bottom to top:
 *  - listOwnedWalrusBlobs — paginate the wallet's on-chain `blob::Blob`
 *    objects (gRPC or JSON-RPC client), converting the raw u256 `blob_id`
 *    to the base64url form the relayer DB uses. A blob only counts as
 *    deletable when its on-chain flag is set AND its storage hasn't
 *    expired (expired blobs would poison a whole delete PTB, and their
 *    data is already gone).
 *  - listScopedDeletableBlobs — the same list intersected with the relayer
 *    DB's authoritative memory set (POST /api/memory-blob-ids), so
 *    unrelated or V2 blobs the wallet owns are never offered for deletion.
 *    Results are cached per wallet (5 min) and in-flight calls are shared,
 *    so the banner and the cleanup card don't each rescan the chain.
 */

import type { useSuiClient } from '@mysten/dapp-kit'
import { WalrusClient } from '@mysten/walrus'
import { config } from '../config'
import { apiCall } from './api'
import { isGrpcClient } from './suiClientCompat'

type SuiClient = ReturnType<typeof useSuiClient>

export interface OwnedWalrusBlob {
    /** Sui object id — what `system::delete_blob` consumes */
    objectId: string
    /** Walrus blob id, base64url (matches relayer DB `blob_id`) */
    blobId: string
    /** On-chain deletable flag AND storage not expired */
    deletable: boolean
}

const walrusClients = new WeakMap<object, WalrusClient>()

export function getWalrusClient(suiClient: SuiClient): WalrusClient {
    let client = walrusClients.get(suiClient as object)
    if (!client) {
        client = new WalrusClient({
            network: config.suiNetwork,
            suiClient: suiClient as never,
        })
        walrusClients.set(suiClient as object, client)
    }
    return client
}

/**
 * blob_id on chain is a u256 decimal string; aggregators and the relayer DB
 * use base64url of its little-endian bytes. Mirrors the sidecar's
 * `blobIdFromRaw`.
 */
export function blobIdFromRaw(rawBlobId: string | number | null | undefined): string | null {
    if (rawBlobId === null || rawBlobId === undefined) return null
    const blobIdStr = String(rawBlobId)
    if (!/^\d+$/.test(blobIdStr) || blobIdStr.length <= 20) return blobIdStr
    try {
        const hex = BigInt(blobIdStr).toString(16).padStart(64, '0')
        const bytesBE = hex.match(/.{2}/g)!.map((b) => parseInt(b, 16))
        const bytesLE = new Uint8Array(bytesBE.reverse())
        let binary = ''
        for (const b of bytesLE) binary += String.fromCharCode(b)
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    } catch {
        return blobIdStr
    }
}

/**
 * Whether a blob can actually be deleted: the on-chain flag is set and the
 * storage hasn't lapsed. `walrus::blob::delete` is only valid for live
 * storage, so one expired blob would abort an entire delete batch — and an
 * expired blob's data is gone anyway. Unparsable end_epoch (shape drift)
 * fails open so the feature doesn't brick; the sponsor dry-run remains the
 * backstop.
 */
function isDeletable(deletableFlag: unknown, endEpoch: unknown, currentEpoch: number): boolean {
    if (deletableFlag !== true) return false
    const end = Number(endEpoch)
    return Number.isFinite(end) ? end > currentEpoch : true
}

/**
 * Enumerate every Walrus `blob::Blob` object the wallet owns. The Walrus
 * package id and current epoch come from the WalrusClient (per network), so
 * nothing is hardcoded. Paginates until exhaustion — a heavy V1 user can
 * own tens of thousands of blobs, so callers should show progress.
 */
export async function listOwnedWalrusBlobs(
    suiClient: SuiClient,
    owner: string,
    onProgress?: (count: number) => void,
): Promise<OwnedWalrusBlob[]> {
    const walrusClient = getWalrusClient(suiClient)
    const [blobType, systemState] = await Promise.all([
        walrusClient.getBlobType(),
        walrusClient.systemState(),
    ])
    const currentEpoch = systemState.committee.epoch

    const blobs: OwnedWalrusBlob[] = []
    let cursor: string | null | undefined
    let hasMore = true

    // gRPC exposes listOwnedObjects (server-side type filter + flat json),
    // JSON-RPC exposes getOwnedObjects (StructType filter + nested fields) —
    // same duck-typed branching as suiClientCompat.
    const grpc = isGrpcClient(suiClient)

    while (hasMore) {
        if (grpc) {
            const page = await (suiClient as any).listOwnedObjects({
                owner,
                type: blobType,
                include: { json: true },
                cursor: cursor ?? undefined,
                limit: 50,
            })
            for (const obj of page?.objects ?? []) {
                if (typeof obj?.objectId !== 'string') continue
                const blobId = blobIdFromRaw(obj.json?.blob_id)
                if (!blobId) continue
                blobs.push({
                    objectId: obj.objectId,
                    blobId,
                    deletable: isDeletable(
                        obj.json?.deletable,
                        obj.json?.storage?.end_epoch,
                        currentEpoch,
                    ),
                })
            }
            hasMore = Boolean(page?.hasNextPage && page?.cursor)
            cursor = page?.cursor
        } else {
            const page = await (suiClient as any).getOwnedObjects({
                owner,
                filter: { StructType: blobType },
                options: { showContent: true },
                cursor: cursor ?? undefined,
                limit: 50,
            })
            for (const obj of page.data) {
                const content = obj.data?.content
                if (!obj.data?.objectId || !content || content.dataType !== 'moveObject') continue
                const fields = content.fields as Record<string, any>
                const blobId = blobIdFromRaw(fields.blob_id as string)
                if (!blobId) continue
                blobs.push({
                    objectId: obj.data.objectId,
                    blobId,
                    deletable: isDeletable(
                        fields.deletable,
                        fields.storage?.fields?.end_epoch,
                        currentEpoch,
                    ),
                })
            }
            hasMore = page.hasNextPage
            cursor = page.nextCursor
        }

        onProgress?.(blobs.length)
    }

    return blobs
}

// ── Scoped + cached layer ──────────────────────────────────────────────

interface CachedScan {
    at: number
    promise: Promise<OwnedWalrusBlob[]>
}

const SCAN_TTL_MS = 5 * 60 * 1000
const scanCache = new Map<string, CachedScan>()

/** Drop cached scans for a wallet (call after a delete changes the chain). */
export function invalidateWalrusBlobScan(owner?: string): void {
    if (!owner) {
        scanCache.clear()
        return
    }
    for (const key of scanCache.keys()) {
        if (key.startsWith(`${owner}:`)) scanCache.delete(key)
    }
}

export interface ScopedBlobsOptions {
    /** Delegate key session — required to scope against the relayer DB. */
    delegateKey: string | null
    accountObjectId?: string | null
    onProgress?: (count: number) => void
    /** Bypass the cache (user pressed Refresh / post-delete reload). */
    force?: boolean
}

/**
 * The wallet's on-chain blobs intersected with the relayer DB's memory set.
 * With no delegate key the DB can't be consulted, so the result is marked
 * unscoped — callers must not present unscoped counts as deletable
 * memories. Cached per wallet+scope so simultaneous callers (banner + card)
 * share one chain scan.
 */
export async function listScopedDeletableBlobs(
    suiClient: SuiClient,
    owner: string,
    { delegateKey, accountObjectId, onProgress, force }: ScopedBlobsOptions,
): Promise<{ blobs: OwnedWalrusBlob[]; scoped: boolean }> {
    const scoped = Boolean(delegateKey)
    const key = `${owner}:${scoped ? 's' : 'u'}`

    const cached = scanCache.get(key)
    if (!force && cached && Date.now() - cached.at < SCAN_TTL_MS) {
        return { blobs: await cached.promise, scoped }
    }

    const promise = (async () => {
        const owned = await listOwnedWalrusBlobs(suiClient, owner, onProgress)
        if (!delegateKey) return owned
        const res = await apiCall(
            delegateKey,
            config.memwalServerUrl,
            '/api/memory-blob-ids',
            {},
            accountObjectId ?? undefined,
        )
        const known = new Set<string>(res.blobIds ?? [])
        return owned.filter((b) => known.has(b.blobId))
    })()
    scanCache.set(key, { at: Date.now(), promise })

    try {
        return { blobs: await promise, scoped }
    } catch (err) {
        // Don't cache failures.
        if (scanCache.get(key)?.promise === promise) scanCache.delete(key)
        throw err
    }
}
