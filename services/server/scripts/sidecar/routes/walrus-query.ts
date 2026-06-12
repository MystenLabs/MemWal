/**
 * POST /walrus/query-blobs — query the user's Walrus Blob objects from the
 * Sui chain and filter by memwal_* metadata (namespace, packageId).
 */

import express, { type Express } from "express";
import { JSON_LIMIT_METADATA, WALRUS_PACKAGE_ID } from "../config.js";
import { suiClient, suiRpc } from "../clients.js";
import { requestIdFor, sidecarLog } from "../log.js";
import { withRpcRetry } from "../retry/rpc.js";
import { errorMessage, mapConcurrent } from "../util.js";

/**
 * blob_id from chain is a big integer (U256); convert to base64url
 * (little-endian) — the form Walrus aggregators expect.
 */
export function blobIdFromRaw(rawBlobId: string | number | null | undefined): string | null {
    if (!rawBlobId) return null;
    let blobIdStr = String(rawBlobId);
    if (/^\d+$/.test(blobIdStr) && blobIdStr.length > 20) {
        try {
            const bigInt = BigInt(blobIdStr);
            const hex = bigInt.toString(16).padStart(64, "0");
            const bytesBE = hex.match(/.{2}/g)!.map(b => parseInt(b, 16));
            const bytesLE = new Uint8Array(bytesBE.reverse());
            blobIdStr = Buffer.from(bytesLE).toString("base64url");
        } catch {
            // Keep as-is if conversion fails.
        }
    }
    return blobIdStr;
}

export function ownerMatchesRecipient(recipient: any, owner: string): boolean {
    if (typeof recipient === "string") return recipient === owner;
    if (!recipient || typeof recipient !== "object") return false;
    return recipient.AddressOwner === owner
        || recipient.ObjectOwner === owner
        || recipient.SingleOwner === owner
        || recipient.owner === owner;
}

export function isWalrusBlobObjectType(objectType: any, blobType: string): boolean {
    if (objectType === blobType) return true;
    if (typeof objectType !== "string") return false;
    const objectParts = objectType.split("::");
    const blobParts = blobType.split("::");
    return objectParts.length === 3
        && blobParts.length === 3
        && objectParts[1] === blobParts[1]
        && objectParts[2] === blobParts[2]
        && objectParts[0].toLowerCase().replace(/^0x0+/, "0x") === blobParts[0].toLowerCase().replace(/^0x0+/, "0x");
}

type RecentBlobCandidate = {
    objectId: string;
    timestampMs: string | null;
};

type RawBlobObj = {
    objectId: string;
    rawBlobId: string | number | null;
    timestampMs?: string | null;
};

/**
 * Query newest transactions that transferred Walrus Blob objects to the owner.
 * This avoids scanning every Blob object in the wallet before namespace
 * filtering. We still verify object content/metadata after collecting
 * candidates.
 */
async function queryRecentBlobObjectCandidates(
    owner: string,
    blobType: string,
    desiredMatches: number,
): Promise<RecentBlobCandidate[]> {
    const candidateCap = Math.max(1, Math.min(desiredMatches * 5, 100));
    const txPageSize = 50;
    const candidates: RecentBlobCandidate[] = [];
    const seen = new Set<string>();
    let cursor: any = null;

    while (candidates.length < candidateCap) {
        const result = await withRpcRetry<any>(
            "[query-blobs] queryTransactionBlocks",
            () => suiRpc("suix_queryTransactionBlocks", [
                {
                    filter: { ToAddress: owner },
                    options: {
                        showObjectChanges: true,
                        showEffects: false,
                        showInput: false,
                    },
                },
                cursor,
                txPageSize,
                true,
            ]),
        );

        const txs = Array.isArray(result?.data) ? result.data : [];
        if (txs.length === 0) break;

        for (const tx of txs) {
            const timestampMs = typeof tx.timestampMs === "string" ? tx.timestampMs : null;
            const objectChanges = Array.isArray(tx.objectChanges) ? tx.objectChanges : [];
            for (const change of objectChanges) {
                if (!isWalrusBlobObjectType(change?.objectType, blobType)) continue;
                if (change?.type !== "transferred" && change?.type !== "created" && change?.type !== "mutated") continue;
                const belongsToOwner = ownerMatchesRecipient(change.recipient, owner)
                    || ownerMatchesRecipient(change.owner, owner);
                if (!belongsToOwner) continue;
                const objectId = change.objectId;
                if (typeof objectId !== "string" || seen.has(objectId)) continue;
                seen.add(objectId);
                candidates.push({ objectId, timestampMs });
                if (candidates.length >= candidateCap) break;
            }
            if (candidates.length >= candidateCap) break;
        }

        if (!result?.hasNextPage || !result?.nextCursor) break;
        cursor = result.nextCursor;
    }

    return candidates;
}

async function fetchRawBlobObjects(candidates: RecentBlobCandidate[]): Promise<RawBlobObj[]> {
    if (candidates.length === 0) return [];

    const timestampByObject = new Map(candidates.map(c => [c.objectId, c.timestampMs ?? null]));
    const results: any[] = [];
    for (let i = 0; i < candidates.length; i += 50) {
        const objectIds = candidates.slice(i, i + 50).map(c => c.objectId);
        const batch = await withRpcRetry<any[]>(
            "[query-blobs] multiGetObjects",
            () => suiRpc("sui_multiGetObjects", [
                objectIds,
                {
                    showContent: true,
                    showType: true,
                },
            ]),
        );
        results.push(...(Array.isArray(batch) ? batch : []));
    }

    return results
        .map((obj: any) => {
            const objectId = obj?.data?.objectId;
            const content = obj?.data?.content;
            if (typeof objectId !== "string" || !content || content.dataType !== "moveObject") return null;
            const fields = content.fields;
            const rawBlobId = fields?.blob_id ?? fields?.blobId ?? null;
            return { objectId, rawBlobId, timestampMs: timestampByObject.get(objectId) ?? null };
        })
        .filter((obj: RawBlobObj | null): obj is RawBlobObj => obj !== null);
}

export function registerWalrusQueryRoute(app: Express): void {
    app.post("/walrus/query-blobs", express.json({ limit: JSON_LIMIT_METADATA }), async (req, res) => {
        try {
            const { owner, namespace, packageId, limit } = req.body;
            if (!owner) {
                return res.status(400).json({ error: "Missing required field: owner" });
            }
            const desiredMatches = Math.max(1, Math.min(Number(limit) || 0, 500));
            const useRecentTxPath = Number.isFinite(Number(limit)) && Number(limit) > 0;

            // Walrus Blob type (derived from env-driven WALRUS_PACKAGE_ID)
            const WALRUS_BLOB_TYPE = `${WALRUS_PACKAGE_ID}::blob::Blob`;

            // Step 1: Collect raw blob objects. Restore passes `limit`, so prefer
            // newest transfer transactions and cap candidates at 100 instead of
            // scanning every Walrus Blob object owned by the wallet.
            let rawObjs: RawBlobObj[] = [];
            if (useRecentTxPath) {
                const candidates = await queryRecentBlobObjectCandidates(owner, WALRUS_BLOB_TYPE, desiredMatches);
                rawObjs = await fetchRawBlobObjects(candidates);
                console.log(
                    `[query-blobs] found ${rawObjs.length}/${candidates.length} recent raw blob candidates for owner=${owner} ` +
                    `(target=${desiredMatches}, candidateCap=${Math.min(desiredMatches * 5, 100)})`,
                );
            } else {
                let cursor: string | null | undefined = undefined;
                let hasMore = true;

                while (hasMore) {
                    const result = await suiClient.getOwnedObjects({
                        owner,
                        filter: { StructType: WALRUS_BLOB_TYPE },
                        options: { showContent: true },
                        cursor: cursor ?? undefined,
                        limit: 50,
                    });

                    for (const obj of result.data) {
                        if (!obj.data?.content || obj.data.content.dataType !== "moveObject") continue;
                        const fields = (obj.data.content as any).fields;
                        if (!fields) continue;
                        const rawBlobId = fields.blob_id ?? fields.blobId ?? null;
                        rawObjs.push({ objectId: obj.data.objectId, rawBlobId });
                    }

                    hasMore = result.hasNextPage;
                    cursor = result.nextCursor;
                }
                console.log(`[query-blobs] found ${rawObjs.length} raw blob objects for owner=${owner}`);
            }

            // Step 2: Fetch metadata for each blob with bounded concurrency
            // to avoid overwhelming Sui RPC and hitting 429 rate limits.
            const METADATA_FIELD_NAME = {
                type: "vector<u8>",
                value: [109, 101, 116, 97, 100, 97, 116, 97], // b"metadata"
            };

            type BlobMeta = {
                objectId: string;
                rawBlobId: string | number | null;
                blobNamespace: string;
                blobOwner: string;
                blobPackageId: string;
                blobAgentId: string;
            };

            const metadataConcurrency = useRecentTxPath ? 2 : 5;
            const metas: BlobMeta[] = await mapConcurrent(rawObjs, metadataConcurrency, async (obj) => {
                let blobNamespace = "default";
                let blobOwner = "";
                let blobPackageId = "";
                let blobAgentId = "";

                try {
                    const dynField = await withRpcRetry(
                        `[query-blobs] getDynamicField ${obj.objectId}`,
                        () => suiClient.getDynamicFieldObject({
                            parentId: obj.objectId,
                            name: METADATA_FIELD_NAME,
                        }),
                    );

                    if (dynField.data?.content && dynField.data.content.dataType === "moveObject") {
                        const dynFields = (dynField.data.content as any).fields;
                        // Path: fields.value.fields.metadata.fields.contents[]
                        const contents = dynFields?.value?.fields?.metadata?.fields?.contents;
                        if (Array.isArray(contents)) {
                            for (const entry of contents) {
                                const key = entry?.fields?.key;
                                const value = entry?.fields?.value;
                                if (key === "memwal_namespace") blobNamespace = value;
                                if (key === "memwal_owner") blobOwner = value;
                                if (key === "memwal_package_id") blobPackageId = value;
                                if (key === "memwal_agent_id") blobAgentId = value;
                            }
                        }
                    }
                } catch {
                    // No dynamic field = no metadata = use defaults
                }

                return { ...obj, blobNamespace, blobOwner, blobPackageId, blobAgentId };
            });

            // Step 3: Filter + convert blob IDs
            const blobs: { blobId: string; objectId: string; namespace: string; packageId: string; agentId: string }[] = [];

            for (const meta of metas) {
                // Filter by namespace if specified
                if (namespace && meta.blobNamespace !== namespace) continue;
                // Filter by packageId if specified
                if (packageId && meta.blobPackageId !== packageId) continue;

                if (meta.rawBlobId) {
                    const blobIdStr = blobIdFromRaw(meta.rawBlobId);
                    if (blobIdStr) {
                        blobs.push({ blobId: blobIdStr, objectId: meta.objectId, namespace: meta.blobNamespace, packageId: meta.blobPackageId, agentId: meta.blobAgentId });
                    }
                }
            }

            console.log(`[query-blobs] returning ${blobs.length} blobs (filtered from ${rawObjs.length}) for owner=${owner} ns=${namespace || '*'}`);
            res.json({ blobs, total: blobs.length });
        } catch (err: any) {
            const traceId = requestIdFor(req);
            const message = errorMessage(err);
            sidecarLog("error", "walrus_query_blobs_failed", {
                requestId: traceId,
                error: message,
            });
            res.status(500).json({ error: message, traceId });
        }
    });
}
