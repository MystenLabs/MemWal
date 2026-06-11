/**
 * POST /walrus/upload — encode, register, upload, certify and hand over a
 * Walrus blob: { data, keyIndex, owner?, namespace?, ... } → { blobId, objectId }.
 */

import express, { type Express } from "express";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
    isWalrusBlobObjectMissingFromEffects,
    isWalrusPackageVersionMismatch,
    isWalrusReferencedObjectStale,
} from "../../walrus-error-detection.js";
import {
    clampWalrusEpochs,
    DEFAULT_WALRUS_EPOCHS,
    ENOKI_API_KEY,
    ENOKI_FALLBACK_TO_DIRECT_SIGN,
    SERVER_SUI_PRIVATE_KEYS,
    WALRUS_DEP_VERSION,
    WALRUS_UPLOAD_EFFECTS_RETRY_DELAYS_MS,
    JSON_LIMIT_WALRUS_UPLOAD,
} from "../config.js";
import {
    fetchWalrusSystemVersion,
    getSuiBalanceMist,
    getUploadRelayTipAddress,
    getWalrusClient,
    refreshWalrusClient,
    refreshWalrusClientIfStale,
    suiClient,
} from "../clients.js";
import {
    acquireWalrusUploadSlots,
    walrusUploadLimitSnapshot,
    WalrusUploadLimitError,
} from "../concurrency.js";
import { requestIdFor, sanitizeRequestId, sidecarLog } from "../log.js";
import { sidecarStartedAtMs, sidecarStateSnapshot } from "../state.js";
import {
    dedupeAddresses,
    errorMessage,
    parseWalrusKeySlot,
    shortAddress,
    sleep,
    truncateForLog,
} from "../util.js";
import { isMoveAbortBalanceSplit } from "../enoki.js";
import {
    patchGasCoinIntents,
    submitRebuildableWalletTransaction,
    submitWalletTransaction,
} from "../wallet.js";
import { extractBlobObjectId, setMetadataAndTransferBlobs } from "../blob-metadata.js";

async function uploadWalrusBlobWithEffectsRetry(
    flow: any,
    registerDigest: string,
    context: {
        traceId: string;
        jobId?: string | null;
        keyIndex: number;
    },
): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            await flow.upload({ digest: registerDigest });
            return;
        } catch (err: unknown) {
            const message = errorMessage(err);
            const retryDelayMs = WALRUS_UPLOAD_EFFECTS_RETRY_DELAYS_MS[attempt - 1];
            if (!retryDelayMs || !isWalrusBlobObjectMissingFromEffects(message)) {
                throw err;
            }

            console.warn(`[walrus/upload] [${context.traceId}] upload_blob_retry ${JSON.stringify({
                jobId: context.jobId,
                keyIndex: context.keyIndex,
                attempt,
                nextAttempt: attempt + 1,
                retryDelayMs,
                registerDigest,
                message: truncateForLog(message),
            })}`);
            await sleep(retryDelayMs);
        }
    }
}

export function registerWalrusUploadRoute(app: Express): void {
    // /walrus/upload receives a base64-encoded SEAL ciphertext which can
    // be up to ~87 KiB per 64 KiB plaintext (SEAL overhead + base64 ≈ 1.37×).
    // 10 MB sits well above any realistic single-memory upload size.
    app.post("/walrus/upload", express.json({ limit: JSON_LIMIT_WALRUS_UPLOAD }), async (req, res) => {
        const traceId = requestIdFor(req);
        let phase = "receive";
        let keyIndexForLog: unknown;
        let ownerForLog: unknown;
        let namespaceForLog: unknown;
        let jobIdForLog: string | null = null;
        let signerAddressForLog: string | undefined;
        let blobBytesForLog: number | undefined;
        let releaseWalrusUploadSlots: (() => void) | undefined;
        const phaseLogContext = (): Record<string, unknown> => ({
            jobId: jobIdForLog,
            keyIndex: keyIndexForLog,
            owner: shortAddress(ownerForLog),
            namespace: typeof namespaceForLog === "string" && namespaceForLog ? namespaceForLog : "default",
        });
        const timedPhase = async <T>(
            nextPhase: string,
            action: () => Promise<T>,
            resultFields?: (result: T) => Record<string, unknown>,
        ): Promise<T> => {
            phase = nextPhase;
            const startedAt = Date.now();
            try {
                const result = await action();
                console.log(`[walrus/upload] [${traceId}] phase_ok ${JSON.stringify({
                    ...phaseLogContext(),
                    phase: nextPhase,
                    durationMs: Date.now() - startedAt,
                    ...(resultFields ? resultFields(result) : {}),
                })}`);
                return result;
            } catch (phaseErr: unknown) {
                console.warn(`[walrus/upload] [${traceId}] phase_failed ${JSON.stringify({
                    ...phaseLogContext(),
                    phase: nextPhase,
                    durationMs: Date.now() - startedAt,
                    message: truncateForLog(errorMessage(phaseErr)),
                })}`);
                throw phaseErr;
            }
        };
        try {
            const {
                data,
                keyIndex,
                jobId: rawJobId,
                owner,
                namespace,
                packageId,
                agentId,
                deferTransfer = false,
                epochs: rawEpochs = DEFAULT_WALRUS_EPOCHS,
            } = req.body;
            keyIndexForLog = keyIndex;
            ownerForLog = owner;
            namespaceForLog = namespace;
            jobIdForLog = sanitizeRequestId(rawJobId);
            // Cap epochs to prevent accidental large storage purchases.
            const epochs = clampWalrusEpochs(rawEpochs);

            if (!data || keyIndex === undefined) {
                return res.status(400).json({ error: "Missing required fields: data, keyIndex" });
            }

            const keySlot = parseWalrusKeySlot(keyIndex);
            if (keySlot === null) {
                return res.status(400).json({ error: `Invalid keyIndex: ${keyIndex}` });
            }
            keyIndexForLog = keySlot;

            const privateKey = SERVER_SUI_PRIVATE_KEYS[keySlot];
            if (!privateKey) {
                return res.status(400).json({ error: `Invalid keyIndex: ${keySlot}` });
            }

            // Validate packageId resembles a Sui address to prevent injection
            if (packageId && !/^0x[0-9a-fA-F]{1,64}$/.test(packageId)) {
                return res.status(400).json({ error: "Invalid packageId format" });
            }

            // Validate owner address format
            if (owner && !/^0x[0-9a-fA-F]{64}$/.test(owner)) {
                return res.status(400).json({ error: "Invalid owner address format" });
            }

            phase = "acquire_limit";
            releaseWalrusUploadSlots = await acquireWalrusUploadSlots(keySlot, traceId, jobIdForLog);

            // Decode signer
            phase = "decode_signer";
            const { secretKey } = decodeSuiPrivateKey(privateKey);
            const signer = Ed25519Keypair.fromSecretKey(secretKey);

            const signerAddress = signer.toSuiAddress();
            signerAddressForLog = signerAddress;
            const blobData = new Uint8Array(Buffer.from(data, "base64"));
            blobBytesForLog = blobData.length;
            refreshWalrusClientIfStale();
            const signerSuiBalanceMist = await getSuiBalanceMist(signerAddress);
            console.log(`[walrus/upload] [${traceId}] begin ${JSON.stringify({
                jobId: jobIdForLog,
                keyIndex: keySlot,
                signer: shortAddress(signerAddress),
                owner: shortAddress(owner),
                namespace: namespace || "default",
                bytes: blobData.length,
                epochs,
                deferTransfer,
                signerSuiBalanceMist,
                enokiEnabled: !!ENOKI_API_KEY,
                fallbackToDirectSign: ENOKI_FALLBACK_TO_DIRECT_SIGN,
                state: sidecarStateSnapshot(),
            })}`);

            phase = "encode";
            const flow = getWalrusClient().writeBlobFlow({ blob: blobData });
            await flow.encode();

            phase = "register_build";
            const registerTx = flow.register({
                epochs,
                // Server owns the blob initially (needed for certify step)
                owner: signerAddress,
                deletable: true,
                // Store namespace + owner as on-chain metadata (queryable for restore)
                attributes: {
                    ...(namespace ? { memwal_namespace: namespace } : {}),
                    ...(owner ? { memwal_owner: owner } : {}),
                    ...(packageId ? { memwal_package_id: packageId } : {}),
                },
            });

            // Patch: convert GasCoin intents → sender's SUI coins.
            // Enoki rejects GasCoin as tx argument, but relay requires the tip.
            // After patching, signer pays tip from own SUI; Enoki sponsors gas.
            patchGasCoinIntents(registerTx);
            const tipRecipient = await getUploadRelayTipAddress();
            const registerAllowedAddresses = dedupeAddresses([signerAddress, tipRecipient]);
            phase = "register_sponsor";
            console.log(`[walrus/upload] [${traceId}] register_sponsor ${JSON.stringify({
                jobId: jobIdForLog,
                keyIndex: keySlot,
                signer: shortAddress(signerAddress),
                tipRecipient: shortAddress(tipRecipient),
                allowedAddresses: registerAllowedAddresses.map(shortAddress),
            })}`);
            const registerDigest = await timedPhase(
                "register_sponsor",
                () => submitWalletTransaction(
                    registerTx,
                    signer,
                    registerAllowedAddresses,
                ),
                (digest) => ({ digest }),
            );
            await timedPhase(
                "register_wait",
                () => suiClient.waitForTransaction({ digest: registerDigest }),
                () => ({ digest: registerDigest }),
            );

            await timedPhase(
                "upload_blob",
                () => uploadWalrusBlobWithEffectsRetry(
                    flow,
                    registerDigest,
                    { traceId, jobId: jobIdForLog, keyIndex: keySlot },
                ),
                () => ({ registerDigest }),
            );

            phase = "certify_build";
            const certifyDigest = await timedPhase(
                "certify_sponsor",
                () => submitRebuildableWalletTransaction(
                    "certify_sponsor",
                    () => flow.certify(),
                    signer,
                    undefined,
                    { traceId, jobId: jobIdForLog, keyIndex: keySlot },
                ),
                (digest) => ({ digest }),
            );
            await timedPhase(
                "certify_wait",
                () => suiClient.waitForTransaction({ digest: certifyDigest }),
                () => ({ digest: certifyDigest }),
            );

            const blob = await timedPhase("get_blob", () => flow.getBlob());

            const blobObjectId = extractBlobObjectId(blob);

            // Set on-chain metadata + transfer blob to user in a single transaction
            if (!deferTransfer && owner && owner !== signerAddress && blobObjectId) {
                try {
                    const metadataTransferDigest = await timedPhase(
                        "metadata_transfer",
                        () => setMetadataAndTransferBlobs(
                            signer,
                            [{ blobObjectId, namespace }],
                            owner,
                            packageId,
                            agentId,
                            { traceId, jobId: jobIdForLog, keyIndex: keySlot },
                        ),
                        (digest) => ({ digest, blobObjectId }),
                    );
                    console.log(`[walrus/upload] [${traceId}] metadata_transfer_ok ${JSON.stringify({
                        jobId: jobIdForLog,
                        digest: metadataTransferDigest,
                        blobObjectId,
                        owner: shortAddress(owner),
                        namespace: namespace || "default",
                    })}`);
                } catch (metaErr: any) {
                    // Previously the metadata-set + transfer failure was swallowed
                    // and /walrus/upload returned 200 with the blob_id, leaving the blob
                    // owned by the server wallet and the client unable to observe the
                    // failure. We still can't delete the blob from Walrus (no delete
                    // primitive after certify), so at minimum we log loudly AND return
                    // 500 so the caller can react (retry / mark stored-but-not-owned).
                    console.error(
                        `[walrus/upload] [${traceId}] metadata+transfer FAILED for blob_object=${blobObjectId} ` +
                        `jobId=${jobIdForLog ?? "-"} ns=${namespace || "default"}: ${metaErr?.message || metaErr}`
                    );
                    return res.status(500).json({
                        error: "Blob uploaded but metadata/transfer to owner failed",
                        jobId: jobIdForLog,
                        blobId: blob.blobId,
                        objectId: blobObjectId,
                        transferStatus: "failed",
                    });
                }
            }

            phase = "respond";
            console.log(`[walrus/upload] [${traceId}] ok ${JSON.stringify({
                jobId: jobIdForLog,
                blobId: blob.blobId,
                objectId: blobObjectId,
                transferStatus: deferTransfer ? "deferred" : "ok",
                keyIndex: keySlot,
                bytes: blobBytesForLog,
            })}`);
            res.json({
                blobId: blob.blobId,
                objectId: blobObjectId,
                transferStatus: deferTransfer ? "deferred" : "ok",
            });
        } catch (err: any) {
            const message = err?.message || String(err);
            if (err instanceof WalrusUploadLimitError) {
                console.warn(`[walrus/upload] [${traceId}] limit_timeout ${JSON.stringify({
                    jobId: jobIdForLog,
                    phase,
                    keyIndex: keyIndexForLog,
                    owner: shortAddress(ownerForLog),
                    namespace: namespaceForLog || "default",
                    message,
                    limits: walrusUploadLimitSnapshot(
                        typeof keyIndexForLog === "number" ? keyIndexForLog : undefined,
                    ),
                    state: sidecarStateSnapshot(),
                })}`);
                return res.status(503).json({ error: message, traceId, jobId: jobIdForLog });
            }
            if (phase === "register_sponsor" && isMoveAbortBalanceSplit(message)) {
                refreshWalrusClient("register_sponsor_balance_split");
            }
            if (isWalrusPackageVersionMismatch(message)) {
                // EWrongVersion is phase-independent: can fire from register / upload / certify
                // any time the Walrus system package gets upgraded on-chain after this sidecar
                // booted. Refresh the cached client so the next Apalis retry picks up the new
                // package metadata; no in-handler retry needed.
                const versionBefore = await fetchWalrusSystemVersion();
                refreshWalrusClient("walrus_package_version_mismatch");
                const versionAfter = await fetchWalrusSystemVersion();
                console.warn(
                    `[walrus/client] EWrongVersion detected — Walrus on-chain package upgraded. ` +
                    `Action: client refreshed, Apalis will retry against new package metadata. ` +
                    `Walrus system version: before=${versionBefore ?? "unknown"} after=${versionAfter ?? "unknown"}. ` +
                    `Sidecar @mysten/walrus dep=${WALRUS_DEP_VERSION}. ` +
                    `traceId=${traceId} jobId=${jobIdForLog ?? "-"}`
                );
            } else if (isWalrusReferencedObjectStale(message)) {
                refreshWalrusClient("walrus_referenced_object_stale");
                console.warn(
                    `[walrus/client] referenced object stale during ${phase}; ` +
                    `Action: client refreshed, Apalis will retry with a fresh flow. ` +
                    `traceId=${traceId} jobId=${jobIdForLog ?? "-"}`
                );
            }
            const postFailureSignerSuiBalanceMist = signerAddressForLog
                ? await getSuiBalanceMist(signerAddressForLog)
                : null;
            console.error(`[walrus/upload] [${traceId}] failed ${JSON.stringify({
                jobId: jobIdForLog,
                phase,
                keyIndex: keyIndexForLog,
                signer: shortAddress(signerAddressForLog),
                owner: shortAddress(ownerForLog),
                namespace: namespaceForLog || "default",
                bytes: blobBytesForLog,
                uptimeMs: Date.now() - sidecarStartedAtMs,
                postFailureSignerSuiBalanceMist,
                message: truncateForLog(message),
                hasMoveAbort: /moveabort/i.test(message),
                hasBalanceSplit: /balance.*split|split.*balance/i.test(message),
                state: sidecarStateSnapshot(),
            })}`, err);
            sidecarLog("error", "walrus_upload_failed", {
                requestId: traceId,
                jobId: jobIdForLog,
                phase,
                error: message,
            });
            res.status(500).json({ error: message, traceId, jobId: jobIdForLog });
        } finally {
            releaseWalrusUploadSlots?.();
        }
    });
}
