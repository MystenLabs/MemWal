/**
 * POST /walrus/query-blobs — query the user's Walrus Blob objects from the
 * Sui chain and filter by memwal_* metadata (namespace, packageId).
 */

import express, { type Express } from "express";
import { blobIdFromInt } from "@mysten/walrus";
import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { JSON_LIMIT_METADATA, JSON_LIMIT_WALRUS_VERIFY, WALRUS_PACKAGE_ID } from "../config.js";
import { getWalrusClient, refreshWalrusClientIfStale, suiClient } from "../clients.js";
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
            const bytesBE = hex.match(/.{2}/g)!.map((b) => parseInt(b, 16));
            const bytesLE = new Uint8Array(bytesBE.reverse());
            blobIdStr = Buffer.from(bytesLE).toString("base64url");
        } catch {
            // Keep as-is if conversion fails.
        }
    }
    return blobIdStr;
}

/**
 * Canonical Sui address form (lowercase, 0x-prefixed, zero-padded) for
 * comparisons, or null for non-string/empty inputs. gRPC returns lowercase
 * addresses while journaled callers may send mixed-case hex, so exact-string
 * equality would strand otherwise-completed transfers.
 */
export function normalizedSuiAddressOrNull(value: unknown): string | null {
    if (typeof value !== "string" || value.length === 0) return null;
    return normalizeSuiAddress(value);
}

export function ownerMatchesRecipient(recipient: any, owner: string): boolean {
    const target = normalizedSuiAddressOrNull(owner);
    if (target === null) return false;
    if (typeof recipient === "string") return normalizedSuiAddressOrNull(recipient) === target;
    if (!recipient || typeof recipient !== "object") return false;
    return [recipient.AddressOwner, recipient.ObjectOwner, recipient.SingleOwner, recipient.owner].some(
        (candidate) => normalizedSuiAddressOrNull(candidate) === target
    );
}

export function isWalrusBlobObjectType(objectType: any, blobType: string): boolean {
    if (objectType === blobType) return true;
    if (typeof objectType !== "string") return false;
    const objectParts = objectType.split("::");
    const blobParts = blobType.split("::");
    return (
        objectParts.length === 3 &&
        blobParts.length === 3 &&
        objectParts[1] === blobParts[1] &&
        objectParts[2] === blobParts[2] &&
        objectParts[0].toLowerCase().replace(/^0x0+/, "0x") === blobParts[0].toLowerCase().replace(/^0x0+/, "0x")
    );
}

export function blobIdMatchesRequested(
    rawBlobId: string | number | null | undefined,
    requestedBlobIds?: ReadonlySet<string>
): boolean {
    if (!requestedBlobIds) return true;
    const blobId = blobIdFromRaw(rawBlobId);
    return blobId !== null && requestedBlobIds.has(blobId);
}

export function chainBlobIdFromRaw(rawBlobId: string | number | null | undefined): string | null {
    if (rawBlobId === null || rawBlobId === undefined || rawBlobId === "") return null;
    const value = String(rawBlobId);
    return /^\d+$/.test(value) ? blobIdFromInt(value) : blobIdFromRaw(value);
}

export function strictWalrusEpoch(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
        throw new Error(`[query-blobs] ${field} must be a u32`);
    }
    return value;
}

export function isVerifiedNonexistentSource(status: { type?: unknown }): boolean {
    return status.type === "nonexistent";
}

export async function readBlobObject(
    blobObjectId: string,
    include: { json?: true; previousTransaction?: true },
    client: Pick<typeof suiClient, "getObject"> = suiClient
) {
    try {
        return await client.getObject({ objectId: blobObjectId, include });
    } catch (error: unknown) {
        const message = errorMessage(error);
        const missingObject = message.match(/\bObject (0x[0-9a-f]{64}) not found\b/i)?.[1];
        // Transaction effects can reach one RPC replica before its created object.
        if (missingObject?.toLowerCase() === blobObjectId.toLowerCase()) {
            throw Object.assign(new Error(message), {
                code: "UNAVAILABLE",
                cause: error,
            });
        }
        throw error;
    }
}

type RawBlobObj = {
    objectId: string;
    rawBlobId: string | number | null;
    rawSize: string | number | null;
    deletable: boolean | null;
    storageEndEpoch: unknown;
    previousTransaction?: string | null;
    timestampMs?: string | null;
};

/**
 * gRPC path for step 1: listOwnedObjects filters by object type server-side
 * and `include.json` returns the flattened Move fields (blob_id included), so
 * one paginated call replaces both the queryTransactionBlocks candidate scan
 * and the multiGetObjects content fetch. Unlike the tx scan the order is
 * unspecified rather than newest-first, so `cap` bounds work, not recency.
 */
async function listBlobObjectsGrpc(
    owner: string,
    blobType: string,
    cap: number,
    requestedBlobIds?: ReadonlySet<string>
): Promise<RawBlobObj[]> {
    const out: RawBlobObj[] = [];
    let cursor: string | null = null;

    while (out.length < cap) {
        const page = await withRpcRetry<any>("[query-blobs] listOwnedObjects", () =>
            (suiClient as any).listOwnedObjects({
                owner,
                type: blobType,
                include: { json: true, previousTransaction: true },
                cursor: cursor ?? undefined,
                limit: 50,
            })
        );

        for (const obj of page?.objects ?? []) {
            if (typeof obj?.objectId !== "string") continue;
            const rawBlobId = obj.json?.blob_id ?? obj.json?.blobId ?? null;
            // Migration already knows the legacy blob IDs. Filter directly
            // from the Blob fields returned by listOwnedObjects so metadata is
            // fetched only for requested candidates, not every owned Blob.
            if (requestedBlobIds && !requestedBlobIds.has(chainBlobIdFromRaw(rawBlobId) ?? "")) continue;
            out.push({
                objectId: obj.objectId,
                rawBlobId,
                rawSize: obj.json?.size ?? null,
                deletable: typeof obj.json?.deletable === "boolean" ? obj.json.deletable : null,
                storageEndEpoch: obj.json?.storage?.end_epoch,
                previousTransaction: obj.previousTransaction,
            });
            if (out.length >= cap) break;
        }

        if (!page?.hasNextPage || !page?.cursor) break;
        cursor = page.cursor;
    }

    return out;
}

export function blobObjectMatchesRegistration(
    blob: Pick<RawBlobObj, "rawSize" | "deletable">,
    unencodedSize: number
): boolean {
    return blob.deletable === true && String(blob.rawSize) === String(unencodedSize);
}

type CompletionBlobAudit = {
    objectId: string;
    owner: string;
    size: number;
};

export function assertCompletionBlobObject(
    object: any,
    expected: CompletionBlobAudit & { blobId: string },
    currentEpoch: number
): number {
    const json = object?.json;
    if (!json) throw new Error(`Blob ${expected.objectId} has no JSON fields`);
    const blobType = `${WALRUS_PACKAGE_ID}::blob::Blob`;
    if (!isWalrusBlobObjectType(object.objectType ?? object.type, blobType)) {
        throw new Error(`object ${expected.objectId} is not a Walrus Blob`);
    }
    if (chainBlobIdFromRaw(json.blob_id ?? json.blobId) !== expected.blobId) {
        throw new Error(`Blob ${expected.objectId} does not contain ${expected.blobId}`);
    }
    if (String(json.size) !== String(expected.size)) {
        throw new Error(`Blob ${expected.objectId} size does not match the migration receipt`);
    }
    if (json.deletable !== true || json.certified_epoch === null || json.certified_epoch === undefined) {
        throw new Error(`Blob ${expected.objectId} is not a certified deletable Blob`);
    }
    if (!ownerMatchesRecipient(object.owner, expected.owner)) {
        throw new Error(`Blob ${expected.objectId} is not owned by ${expected.owner}`);
    }
    const endEpoch = strictWalrusEpoch(json.storage?.end_epoch, `Blob ${expected.objectId} storage end epoch`);
    if (endEpoch <= currentEpoch) {
        throw new Error(
            `Blob ${expected.objectId} expired at Walrus epoch ${endEpoch}; current epoch is ${currentEpoch}`
        );
    }
    return endEpoch;
}

export function assertCompletionBlobResponse(
    response: any,
    expected: CompletionBlobAudit & { blobId: string },
    currentEpoch: number
): number {
    if (!response?.object) {
        throw new Error(`Blob ${expected.objectId} is missing from the gRPC response`);
    }
    return assertCompletionBlobObject(response.object, expected, currentEpoch);
}

export async function findOwnedBlobObjects(
    owner: string,
    blobId: string,
    migrationJobId?: string
): Promise<RawBlobObj[]> {
    const blobType = `${WALRUS_PACKAGE_ID}::blob::Blob`;
    // gRPC owner filters are exact; canonicalize so mixed-case journaled
    // addresses still find their blobs.
    const blobs = await listBlobObjectsGrpc(normalizeSuiAddress(owner), blobType, Infinity, new Set([blobId]));
    if (!migrationJobId) return blobs;

    const tagged: RawBlobObj[] = [];
    for (const blob of blobs) {
        const entries = await fetchBlobMetadataEntries(blob.objectId);
        if (entries.some(({ key, value }) => key === "memwal_migration_job" && value === migrationJobId)) {
            tagged.push(blob);
        }
    }
    return tagged;
}

// Walrus's `Metadata` struct is `{ metadata: VecMap<String, String> }`;
// VecMap's BCS byte layout (struct { contents: vector<Entry<K, V>> }) is
// identical to bcs.map's vector-of-pairs, so this parses the dynamic field
// value bytes returned by gRPC getDynamicField.
const WALRUS_METADATA_BCS = bcs.struct("Metadata", {
    metadata: bcs.map(bcs.string(), bcs.string()),
});

// Dynamic field name b"metadata" as gRPC wants it: BCS bytes, not a JSON value.
const METADATA_FIELD_NAME_GRPC = {
    type: "vector<u8>",
    bcs: bcs
        .vector(bcs.u8())
        .serialize(Array.from(Buffer.from("metadata")))
        .toBytes(),
};

/**
 * Fetch the memwal_* metadata entries attached to a Blob object as key/value
 * pairs over gRPC. Returns [] when the blob has no metadata dynamic field.
 */
async function fetchBlobMetadataEntries(objectId: string): Promise<Array<{ key: string; value: string }>> {
    const dynField = await withRpcRetry<any>(`[query-blobs] getDynamicField ${objectId}`, () =>
        (suiClient as any).getDynamicField({
            parentId: objectId,
            name: METADATA_FIELD_NAME_GRPC,
        })
    );
    const valueBcs = dynField?.dynamicField?.value?.bcs;
    if (!valueBcs) return [];
    const parsed = WALRUS_METADATA_BCS.parse(valueBcs);
    return [...parsed.metadata.entries()].map(([key, value]) => ({
        key,
        value,
    }));
}

export function registerWalrusQueryRoute(app: Express): void {
    app.post("/walrus/verify-blob", express.json({ limit: JSON_LIMIT_WALRUS_VERIFY }), async (req, res) => {
        const { blobId, data, audit } = req.body;
        if (typeof blobId !== "string" || !blobId || typeof data !== "string" || !data) {
            return res.status(400).json({ error: "blobId and base64 data are required" });
        }

        let computedBlobId: string;
        try {
            computedBlobId = (
                await getWalrusClient().computeBlobMetadata({
                    bytes: Buffer.from(data, "base64"),
                })
            ).blobId;
        } catch (err: unknown) {
            const traceId = requestIdFor(req);
            const message = errorMessage(err);
            sidecarLog("error", "walrus_verify_blob_compute_failed", {
                requestId: traceId,
                error: message,
            });
            return res.status(503).json({
                error: message,
                code: "SHARED_SERVICE_UNAVAILABLE",
                traceId,
            });
        }

        if (audit === undefined) return res.json({ computedBlobId });
        if (
            !audit ||
            typeof audit.objectId !== "string" ||
            typeof audit.owner !== "string" ||
            !Number.isSafeInteger(audit.size) ||
            audit.size <= 0
        ) {
            return res.status(400).json({
                error: "audit requires objectId, owner, and a positive integer size",
            });
        }

        try {
            refreshWalrusClientIfStale(1_000);
            const systemState = await withRpcRetry("[verify-blob] Walrus systemState", () =>
                getWalrusClient().systemState()
            );
            const currentEpoch = strictWalrusEpoch(systemState?.committee?.epoch, "current Walrus epoch");
            const object = await withRpcRetry(`[verify-blob] Blob ${audit.objectId}`, () =>
                readBlobObject(audit.objectId, { json: true })
            );
            const storageEndEpoch = assertCompletionBlobResponse(object, { ...audit, blobId }, currentEpoch);
            return res.json({
                computedBlobId,
                currentEpoch,
                storageEndEpoch,
            });
        } catch (err: unknown) {
            const traceId = requestIdFor(req);
            const message = errorMessage(err);
            sidecarLog("error", "walrus_verify_blob_audit_failed", {
                requestId: traceId,
                error: message,
            });
            return res.status(422).json({ error: message, traceId });
        }
    });

    app.post("/walrus/query-blobs", express.json({ limit: JSON_LIMIT_METADATA }), async (req, res) => {
        try {
            const { owner: rawOwner, namespace, packageId, limit, blobIds, includeStorageLease } = req.body;
            if (!rawOwner) {
                return res.status(400).json({ error: "Missing required field: owner" });
            }
            if (includeStorageLease !== undefined && typeof includeStorageLease !== "boolean") {
                return res.status(400).json({
                    error: "includeStorageLease must be a boolean",
                });
            }
            if (includeStorageLease === true && (!Array.isArray(blobIds) || blobIds.length === 0)) {
                return res.status(400).json({
                    error: "includeStorageLease requires blobIds",
                });
            }
            // Canonicalize hex owners; leave anything else untouched so the
            // downstream error behavior for malformed input is unchanged.
            const owner =
                typeof rawOwner === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(rawOwner)
                ? normalizeSuiAddress(rawOwner)
                : rawOwner;
            const desiredMatches = Math.max(1, Math.min(Number(limit) || 0, 500));
            const useRecentTxPath = Number.isFinite(Number(limit)) && Number(limit) > 0;
            const requestedBlobIds = Array.isArray(blobIds)
                ? new Set(blobIds.filter((value): value is string => typeof value === "string" && value.length > 0))
                : undefined;

            // Walrus Blob type (derived from env-driven WALRUS_PACKAGE_ID)
            const WALRUS_BLOB_TYPE = `${WALRUS_PACKAGE_ID}::blob::Blob`;

            // Step 1: Collect raw blob objects over gRPC. Restore passes
            // `limit`; cap work when no exact blob IDs were supplied.
            const cap =
                useRecentTxPath && !requestedBlobIds ? Math.max(1, Math.min(desiredMatches * 5, 100)) : Infinity;
            const rawObjs = await listBlobObjectsGrpc(owner, WALRUS_BLOB_TYPE, cap, requestedBlobIds);
            if (includeStorageLease === true) {
                // Expiry is a terminal migration decision. Do not use the
                // upload client's normal 30-minute metadata cache here.
                refreshWalrusClientIfStale(1_000);
                const systemState = await withRpcRetry("[query-blobs] Walrus systemState", () =>
                    getWalrusClient().systemState()
                );
                const currentEpoch = strictWalrusEpoch(systemState?.committee?.epoch, "current Walrus epoch");
                const blobs = rawObjs.flatMap((obj) => {
                    const blobId = chainBlobIdFromRaw(obj.rawBlobId);
                    return blobId
                        ? [
                              {
                            blobId,
                            objectId: obj.objectId,
                            storageEndEpoch: strictWalrusEpoch(
                                obj.storageEndEpoch,
                                      `Blob ${obj.objectId} storage end epoch`
                            ),
                              },
                          ]
                        : [];
                });
                const leasedBlobIds = new Set(blobs.map((blob) => blob.blobId));
                const missingBlobIds = [...requestedBlobIds!].filter((blobId) => !leasedBlobIds.has(blobId));
                const nonexistentBlobIds = (
                    await mapConcurrent(missingBlobIds, 2, async (blobId) => {
                        const status = await withRpcRetry(
                            `[query-blobs] verified Walrus status ${blobId}`,
                            () =>
                                getWalrusClient().getVerifiedBlobStatus({
                                blobId,
                                signal: AbortSignal.timeout(30_000),
                            }),
                            2
                        );
                        return isVerifiedNonexistentSource(status) ? blobId : null;
                    })
                ).filter((blobId): blobId is string => blobId !== null);
                console.log(
                    `[query-blobs] returning ${blobs.length} source leases and ${nonexistentBlobIds.length} verified nonexistent blobs for owner=${owner} currentEpoch=${currentEpoch}`
                );
                return res.json({
                    blobs,
                    total: blobs.length,
                    currentEpoch,
                    nonexistentBlobIds,
                });
            }
            console.log(
                `[query-blobs] found ${rawObjs.length} raw blob objects for owner=${owner} via gRPC` +
                (requestedBlobIds
                    ? ` (requested=${requestedBlobIds.size})`
                        : useRecentTxPath
                        ? ` (candidateCap=${cap})`
                        : "")
            );

            // Step 2: Fetch metadata for each blob with bounded concurrency
            // to avoid overwhelming Sui RPC and hitting 429 rate limits.
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
                    for (const { key, value } of await fetchBlobMetadataEntries(obj.objectId)) {
                        if (key === "memwal_namespace") blobNamespace = value;
                        if (key === "memwal_owner") blobOwner = value;
                        if (key === "memwal_package_id") blobPackageId = value;
                        if (key === "memwal_agent_id") blobAgentId = value;
                    }
                } catch {
                    // No dynamic field = no metadata = use defaults
                }

                return {
                    ...obj,
                    blobNamespace,
                    blobOwner,
                    blobPackageId,
                    blobAgentId,
                };
            });

            // Step 3: Filter + convert blob IDs
            const blobs: {
                blobId: string;
                objectId: string;
                namespace: string;
                packageId: string;
                agentId: string;
            }[] = [];

            for (const meta of metas) {
                // Filter by namespace if specified
                if (namespace && meta.blobNamespace !== namespace) continue;
                // Filter by packageId if specified
                if (packageId && meta.blobPackageId !== packageId) continue;

                if (meta.rawBlobId) {
                    const blobIdStr = blobIdFromRaw(meta.rawBlobId);
                    if (blobIdStr) {
                        blobs.push({
                            blobId: blobIdStr,
                            objectId: meta.objectId,
                            namespace: meta.blobNamespace,
                            packageId: meta.blobPackageId,
                            agentId: meta.blobAgentId,
                        });
                    }
                }
            }

            console.log(
                `[query-blobs] returning ${blobs.length} blobs (filtered from ${
                    rawObjs.length
                }) for owner=${owner} ns=${namespace || "*"}`
            );
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
