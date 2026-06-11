/**
 * POST /walrus/set-metadata-batch — stamp memwal_* metadata onto already
 * uploaded blobs and transfer them to the owner in one transaction.
 * POST /walrus/set-metadata — legacy single-blob variant kept for older
 * queued jobs.
 */

import express, { type Express } from "express";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SERVER_SUI_PRIVATE_KEYS } from "../config.js";
import { requestIdFor, sidecarLog } from "../log.js";
import { errorMessage } from "../util.js";
import { setMetadataAndTransferBlobs, type MetadataTransferBlob } from "../blob-metadata.js";

export function registerWalrusMetadataRoutes(app: Express): void {
    app.post("/walrus/set-metadata-batch", express.json({ limit: "1mb" }), async (req, res) => {
        try {
            const { blobs, owner, packageId, agentId, keyIndex } = req.body;
            if (!Array.isArray(blobs) || blobs.length === 0 || !owner || keyIndex === undefined) {
                return res.status(400).json({ error: "Missing required fields: blobs, owner, keyIndex" });
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

            const privateKey = SERVER_SUI_PRIVATE_KEYS[keyIndex];
            if (!privateKey) {
                return res.status(400).json({ error: `Invalid keyIndex: ${keyIndex}` });
            }

            const normalized: MetadataTransferBlob[] = blobs.map((blob: any, idx: number) => {
                const blobObjectId = blob?.blobObjectId;
                if (typeof blobObjectId !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(blobObjectId)) {
                    throw new Error(`Invalid blobs[${idx}].blobObjectId`);
                }
                const namespace = typeof blob?.namespace === "string" && blob.namespace.length > 0
                    ? blob.namespace
                    : "default";
                return { blobObjectId, namespace };
            });

            const { secretKey } = decodeSuiPrivateKey(privateKey);
            const signer = Ed25519Keypair.fromSecretKey(secretKey);
            const digest = await setMetadataAndTransferBlobs(signer, normalized, owner, packageId, agentId);
            console.log(`[walrus/set-metadata-batch] transferred ${normalized.length} blobs to owner`);
            res.json({ transferred: normalized.length, digest });
        } catch (err: any) {
            const traceId = requestIdFor(req);
            const message = errorMessage(err);
            sidecarLog("error", "walrus_set_metadata_batch_failed", {
                requestId: traceId,
                error: message,
            });
            res.status(500).json({ error: message, traceId });
        }
    });

    // Legacy single-blob endpoint kept for older queued jobs.
    app.post("/walrus/set-metadata", express.json({ limit: "128kb" }), async (req, res) => {
        try {
            const { blobObjectId, owner, namespace, packageId, agentId, keyIndex } = req.body;
            if (!blobObjectId || !owner || keyIndex === undefined) {
                return res.status(400).json({ error: "Missing required fields: blobObjectId, owner, keyIndex" });
            }

            const privateKey = SERVER_SUI_PRIVATE_KEYS[keyIndex];
            if (!privateKey) {
                return res.status(400).json({ error: `Invalid keyIndex: ${keyIndex}` });
            }
            const { secretKey } = decodeSuiPrivateKey(privateKey);
            const signer = Ed25519Keypair.fromSecretKey(secretKey);
            const digest = await setMetadataAndTransferBlobs(
                signer,
                [{ blobObjectId, namespace: namespace || "default" }],
                owner,
                packageId,
                agentId,
            );
            res.json({ transferred: 1, digest });
        } catch (err: any) {
            const traceId = requestIdFor(req);
            const message = errorMessage(err);
            sidecarLog("error", "walrus_set_metadata_failed", {
                requestId: traceId,
                error: message,
            });
            res.status(500).json({ error: message, traceId });
        }
    });
}
