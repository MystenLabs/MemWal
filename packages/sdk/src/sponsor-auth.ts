export interface SponsorAuthorization {
    authNonce: string;
    authSignature: string;
    authTimestamp: number;
}

export type SponsorPersonalMessageSigner = (
    message: Uint8Array,
) => Promise<{ signature: string }>;

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sponsorAuthorizationMessage(
    sender: string,
    transactionKindBytes: Uint8Array,
    timestamp: number,
    nonce: string,
): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        Uint8Array.from(transactionKindBytes).buffer,
    );
    const transactionKindHash = bytesToHex(new Uint8Array(digest));
    return [
        "MemWal sponsor authorization",
        `sender: ${sender}`,
        `transaction-kind-sha256: ${transactionKindHash}`,
        `timestamp: ${timestamp}`,
        `nonce: ${nonce}`,
    ].join("\n");
}

export async function createSponsorAuthorization(
    sender: string,
    transactionKindBytes: Uint8Array,
    signPersonalMessage: SponsorPersonalMessageSigner,
): Promise<SponsorAuthorization> {
    const authTimestamp = Math.floor(Date.now() / 1000);
    const authNonce = crypto.randomUUID();
    const message = await sponsorAuthorizationMessage(
        sender,
        transactionKindBytes,
        authTimestamp,
        authNonce,
    );
    const { signature: authSignature } = await signPersonalMessage(
        new TextEncoder().encode(message),
    );
    return { authNonce, authSignature, authTimestamp };
}
