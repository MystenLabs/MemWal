import { normalizeSuiAddress } from "@mysten/sui/utils";

export type MetadataRecoveryBlob = { blobObjectId: string; namespace?: string };
type Receipt = { owner: unknown; metadata: Array<{ key: string; value: string }> };

function suiAddress(value: unknown): string | null {
    if (typeof value !== "string" || value.length === 0) return null;
    try {
        return normalizeSuiAddress(value);
    } catch {
        return null;
    }
}

/** Accept address-owner encodings only: an object owner is not the recipient wallet. */
function ownerIs(recipient: unknown, expected: string): boolean {
    const target = suiAddress(expected);
    if (target === null) return false;
    if (typeof recipient === "string") return suiAddress(recipient) === target;
    if (!recipient || typeof recipient !== "object") return false;
    const record = recipient as Record<string, unknown>;
    return [record.AddressOwner, record.SingleOwner].some(
        (candidate) => suiAddress(candidate) === target,
    );
}

/**
 * Skip a blob only when the target already owns it AND the memwal metadata
 * matches this request. The relayer must not sign as that target, and must
 * not submit another uploader transfer for a step that already landed.
 *
 * When the target is also the signer (the owner is a pool wallet), register
 * already left the blob with that address, so ownership is not a receipt and
 * register's tags look the same as a finished write. Only the metadata step
 * writes memwal_agent_id, so a matching agent id proves it ran. Without that
 * proof, sign the metadata step: it is idempotent, and it is the only step
 * that adds the agent id and the SEAL persistence fence. A tag that
 * disagrees still fails.
 */
export async function recoverMetadataBatch<T extends MetadataRecoveryBlob>(
    blobs: T[],
    owner: string,
    signer: string,
    packageId: string | undefined,
    agentId: string | undefined,
    read: (id: string) => Promise<Receipt>,
    submit: (pending: T[]) => Promise<string>,
): Promise<{ transferred: number; digest: string | null; transferStatus: "ok" | "already_transferred" }> {
    const pending: T[] = [];
    for (const blob of blobs) {
        const receipt = await read(blob.blobObjectId);
        if (ownerIs(receipt.owner, owner)) {
            const metadata = new Map(receipt.metadata.map(({ key, value }) => [key, value]));
            const metadataOwner = suiAddress(metadata.get("memwal_owner"));
            const metadataPackage = suiAddress(metadata.get("memwal_package_id"));
            const metadataAgent = metadata.get("memwal_agent_id");
            const signerIsOwner = suiAddress(signer) === suiAddress(owner);
            if (metadata.get("memwal_namespace") !== (blob.namespace || "default")
                || metadataOwner !== suiAddress(owner)
                || (packageId !== undefined && metadataPackage !== suiAddress(packageId))
                || (agentId !== undefined && metadataAgent !== undefined && metadataAgent !== agentId)
                || (agentId !== undefined && metadataAgent === undefined && !signerIsOwner)) {
                throw new Error(`METADATA_RECEIPT_MISMATCH: ${blob.blobObjectId}`);
            }
            const metadataStepProven = agentId !== undefined && metadataAgent === agentId;
            if (signerIsOwner && !metadataStepProven) {
                pending.push(blob);
            }
            continue;
        }
        if (!ownerIs(receipt.owner, signer)) {
            throw new Error(`BLOB_OWNER_MISMATCH: ${blob.blobObjectId}`);
        }
        pending.push(blob);
    }
    if (pending.length === 0) {
        return { transferred: 0, digest: null, transferStatus: "already_transferred" };
    }
    return {
        transferred: pending.length,
        digest: await submit(pending),
        transferStatus: "ok",
    };
}
