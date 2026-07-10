/**
 * Walrus blob enumeration + id helpers for the V1 memory-deletion flow
 * (WALM-264). Enumerates the connected wallet's on-chain `blob::Blob`
 * objects and converts their raw u256 `blob_id` into the base64url form the
 * relayer DB and Walrus aggregators use.
 */

import type { useSuiClient } from '@mysten/dapp-kit'
import { WalrusClient } from '@mysten/walrus'
import { config } from '../config'
import { isGrpcClient } from './suiClientCompat'

type SuiClient = ReturnType<typeof useSuiClient>

export interface OwnedWalrusBlob {
    /** Sui object id — what `system::delete_blob` consumes */
    objectId: string
    /** Walrus blob id, base64url (matches relayer DB `blob_id`) */
    blobId: string
    /** Only deletable blobs can be deleted; the rest are permanent */
    deletable: boolean
}

let walrusClient: WalrusClient | null = null

export function getWalrusClient(suiClient: SuiClient): WalrusClient {
    if (!walrusClient) {
        walrusClient = new WalrusClient({
            network: config.suiNetwork,
            suiClient: suiClient as never,
        })
    }
    return walrusClient
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
 * Enumerate every Walrus `blob::Blob` object the wallet owns. The Walrus
 * package id comes from the WalrusClient (per network), so nothing is
 * hardcoded. Paginates until exhaustion — a heavy V1 user can own tens of
 * thousands of blobs, so callers should show progress while this runs.
 */
export async function listOwnedWalrusBlobs(
    suiClient: SuiClient,
    owner: string,
    onProgress?: (count: number) => void,
): Promise<OwnedWalrusBlob[]> {
    const blobType = await getWalrusClient(suiClient).getBlobType()

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
                    deletable: obj.json?.deletable === true,
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
                const fields = content.fields as Record<string, unknown>
                const blobId = blobIdFromRaw(fields.blob_id as string)
                if (!blobId) continue
                blobs.push({
                    objectId: obj.data.objectId,
                    blobId,
                    deletable: fields.deletable === true,
                })
            }
            hasMore = page.hasNextPage
            cursor = page.nextCursor
        }

        onProgress?.(blobs.length)
    }

    return blobs
}
