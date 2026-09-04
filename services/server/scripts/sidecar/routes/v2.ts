/**
 * V2 fence-only PTB. Managed oyster writes never attach this to a Blob transfer.
 */

import express, { type Express } from "express";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { SERVER_SUI_ADDRESSES, SERVER_SUI_PRIVATE_KEYS } from "../config.js";
import { requestIdFor } from "../log.js";
import { errorMessage, parseWalrusKeySlot } from "../util.js";
import { appendV2WriteFence } from "../blob-metadata.js";
import { namespaceSealKeyId } from "../v2-envelope.js";
import { Transaction } from "@mysten/sui/transactions";
import { DURABLE_WALLET_FALLBACK_POLICY, submitRebuildableWalletTransaction } from "../wallet.js";

const WRITER_ADDRESSES = (process.env.MEMWAL_V2_WRITER_ADDRESSES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeSuiAddress(s));

export function registerV2Routes(app: Express): void {
    app.post("/sui/v2-write-fence", express.json({ limit: "64kb" }), async (req, res) => {
        const traceId = requestIdFor(req);
        try {
            const {
                keyIndex,
                packageId,
                namespaceRegistryId,
                accountRegistryId,
                accountId,
                namespaceId,
                keyVersion,
                commitment,
            } = req.body;
            if (
                keyIndex === undefined ||
                !packageId ||
                !namespaceRegistryId ||
                !accountRegistryId ||
                !accountId ||
                !namespaceId ||
                keyVersion === undefined ||
                !commitment
            ) {
                return res.status(400).json({
                    error: "Missing required fields: keyIndex, packageId, namespaceRegistryId, accountRegistryId, accountId, namespaceId, keyVersion, commitment",
                    traceId,
                });
            }
            const keySlot = parseWalrusKeySlot(keyIndex);
            if (keySlot === null) {
                return res.status(400).json({ error: `Invalid keyIndex: ${keyIndex}`, traceId });
            }
            const privateKey = SERVER_SUI_PRIVATE_KEYS[keySlot];
            if (!privateKey) {
                return res.status(400).json({ error: `Invalid keyIndex: ${keySlot}`, traceId });
            }
            const signerAddress = SERVER_SUI_ADDRESSES[keySlot];
            if (
                WRITER_ADDRESSES.length > 0 &&
                !WRITER_ADDRESSES.includes(normalizeSuiAddress(signerAddress))
            ) {
                return res.status(403).json({
                    error: "signer is not in MEMWAL_V2_WRITER_ADDRESSES",
                    traceId,
                });
            }
            const commitmentBytes = Array.from(Buffer.from(commitment, "base64"));
            if (commitmentBytes.length !== 32) {
                return res.status(400).json({ error: "commitment must be 32 bytes", traceId });
            }
            const { secretKey } = decodeSuiPrivateKey(privateKey);
            const signer = Ed25519Keypair.fromSecretKey(secretKey);
            const idBytes = Array.from(namespaceSealKeyId(namespaceId, BigInt(keyVersion)));
            const buildTx = () => {
                const tx = new Transaction();
                appendV2WriteFence(tx, {
                    packageId: normalizeSuiAddress(packageId),
                    idBytes,
                    nsRegistryId: namespaceRegistryId,
                    accountRegistryId,
                    accountId,
                    namespaceId,
                    commitment: commitmentBytes,
                });
                return tx;
            };
            const digest = await submitRebuildableWalletTransaction(
                "v2_write_fence",
                buildTx,
                signer,
                [signer.toSuiAddress()],
                { traceId, namespaceId },
                DURABLE_WALLET_FALLBACK_POLICY
            );
            res.json({ digest });
        } catch (err: unknown) {
            res.status(500).json({ error: errorMessage(err), traceId });
        }
    });
}
