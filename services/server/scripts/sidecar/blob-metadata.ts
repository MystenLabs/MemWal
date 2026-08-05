/**
 * On-chain blob metadata + ownership transfer.
 *
 * Builds the single transaction that stamps memwal_* metadata pairs onto
 * freshly uploaded Walrus Blob objects and transfers them to the end user.
 * Shared by /walrus/upload and the /walrus/set-metadata* endpoints.
 */

import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { EncryptedObject } from "@mysten/seal";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { WALRUS_PACKAGE_ID } from "./config.js";
import { suiClient } from "./clients.js";
import type { EnokiFallbackPolicy } from "./enoki.js";
import { dedupeAddresses, shortAddress } from "./util.js";
import { assertFinalizedTransactionSuccess, submitRebuildableWalletTransaction } from "./wallet.js";

export type MetadataTransferBlob = {
    blobObjectId: string;
    namespace?: string;
    sealFence: SealPersistenceFence;
};

export type SealPersistenceFence =
    | { sealAbi: "v1" }
    | {
          sealAbi: "v1-new";
          accountId: string;
          registryId: string;
          policyPackageId: string;
          idBytes: number[];
      };

export class InvalidSealPersistenceFenceError extends Error {
    constructor(
        message: string,
        readonly diagnostics: Record<string, string> = {}
    ) {
        super(message);
        this.name = "InvalidSealPersistenceFenceError";
    }
}

const SUI_ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;

function invalidFence(message: string, diagnostics?: Record<string, string>): never {
    throw new InvalidSealPersistenceFenceError(message, diagnostics);
}

/**
 * Parse the SEAL identity that must still be current when the Blob becomes
 * user-owned. Missing fence data fails closed; only an explicit legacy V1
 * marker bypasses the v1-new counter fence.
 */
export function parseSealPersistenceFence(
    input: {
        sealAbi?: unknown;
        accountId?: unknown;
        registryId?: unknown;
        policyPackageId?: unknown;
        data?: unknown;
    },
    immutablePackageId: unknown,
    policy: { allowLegacySealAbi: boolean; policyPackageId: string }
): SealPersistenceFence {
    if (input.sealAbi === "v1") {
        if (!policy.allowLegacySealAbi) {
            invalidFence("sealAbi=v1 persistence bypass is disabled on this sidecar");
        }
        return { sealAbi: "v1" };
    }
    if (input.sealAbi !== "v1-new") {
        invalidFence("sealAbi must be explicitly set to v1 or v1-new");
    }
    if (typeof input.accountId !== "string" || !SUI_ADDRESS.test(input.accountId)) {
        invalidFence("Invalid or missing accountId for v1-new persistence fence");
    }
    if (typeof input.registryId !== "string" || !SUI_ADDRESS.test(input.registryId)) {
        invalidFence("Invalid or missing registryId for v1-new persistence fence");
    }
    if (typeof input.policyPackageId !== "string" || !SUI_ADDRESS.test(input.policyPackageId)) {
        invalidFence("Invalid or missing policyPackageId for v1-new persistence fence");
    }
    if (!SUI_ADDRESS.test(policy.policyPackageId)) {
        invalidFence("Sidecar SEAL policy package is not configured");
    }
    const configuredPolicyPackageId = normalizeSuiAddress(policy.policyPackageId);
    if (typeof immutablePackageId !== "string" || !SUI_ADDRESS.test(immutablePackageId)) {
        invalidFence("Invalid or missing packageId for v1-new persistence fence");
    }
    if (typeof input.data !== "string" || input.data.length === 0) {
        invalidFence("Missing encrypted data for v1-new persistence fence");
    }

    let parsed: ReturnType<typeof EncryptedObject.parse>;
    try {
        parsed = EncryptedObject.parse(new Uint8Array(Buffer.from(input.data, "base64")));
    } catch {
        invalidFence("Invalid encrypted data for v1-new persistence fence");
    }
    if (normalizeSuiAddress(parsed.packageId) !== normalizeSuiAddress(immutablePackageId)) {
        invalidFence("Ciphertext packageId does not match packageId");
    }
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(parsed.id)) {
        invalidFence("Ciphertext has an invalid SEAL id");
    }

    return {
        sealAbi: "v1-new",
        accountId: normalizeSuiAddress(input.accountId),
        registryId: normalizeSuiAddress(input.registryId),
        // The executable target is operator-controlled. The request field is
        // required for protocol completeness but cannot select Move code.
        policyPackageId: configuredPolicyPackageId,
        idBytes: Array.from(Buffer.from(parsed.id, "hex")),
    };
}

export function appendSealPersistenceFence(tx: Transaction, fence: SealPersistenceFence): void {
    if (fence.sealAbi === "v1") return;
    tx.moveCall({
        target: `${fence.policyPackageId}::account::seal_encrypt_fence`,
        arguments: [tx.pure("vector<u8>", fence.idBytes), tx.object(fence.registryId), tx.object(fence.accountId)],
    });
}

export function extractBlobObjectId(blob: any): string | null {
    if (typeof blob?.blobObjectId === "string") {
        return blob.blobObjectId;
    }
    const rawId = blob?.blobObject?.id;
    if (typeof rawId === "string") {
        return rawId;
    }
    if (rawId && typeof rawId === "object" && typeof rawId.id === "string") {
        return rawId.id;
    }
    return null;
}

export function assertSuccessfulMetadataTransfer(result: any, digest: string): void {
    assertFinalizedTransactionSuccess(result, `metadata transfer transaction ${digest}`);
}

export async function setMetadataAndTransferBlobs(
    signer: Ed25519Keypair,
    blobs: MetadataTransferBlob[],
    owner: string,
    packageId?: string,
    agentId?: string,
    retryLogContext: Record<string, unknown> = {},
    fallbackPolicy?: EnokiFallbackPolicy,
    onSubmissionStarted?: () => void
): Promise<string> {
    if (blobs.length === 0) {
        throw new Error("No blobs to transfer");
    }

    const signerAddress = signer.toSuiAddress();
    const buildMetadataTransferTx = () => {
        const metaTx = new Transaction();
        const blobArgs = [];

        for (const blob of blobs) {
            const blobArg = metaTx.object(blob.blobObjectId);
            blobArgs.push(blobArg);
            appendSealPersistenceFence(metaTx, blob.sealFence);

            metaTx.moveCall({
                target: `${WALRUS_PACKAGE_ID}::blob::insert_or_update_metadata_pair`,
                arguments: [
                    blobArg,
                    metaTx.pure.string("memwal_namespace"),
                    metaTx.pure.string(blob.namespace || "default"),
                ],
                typeArguments: [],
            });

            metaTx.moveCall({
                target: `${WALRUS_PACKAGE_ID}::blob::insert_or_update_metadata_pair`,
                arguments: [blobArg, metaTx.pure.string("memwal_owner"), metaTx.pure.string(owner)],
                typeArguments: [],
            });

            if (packageId) {
                metaTx.moveCall({
                    target: `${WALRUS_PACKAGE_ID}::blob::insert_or_update_metadata_pair`,
                    arguments: [blobArg, metaTx.pure.string("memwal_package_id"), metaTx.pure.string(packageId)],
                    typeArguments: [],
                });
            }

            if (agentId) {
                metaTx.moveCall({
                    target: `${WALRUS_PACKAGE_ID}::blob::insert_or_update_metadata_pair`,
                    arguments: [blobArg, metaTx.pure.string("memwal_agent_id"), metaTx.pure.string(agentId)],
                    typeArguments: [],
                });
            }
        }

        metaTx.transferObjects(blobArgs, owner);
        return metaTx;
    };

    const digest = await submitRebuildableWalletTransaction(
        "metadata_transfer",
        buildMetadataTransferTx,
        signer,
        dedupeAddresses([signerAddress, owner]),
        {
            ...retryLogContext,
            blobCount: blobs.length,
            owner: shortAddress(owner),
        },
        fallbackPolicy,
        onSubmissionStarted
    );
    const result = await suiClient.waitForTransaction({ digest });
    assertSuccessfulMetadataTransfer(result, digest);
    return digest;
}
