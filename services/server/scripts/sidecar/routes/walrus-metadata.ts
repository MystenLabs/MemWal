/**
 * POST /walrus/set-metadata-batch — stamp memwal_* metadata onto already
 * uploaded blobs and transfer them to the owner in one transaction.
 * POST /walrus/set-metadata — durable single-blob migration variant.
 */

import express, { type Express } from "express";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import {
    JSON_LIMIT_WALRUS_UPLOAD,
    SEAL_POLICY_PACKAGE_ID,
    SERVER_SUI_PRIVATE_KEYS,
    SIDECAR_ENABLE_LEGACY_SEAL_ABI,
} from "../config.js";
import { acquireWalrusUploadSlots, WalrusUploadLimitError } from "../concurrency.js";
import { requestIdFor, sanitizeRequestId, sidecarLog } from "../log.js";
import { classifyDurableSideEffectError, withRpcRetry } from "../retry/rpc.js";
import { delayInjectedResponseOnce, errorMessage, parseWalrusKeySlot } from "../util.js";
import {
    InvalidSealPersistenceFenceError,
    parseSealPersistenceFence,
    setMetadataAndTransferBlobs,
    type MetadataTransferBlob,
} from "../blob-metadata.js";
import { DURABLE_WALLET_FALLBACK_POLICY } from "../wallet.js";
import { ownerMatchesRecipient, readBlobObject } from "./walrus-query.js";
import { assertUploadExecutionIdentity, parseUploadExecutionIdentity } from "./health.js";

export function metadataReceiptAlreadyApplied(
    reconcileOnly: boolean,
    currentOwner: unknown,
    targetOwner: string
): boolean {
    return reconcileOnly && ownerMatchesRecipient(currentOwner, targetOwner);
}

function registerWalrusMetadataBatchRoute(app: Express): void {
    app.post("/walrus/set-metadata-batch", express.json({ limit: JSON_LIMIT_WALRUS_UPLOAD }), async (req, res) => {
        const traceId = requestIdFor(req);
        let releaseWalrusUploadSlots: (() => void) | undefined;
        try {
            const { blobs, owner, packageId, policyPackageId, registryId, accountId, sealAbi, agentId, keyIndex } =
                req.body;
            if (!Array.isArray(blobs) || blobs.length === 0 || !owner || keyIndex === undefined) {
                return res.status(400).json({
                    error: "Missing required fields: blobs, owner, keyIndex",
                });
            }
            if (blobs.length > 20) {
                return res.status(400).json({ error: "Too many blobs in batch" });
            }
            if (!/^0x[0-9a-fA-F]{64}$/.test(owner)) {
                return res.status(400).json({ error: "Invalid owner address format" });
            }
            if (packageId && !/^0x[0-9a-fA-F]{1,64}$/.test(packageId)) {
                return res.status(400).json({ error: "Invalid packageId format" });
            }
            // gRPC and signers report lowercase addresses; canonicalize the
            // journaled owner so on-chain values always use one form.
            const targetOwner = normalizeSuiAddress(owner);

            const keySlot = parseWalrusKeySlot(keyIndex);
            if (keySlot === null) {
                return res.status(400).json({ error: `Invalid keyIndex: ${keyIndex}` });
            }
            const privateKey = SERVER_SUI_PRIVATE_KEYS[keySlot];
            if (!privateKey) {
                return res.status(400).json({ error: `Invalid keyIndex: ${keySlot}` });
            }

            const normalized: MetadataTransferBlob[] = blobs.map((blob: any, idx: number) => {
                const blobObjectId = blob?.blobObjectId;
                if (typeof blobObjectId !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(blobObjectId)) {
                    throw new Error(`Invalid blobs[${idx}].blobObjectId`);
                }
                const namespace =
                    typeof blob?.namespace === "string" && blob.namespace.length > 0 ? blob.namespace : "default";
                return {
                    blobObjectId,
                    namespace,
                    sealFence: parseSealPersistenceFence(
                        {
                            sealAbi,
                            accountId,
                            registryId,
                            policyPackageId,
                            data: blob?.encryptedData,
                        },
                        packageId,
                        {
                            allowLegacySealAbi: SIDECAR_ENABLE_LEGACY_SEAL_ABI,
                            policyPackageId: SEAL_POLICY_PACKAGE_ID,
                        }
                    ),
                };
            });

            // This submits a paid wallet transaction, so it must hold the same
            // per-wallet/global slots as the durable routes: an unslotted
            // submission racing /walrus/set-metadata or /walrus/upload-step-v3 on
            // the same keyIndex can equivocate the wallet's owned objects.
            releaseWalrusUploadSlots = await acquireWalrusUploadSlots(keySlot, traceId);
            const { secretKey } = decodeSuiPrivateKey(privateKey);
            const signer = Ed25519Keypair.fromSecretKey(secretKey);
            const digest = await setMetadataAndTransferBlobs(signer, normalized, targetOwner, packageId, agentId);
            console.log(`[walrus/set-metadata-batch] transferred ${normalized.length} blobs to owner`);
            res.json({ transferred: normalized.length, digest });
        } catch (err: any) {
            const message = errorMessage(err);
            if (err instanceof WalrusUploadLimitError) {
                console.warn(`[walrus/set-metadata-batch] [${traceId}] limit_timeout ${message}`);
                return res.status(503).json({ error: message, traceId });
            }
            if (err instanceof InvalidSealPersistenceFenceError) {
                return res.status(400).json({ error: message, traceId });
            }
            sidecarLog("error", "walrus_set_metadata_batch_failed", {
                requestId: traceId,
                error: message,
            });
            res.status(500).json({ error: message, traceId });
        } finally {
            releaseWalrusUploadSlots?.();
        }
    });
}

export function registerWalrusMetadataRoute(app: Express, requireDurableIdentity = false): void {
    // Single-blob endpoint used by durable migration writers.
    app.post("/walrus/set-metadata", express.json({ limit: JSON_LIMIT_WALRUS_UPLOAD }), async (req, res) => {
        const traceId = requestIdFor(req);
        let releaseWalrusUploadSlots: (() => void) | undefined;
        let phaseCanSubmitSideEffect = false;
        let submissionStarted = false;
        try {
            const {
                blobObjectId,
                owner,
                namespace,
                packageId,
                agentId,
                keyIndex,
                jobId,
                walletAddress,
                uploadExecutionIdentity: rawExecutionIdentity,
                reconcileOnly = false,
                data,
            } = req.body;
            const durableJobId = sanitizeRequestId(jobId);
            const uploadExecutionIdentity = parseUploadExecutionIdentity(rawExecutionIdentity);
            phaseCanSubmitSideEffect = !reconcileOnly;
            if (!blobObjectId || !owner || keyIndex === undefined) {
                return res.status(400).json({
                    error: "Missing required fields: blobObjectId, owner, keyIndex",
                });
            }
            if (requireDurableIdentity && (!durableJobId || !walletAddress || !uploadExecutionIdentity)) {
                return res.status(400).json({
                    error: "Missing required durable fields: jobId, walletAddress, uploadExecutionIdentity",
                });
            }
            if (rawExecutionIdentity !== undefined && !uploadExecutionIdentity) {
                return res.status(400).json({ error: "Invalid uploadExecutionIdentity" });
            }
            if (!/^0x[0-9a-fA-F]{1,64}$/.test(blobObjectId)) {
                return res.status(400).json({ error: "Invalid blobObjectId format" });
            }
            if (!/^0x[0-9a-fA-F]{64}$/.test(owner)) {
                return res.status(400).json({ error: "Invalid owner address format" });
            }
            if (packageId && !/^0x[0-9a-fA-F]{1,64}$/.test(packageId)) {
                return res.status(400).json({ error: "Invalid packageId format" });
            }
            if (walletAddress && !/^0x[0-9a-fA-F]{64}$/.test(walletAddress)) {
                return res.status(400).json({ error: "Invalid walletAddress format" });
            }
            // The journal may carry mixed-case hex while gRPC and signers
            // report lowercase; canonicalize before any equality check so an
            // uppercase journaled owner cannot strand a COMPLETED transfer in
            // a permanent BLOB_OWNER_MISMATCH.
            const targetOwner = normalizeSuiAddress(owner);
            const sealFence = parseSealPersistenceFence(
                { ...req.body, data },
                packageId,
                {
                    allowLegacySealAbi: SIDECAR_ENABLE_LEGACY_SEAL_ABI,
                    policyPackageId: SEAL_POLICY_PACKAGE_ID,
                }
            );
            const journaledWalletAddress = walletAddress ? normalizeSuiAddress(walletAddress) : undefined;

            const keySlot = parseWalrusKeySlot(keyIndex);
            if (keySlot === null) {
                return res.status(400).json({ error: `Invalid keyIndex: ${keyIndex}` });
            }
            const privateKey = SERVER_SUI_PRIVATE_KEYS[keySlot];
            if (!privateKey) {
                return res.status(400).json({ error: `Invalid keyIndex: ${keySlot}` });
            }
            if (uploadExecutionIdentity) {
                await assertUploadExecutionIdentity(uploadExecutionIdentity);
            }
            releaseWalrusUploadSlots = await acquireWalrusUploadSlots(keySlot, traceId, durableJobId);
            const { secretKey } = decodeSuiPrivateKey(privateKey);
            const signer = Ed25519Keypair.fromSecretKey(secretKey);
            const signerAddress = signer.toSuiAddress();
            if (journaledWalletAddress && signerAddress !== journaledWalletAddress) {
                return res.status(409).json({
                    error: "keyIndex no longer maps to the journaled wallet",
                    code: "WALLET_MAPPING_MISMATCH",
                    expectedWalletAddress: journaledWalletAddress,
                    actualWalletAddress: signerAddress,
                });
            }
            const object = await withRpcRetry<any>(`[walrus/set-metadata] getObject ${blobObjectId}`, () =>
                readBlobObject(blobObjectId, {
                    previousTransaction: true,
                })
            );
            const currentOwner = object?.object?.owner;
            if (metadataReceiptAlreadyApplied(reconcileOnly, currentOwner, targetOwner)) {
                return res.json({
                    transferred: 0,
                    digest: object?.object?.previousTransaction ?? null,
                    objectId: blobObjectId,
                    transferStatus: "already_transferred",
                });
            }
            if (!ownerMatchesRecipient(currentOwner, signerAddress)) {
                return res.status(409).json({
                    error: "Blob is not owned by the writer or target owner",
                    code: "BLOB_OWNER_MISMATCH",
                    objectId: blobObjectId,
                });
            }
            if (reconcileOnly) {
                return res.status(409).json({
                    error: "Blob is still writer-owned after an ambiguous metadata phase",
                    code: "AMBIGUOUS_METADATA_NOT_FOUND",
                    objectId: blobObjectId,
                });
            }
            const digest = await setMetadataAndTransferBlobs(
                signer,
                [
                    {
                        blobObjectId,
                        namespace: namespace || "default",
                        sealFence,
                    },
                ],
                targetOwner,
                packageId,
                agentId,
                { traceId, jobId: durableJobId, keyIndex: keySlot },
                DURABLE_WALLET_FALLBACK_POLICY,
                () => {
                    submissionStarted = true;
                }
            );
            await delayInjectedResponseOnce(true, durableJobId || traceId);
            res.json({
                transferred: 1,
                digest,
                objectId: blobObjectId,
                transferStatus: "ok",
            });
        } catch (err: any) {
            const message = errorMessage(err);
            if (err instanceof InvalidSealPersistenceFenceError) {
                return res.status(400).json({ error: message, traceId });
            }
            sidecarLog("error", "walrus_set_metadata_failed", {
                requestId: traceId,
                error: message,
            });
            const durableError = classifyDurableSideEffectError(err, phaseCanSubmitSideEffect, submissionStarted);
            if (durableError) {
                const status = durableError.code === "DURABLE_SIDE_EFFECT_VERIFY_FAILED" ? 422 : 503;
                return res.status(status).json({
                    error: message,
                    ...durableError,
                    traceId,
                });
            }
            res.status(500).json({ error: message, traceId });
        } finally {
            releaseWalrusUploadSlots?.();
        }
    });
}

export function registerWalrusMetadataRoutes(app: Express): void {
    registerWalrusMetadataBatchRoute(app);
    registerWalrusMetadataRoute(app);
}
