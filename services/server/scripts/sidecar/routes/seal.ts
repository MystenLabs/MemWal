/**
 * SEAL encrypt / decrypt endpoints.
 *
 *   POST /seal/encrypt        → { data, owner, packageId } → { encryptedData }
 *   POST /seal/decrypt        → { data, packageId, accountId } → { decryptedData }
 *   POST /seal/decrypt-batch  → { items[], packageId, accountId } → { results[], errors[] }
 */

import { randomUUID } from "crypto";
import express, { type Express, type Response as ExpressResponse } from "express";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { EncryptedObject, SessionKey } from "@mysten/seal";
import {
    JSON_LIMIT_SEAL_DECRYPT,
    JSON_LIMIT_SEAL_DECRYPT_BATCH,
    JSON_LIMIT_SEAL_ENCRYPT,
    SEAL_KEY_SERVER_TIMEOUT_MS,
    SEAL_THRESHOLD,
} from "../config.js";
import { sealClient, suiClient } from "../clients.js";
import { requestIdFor } from "../log.js";
import { errorMessage, errorName, formattedError } from "../util.js";

function sendSealFailure(
    res: ExpressResponse,
    operation: string,
    phase: string,
    err: unknown,
    traceId: string = randomUUID(),
) {
    const message = formattedError(err);
    const error = `${operation} failed during ${phase}: ${message} (traceId=${traceId}, timeoutMs=${SEAL_KEY_SERVER_TIMEOUT_MS})`;
    console.error(`[${operation}] [${traceId}] phase=${phase} timeoutMs=${SEAL_KEY_SERVER_TIMEOUT_MS} error: ${message}`, err);
    res.status(500).json({
        error,
        traceId,
        phase,
        timeoutMs: SEAL_KEY_SERVER_TIMEOUT_MS,
        errorName: errorName(err),
    });
}

/**
 * Resolve a SEAL SessionKey from the request headers.
 *
 * Preferred path: `x-seal-session` contains a base64-encoded
 * `ExportedSessionKey` (built by the SDK on the client). We import it and
 * skip touching any private-key material.
 *
 * Legacy path: `x-delegate-key` contains the raw delegate private key
 * (hex or suiprivkey bech32). We reconstruct the keypair and build the
 * SessionKey here — same behavior as before the migration. This path
 * will be removed at EOL once all SDK clients emit `x-seal-session`.
 *
 * Returns `null` when neither header is present so the caller can emit a
 * 400 with a clear error message.
 */
async function resolveSessionKey(
    req: express.Request,
    packageId: string,
): Promise<SessionKey | null> {
    const sessionHeader = req.headers["x-seal-session"] as string | undefined;
    if (sessionHeader) {
        const exportedJson = Buffer.from(sessionHeader, "base64").toString("utf8");
        const exported = JSON.parse(exportedJson);
        return SessionKey.import(exported, suiClient as any);
    }

    const privateKey = req.headers["x-delegate-key"] as string | undefined;
    if (!privateKey) return null;

    let keypair: Ed25519Keypair;
    if (privateKey.startsWith("suiprivkey")) {
        const { secretKey } = decodeSuiPrivateKey(privateKey);
        keypair = Ed25519Keypair.fromSecretKey(secretKey);
    } else {
        // Validate hex format before parsing to prevent injection
        if (!/^[0-9a-fA-F]+$/.test(privateKey) || privateKey.length !== 64) {
            throw new Error("privateKey must be 64-char hex string or suiprivkey bech32");
        }
        const keyBytes = Uint8Array.from(
            privateKey.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)),
        );
        keypair = Ed25519Keypair.fromSecretKey(keyBytes);
    }
    return await SessionKey.create({
        address: keypair.getPublicKey().toSuiAddress(),
        packageId,
        ttlMin: 5,
        signer: keypair,
        suiClient: suiClient as any,
    });
}

/** Build the seal_approve PTB for a set of SEAL key IDs. */
async function buildSealApproveTxBytes(packageId: string, accountId: string, ids: string[]): Promise<Uint8Array> {
    const tx = new Transaction();
    for (const id of ids) {
        // Convert hex ID to byte array for PTB
        const idBytes = Array.from(
            Uint8Array.from(id.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)))
        );
        // Pass MemWalAccount (owned object) instead of AccountRegistry
        tx.moveCall({
            target: `${packageId}::account::seal_approve`,
            arguments: [
                tx.pure("vector<u8>", idBytes),
                tx.object(accountId),
            ],
        });
    }
    return await tx.build({ client: suiClient as any, onlyTransactionKind: true });
}

export function registerSealRoutes(app: Express): void {
    // /seal/encrypt receives the full plaintext for SEAL encryption. Must
    // accept up to PROTECTED_BODY_LIMIT_BYTES (1.5 MiB) of plaintext plus
    // base64 + JSON framing overhead.
    app.post("/seal/encrypt", express.json({ limit: JSON_LIMIT_SEAL_ENCRYPT }), async (req, res) => {
        let phase = "validate";
        try {
            const { data, owner, packageId } = req.body;
            if (!data || !owner || !packageId) {
                return res.status(400).json({ error: "Missing required fields: data, owner, packageId" });
            }

            phase = "encrypt";
            const plaintext = Buffer.from(data, "base64");
            const result = await sealClient.encrypt({
                threshold: SEAL_THRESHOLD,
                packageId,
                id: owner,
                data: new Uint8Array(plaintext),
            });

            const encryptedBase64 = Buffer.from(result.encryptedObject).toString("base64");
            res.json({ encryptedData: encryptedBase64 });
        } catch (err: any) {
            sendSealFailure(res, "seal/encrypt", phase, err, requestIdFor(req));
        }
    });

    app.post("/seal/decrypt", express.json({ limit: JSON_LIMIT_SEAL_DECRYPT }), async (req, res) => {
        let phase = "validate";
        try {
            const { data, packageId, accountId } = req.body;
            if (!data || !packageId || !accountId) {
                return res.status(400).json({ error: "Missing required fields: data, packageId, accountId" });
            }

            phase = "resolve_session";
            // resolve credential (x-seal-session preferred; legacy
            // x-delegate-key supported during the deprecation window).
            const sessionKey = await resolveSessionKey(req, packageId);
            if (!sessionKey) {
                return res.status(400).json({
                    error: "Missing credential: provide x-seal-session (preferred) or x-delegate-key header",
                });
            }

            phase = "parse";
            // Parse encrypted object to get key ID
            const encryptedData = new Uint8Array(Buffer.from(data, "base64"));
            const parsed = EncryptedObject.parse(encryptedData);
            const fullId = parsed.id;

            phase = "build_ptb";
            const txBytes = await buildSealApproveTxBytes(packageId, accountId, [fullId]);

            phase = "fetch_keys";
            // Fetch keys from key servers
            await sealClient.fetchKeys({
                ids: [fullId],
                txBytes,
                sessionKey,
                threshold: SEAL_THRESHOLD,
            });

            phase = "decrypt";
            // Decrypt locally
            const decrypted = await sealClient.decrypt({
                data: encryptedData,
                sessionKey,
                txBytes,
            });

            const decryptedBase64 = Buffer.from(decrypted).toString("base64");
            res.json({ decryptedData: decryptedBase64 });
        } catch (err: any) {
            sendSealFailure(res, "seal/decrypt", phase, err, requestIdFor(req));
        }
    });

    // Decrypt multiple SEAL-encrypted blobs with a single SessionKey.
    // Avoids "Not enough shares" errors when decrypting many blobs at once.
    // The batch body can be large (up to 25 × ~320 KiB max-item = ~8 MB).
    app.post("/seal/decrypt-batch", express.json({ limit: JSON_LIMIT_SEAL_DECRYPT_BATCH }), async (req, res) => {
        let phase = "validate";
        try {
            const { items, packageId, accountId } = req.body;
            if (!items || !Array.isArray(items) || items.length === 0) {
                return res.status(400).json({ error: "Missing required field: items (array of base64 encrypted data)" });
            }
            // Cap items. 25 × max-item body = ~8 MB (matches the
            // per-route body limit above). Tightened from 50 to 25 so worst-case
            // in-memory allocation stays bounded even at the new limit.
            if (items.length > 25) {
                return res.status(400).json({ error: "items array exceeds maximum of 25 elements" });
            }
            if (!packageId || !accountId) {
                return res.status(400).json({ error: "Missing required fields: packageId, accountId" });
            }

            phase = "resolve_session";
            // resolve credential (x-seal-session preferred; legacy
            // x-delegate-key supported during the deprecation window).
            const sessionKey = await resolveSessionKey(req, packageId);
            if (!sessionKey) {
                return res.status(400).json({
                    error: "Missing credential: provide x-seal-session (preferred) or x-delegate-key header",
                });
            }

            phase = "parse";
            // Parse all encrypted objects and collect unique SEAL IDs
            const parsedItems: { index: number; encryptedData: Uint8Array; fullId: string }[] = [];
            const errors: { index: number; error: string }[] = [];

            for (let i = 0; i < items.length; i++) {
                try {
                    const encryptedData = new Uint8Array(Buffer.from(items[i], "base64"));
                    const parsed = EncryptedObject.parse(encryptedData);
                    parsedItems.push({ index: i, encryptedData, fullId: parsed.id });
                } catch (err: any) {
                    errors.push({ index: i, error: `parse failed: ${errorMessage(err)}` });
                }
            }

            if (parsedItems.length === 0) {
                return res.json({ results: [], errors });
            }

            phase = "build_ptb";
            // Build ONE PTB with seal_approve for ALL unique IDs
            const allIds = [...new Set(parsedItems.map(p => p.fullId))];
            const txBytes = await buildSealApproveTxBytes(packageId, accountId, allIds);

            phase = "fetch_keys";
            // ONE fetchKeys call for ALL IDs
            try {
                await sealClient.fetchKeys({
                    ids: allIds,
                    txBytes,
                    sessionKey,
                    threshold: SEAL_THRESHOLD,
                });
            } catch (err: any) {
                const traceId = randomUUID();
                const message = formattedError(err);
                const error = `fetch_keys failed: ${message} (traceId=${traceId}, timeoutMs=${SEAL_KEY_SERVER_TIMEOUT_MS})`;
                console.error(
                    `[seal/decrypt-batch] [${traceId}] phase=fetch_keys items=${parsedItems.length} uniqueIds=${allIds.length} timeoutMs=${SEAL_KEY_SERVER_TIMEOUT_MS} error: ${message}`,
                    err,
                );
                return res.json({
                    results: [],
                    errors: [
                        ...errors,
                        ...parsedItems.map((item) => ({ index: item.index, error })),
                    ],
                });
            }

            phase = "decrypt";
            // Decrypt each blob using the shared sessionKey
            const results: { index: number; decryptedData: string }[] = [];

            for (const item of parsedItems) {
                try {
                    const decrypted = await sealClient.decrypt({
                        data: item.encryptedData,
                        sessionKey,
                        txBytes,
                    });
                    results.push({
                        index: item.index,
                        decryptedData: Buffer.from(decrypted).toString("base64"),
                    });
                } catch (err: any) {
                    errors.push({ index: item.index, error: `decrypt failed: ${formattedError(err)}` });
                }
            }

            console.log(`[seal/decrypt-batch] ${results.length}/${items.length} decrypted ok, ${errors.length} errors`);
            res.json({ results, errors });
        } catch (err: any) {
            sendSealFailure(res, "seal/decrypt-batch", phase, err, requestIdFor(req));
        }
    });
}
