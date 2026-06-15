/**
 * Migration-only on-chain helpers.
 *
 * These routes are mounted behind the sidecar shared-secret middleware. They
 * let the Rust relayer / migration worker execute P2 admin entrypoints without
 * embedding a Sui transaction builder in Rust.
 */

import express, { type Express } from "express";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair, Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SERVER_SUI_PRIVATE_KEYS } from "../config.js";
import { requestIdFor } from "../log.js";
import { errorMessage, parseWalrusKeySlot, shortAddress } from "../util.js";
import { submitWalletTransaction } from "../wallet.js";
import { suiClient } from "../clients.js";

const SUI_CLOCK_OBJECT_ID = "0x6";
const JSON_LIMIT_CHAIN = "1mb";
const ACCOUNT_TYPE_SUFFIX = "::account::Account";
const NAMESPACE_TYPE_SUFFIX = "::namespace::MemoryNamespace";

type ExecutedTx = {
    digest: string;
    objectChanges: unknown[];
    events: unknown[];
};

function requireObjectId(value: unknown, name: string): string {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
        throw new Error(`Invalid ${name}`);
    }
    return value;
}

function requireAddress(value: unknown, name: string): string {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`Invalid ${name}`);
    }
    return value;
}

function requireString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Invalid ${name}`);
    }
    return value;
}

function requireU32(value: unknown, name: string): number {
    if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 0xFFFF_FFFF) {
        throw new Error(`Invalid ${name}`);
    }
    return Number(value);
}

function signerForKeyIndex(raw: unknown): Ed25519Keypair {
    const keySlot = parseWalrusKeySlot(raw);
    if (keySlot === null) throw new Error(`Invalid keyIndex: ${raw}`);
    const privateKey = SERVER_SUI_PRIVATE_KEYS[keySlot];
    if (!privateKey) throw new Error(`Invalid keyIndex: ${keySlot}`);
    const { secretKey } = decodeSuiPrivateKey(privateKey);
    return Ed25519Keypair.fromSecretKey(secretKey);
}

function bytesFromBase64(value: unknown, name: string): number[] {
    const raw = requireString(value, name);
    return Array.from(Buffer.from(raw, "base64"));
}

function bytesFromHex(value: unknown, name: string): number[] {
    const raw = requireString(value, name).replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]*$/.test(raw) || raw.length % 2 !== 0) {
        throw new Error(`Invalid ${name}`);
    }
    return Array.from(Buffer.from(raw, "hex"));
}

function bytesFromUtf8(value: string): number[] {
    return Array.from(Buffer.from(value, "utf8"));
}

function deriveSuiAddressFromPublicKeyHex(publicKeyHex: string): string {
    const bytes = Uint8Array.from(Buffer.from(publicKeyHex.replace(/^0x/i, ""), "hex"));
    if (bytes.length !== 32) throw new Error("Invalid publicKeyHex length");
    return new Ed25519PublicKey(bytes).toSuiAddress();
}

function objectIdForCreatedType(objectChanges: unknown[], typeSuffix: string): string | undefined {
    for (const change of objectChanges) {
        if (!change || typeof change !== "object") continue;
        const item = change as { type?: unknown; objectType?: unknown; objectId?: unknown };
        if (
            item.type === "created" &&
            typeof item.objectType === "string" &&
            item.objectType.endsWith(typeSuffix) &&
            typeof item.objectId === "string"
        ) {
            return item.objectId;
        }
    }
    return undefined;
}

async function executeTx(
    tx: Transaction,
    signer: Ed25519Keypair,
    traceId: string,
    label: string,
): Promise<ExecutedTx> {
    const signerAddress = signer.toSuiAddress();
    const digest = await submitWalletTransaction(tx, signer, [signerAddress]);
    const result = await suiClient.waitForTransaction({
        digest,
        options: { showObjectChanges: true, showEvents: true },
    });
    const objectChanges = Array.isArray(result.objectChanges) ? result.objectChanges : [];
    const events = Array.isArray(result.events) ? result.events : [];
    console.log(`[chain/${label}] [${traceId}] ok ${JSON.stringify({
        digest,
        signer: shortAddress(signerAddress),
    })}`);
    return { digest, objectChanges, events };
}

function sendError(res: express.Response, traceId: string, label: string, err: unknown): void {
    const message = errorMessage(err);
    console.error(`[chain/${label}] [${traceId}] error: ${message}`, err);
    res.status(500).json({ error: message, traceId });
}

export function registerChainRoutes(app: Express): void {
    app.post("/chain/admin-import-account", express.json({ limit: JSON_LIMIT_CHAIN }), async (req, res) => {
        const traceId = requestIdFor(req);
        try {
            const signer = signerForKeyIndex(req.body.keyIndex);
            const tx = new Transaction();
            tx.moveCall({
                target: `${requireObjectId(req.body.packageId, "packageId")}::namespace::admin_import_account`,
                arguments: [
                    tx.object(requireObjectId(req.body.migrationCapId, "migrationCapId")),
                    tx.object(requireObjectId(req.body.accountRegistryId, "accountRegistryId")),
                    tx.object(requireObjectId(req.body.namespaceRegistryId, "namespaceRegistryId")),
                    tx.pure.address(requireAddress(req.body.owner, "owner")),
                    tx.pure.id(requireObjectId(req.body.legacyAccountId, "legacyAccountId")),
                    tx.pure("string", requireString(req.body.namespaceName ?? "default", "namespaceName")),
                    tx.pure.u64(Number(req.body.createdAt ?? Date.now())),
                    tx.pure.bool(req.body.active !== false),
                ],
            });
            const executed = await executeTx(tx, signer, traceId, "admin-import-account");
            const accountId = objectIdForCreatedType(executed.objectChanges, ACCOUNT_TYPE_SUFFIX);
            const namespaceId = objectIdForCreatedType(executed.objectChanges, NAMESPACE_TYPE_SUFFIX);
            if (!accountId || !namespaceId) {
                throw new Error("admin-import-account succeeded but created Account/MemoryNamespace ids were not found");
            }
            res.json({ digest: executed.digest, accountId, namespaceId });
        } catch (err) {
            sendError(res, traceId, "admin-import-account", err);
        }
    });

    app.post("/chain/admin-create-namespace", express.json({ limit: JSON_LIMIT_CHAIN }), async (req, res) => {
        const traceId = requestIdFor(req);
        try {
            const signer = signerForKeyIndex(req.body.keyIndex);
            const tx = new Transaction();
            tx.moveCall({
                target: `${requireObjectId(req.body.packageId, "packageId")}::namespace::admin_create_namespace`,
                arguments: [
                    tx.object(requireObjectId(req.body.migrationCapId, "migrationCapId")),
                    tx.object(requireObjectId(req.body.namespaceRegistryId, "namespaceRegistryId")),
                    tx.pure.address(requireAddress(req.body.owner, "owner")),
                    tx.pure("string", requireString(req.body.namespaceName ?? "default", "namespaceName")),
                    tx.pure.u64(Number(req.body.createdAt ?? Date.now())),
                ],
            });
            const executed = await executeTx(tx, signer, traceId, "admin-create-namespace");
            const namespaceId = objectIdForCreatedType(executed.objectChanges, NAMESPACE_TYPE_SUFFIX);
            if (!namespaceId) {
                throw new Error("admin-create-namespace succeeded but created MemoryNamespace id was not found");
            }
            res.json({ digest: executed.digest, namespaceId });
        } catch (err) {
            sendError(res, traceId, "admin-create-namespace", err);
        }
    });

    app.post("/chain/admin-add-delegate-key", express.json({ limit: JSON_LIMIT_CHAIN }), async (req, res) => {
        const traceId = requestIdFor(req);
        try {
            const signer = signerForKeyIndex(req.body.keyIndex);
            const publicKeyHex = requireString(req.body.publicKeyHex, "publicKeyHex");
            const suiAddress = typeof req.body.suiAddress === "string"
                ? requireAddress(req.body.suiAddress, "suiAddress")
                : deriveSuiAddressFromPublicKeyHex(publicKeyHex);
            const tx = new Transaction();
            tx.moveCall({
                target: `${requireObjectId(req.body.packageId, "packageId")}::account::admin_add_delegate_key`,
                arguments: [
                    tx.object(requireObjectId(req.body.migrationCapId, "migrationCapId")),
                    tx.object(requireObjectId(req.body.accountId, "accountId")),
                    tx.pure("vector<u8>", bytesFromHex(publicKeyHex, "publicKeyHex")),
                    tx.pure.address(suiAddress),
                    tx.pure("string", requireString(req.body.label ?? "Migrated delegate", "label")),
                    tx.pure.u8(Number(req.body.perms ?? 3)),
                    tx.pure.u64(Number(req.body.createdAt ?? Date.now())),
                ],
            });
            const executed = await executeTx(tx, signer, traceId, "admin-add-delegate-key");
            res.json({ digest: executed.digest });
        } catch (err) {
            sendError(res, traceId, "admin-add-delegate-key", err);
        }
    });

    app.post("/chain/admin-set-wrapped-dek", express.json({ limit: JSON_LIMIT_CHAIN }), async (req, res) => {
        const traceId = requestIdFor(req);
        try {
            const signer = signerForKeyIndex(req.body.keyIndex);
            const tx = new Transaction();
            tx.moveCall({
                target: `${requireObjectId(req.body.packageId, "packageId")}::namespace::admin_set_wrapped_dek`,
                arguments: [
                    tx.object(requireObjectId(req.body.migrationCapId, "migrationCapId")),
                    tx.object(requireObjectId(req.body.namespaceId, "namespaceId")),
                    tx.pure.u32(requireU32(req.body.keyVersion ?? 1, "keyVersion")),
                    tx.pure("vector<u8>", bytesFromBase64(req.body.wrappedDekBase64, "wrappedDekBase64")),
                ],
            });
            const executed = await executeTx(tx, signer, traceId, "admin-set-wrapped-dek");
            res.json({ digest: executed.digest });
        } catch (err) {
            sendError(res, traceId, "admin-set-wrapped-dek", err);
        }
    });

    app.post("/chain/admin-record-memory", express.json({ limit: JSON_LIMIT_CHAIN }), async (req, res) => {
        const traceId = requestIdFor(req);
        try {
            const signer = signerForKeyIndex(req.body.keyIndex);
            const tx = new Transaction();
            tx.moveCall({
                target: `${requireObjectId(req.body.packageId, "packageId")}::namespace::admin_record_memory`,
                arguments: [
                    tx.object(requireObjectId(req.body.migrationCapId, "migrationCapId")),
                    tx.object(requireObjectId(req.body.namespaceId, "namespaceId")),
                    tx.pure("vector<u8>", bytesFromUtf8(requireString(req.body.blobId, "blobId"))),
                    tx.pure.u32(requireU32(req.body.keyVersion ?? 1, "keyVersion")),
                    tx.pure.u32(requireU32(req.body.storageEndEpoch ?? 0, "storageEndEpoch")),
                    tx.object(SUI_CLOCK_OBJECT_ID),
                ],
            });
            const executed = await executeTx(tx, signer, traceId, "admin-record-memory");
            res.json({ digest: executed.digest });
        } catch (err) {
            sendError(res, traceId, "admin-record-memory", err);
        }
    });
}
