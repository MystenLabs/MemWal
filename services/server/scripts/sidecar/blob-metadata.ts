/**
 * On-chain blob metadata + ownership transfer.
 *
 * Builds the single transaction that stamps memwal_* metadata pairs onto
 * freshly uploaded Walrus Blob objects and transfers them to the end user.
 * Shared by /walrus/upload and the /walrus/set-metadata* endpoints.
 */

import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { WALRUS_PACKAGE_ID } from "./config.js";
import { suiClient } from "./clients.js";
import { dedupeAddresses, shortAddress } from "./util.js";
import { submitRebuildableWalletTransaction } from "./wallet.js";

export type MetadataTransferBlob = {
    blobObjectId: string;
    namespace?: string;
};

export function extractBlobObjectId(blob: any): string | null {
    const rawId = blob?.blobObject?.id;
    if (typeof rawId === "string") {
        return rawId;
    }
    if (rawId && typeof rawId === "object" && typeof rawId.id === "string") {
        return rawId.id;
    }
    return null;
}

export async function setMetadataAndTransferBlobs(
    signer: Ed25519Keypair,
    blobs: MetadataTransferBlob[],
    owner: string,
    packageId?: string,
    agentId?: string,
    retryLogContext: Record<string, unknown> = {},
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
                arguments: [
                    blobArg,
                    metaTx.pure.string("memwal_owner"),
                    metaTx.pure.string(owner),
                ],
                typeArguments: [],
            });

            if (packageId) {
                metaTx.moveCall({
                    target: `${WALRUS_PACKAGE_ID}::blob::insert_or_update_metadata_pair`,
                    arguments: [
                        blobArg,
                        metaTx.pure.string("memwal_package_id"),
                        metaTx.pure.string(packageId),
                    ],
                    typeArguments: [],
                });
            }

            if (agentId) {
                metaTx.moveCall({
                    target: `${WALRUS_PACKAGE_ID}::blob::insert_or_update_metadata_pair`,
                    arguments: [
                        blobArg,
                        metaTx.pure.string("memwal_agent_id"),
                        metaTx.pure.string(agentId),
                    ],
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
    );
    await suiClient.waitForTransaction({ digest });
    return digest;
}
