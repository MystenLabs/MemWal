/**
 * memwal — Shared Utilities
 *
 * Common crypto and encoding helpers used across the SDK.
 */

// ============================================================
// SHA-256 (Isomorphic)
// ============================================================

/**
 * Isomorphic SHA-256 hash — uses Web Crypto API (browser) or Node.js crypto (server).
 */
export async function sha256hex(data: string): Promise<string> {
    const bytes = new TextEncoder().encode(data);
    // Try Web Crypto API first (browser + modern Node.js)
    if (typeof globalThis.crypto?.subtle?.digest === "function") {
        const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(hashBuf))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }
    // Fallback to Node.js crypto
    const crypto = await import("crypto");
    return crypto.createHash("sha256").update(data).digest("hex");
}

// ============================================================
// Hex Encoding
// ============================================================

/**
 * Decode a hex string into bytes.
 *
 * LOW-25: Strict validation — rejects non-hex characters, odd-length input,
 * and empty strings. Previously, `parseInt("zz", 16)` silently produced `NaN`
 * which was coerced to `0`, yielding a wrong-but-valid-looking key.
 */
export function hexToBytes(hex: string): Uint8Array {
    if (typeof hex !== "string") {
        throw new TypeError("hexToBytes: expected string input");
    }
    const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
    if (clean.length === 0) {
        throw new Error("hexToBytes: empty hex string");
    }
    if (clean.length % 2 !== 0) {
        throw new Error(
            `hexToBytes: odd-length hex string (length=${clean.length}); hex must have an even number of digits`,
        );
    }
    if (!/^[0-9a-fA-F]+$/.test(clean)) {
        throw new Error("hexToBytes: input contains non-hex characters");
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

// ============================================================
// Transport Security Helpers
// ============================================================

/**
 * LOW-22: Normalize a user-supplied server URL.
 *
 * - Strips trailing slash.
 * - Emits a console.warn when a non-HTTPS URL is used against a
 *   non-localhost host (plaintext HTTP on the open internet exposes
 *   signed requests and any server-side secrets to passive interception).
 * - Localhost / 127.0.0.1 / ::1 are exempt from the warning (common in dev).
 * - Does NOT throw — explicit user-supplied `http://` is honored.
 */
export function normalizeServerUrl(url: string): string {
    const trimmed = url.replace(/\/$/, "");
    try {
        const parsed = new URL(trimmed);
        const host = parsed.hostname.toLowerCase();
        const isLocal =
            host === "localhost" ||
            host === "127.0.0.1" ||
            host === "::1" ||
            host.endsWith(".localhost");
        if (parsed.protocol === "http:" && !isLocal) {
            // eslint-disable-next-line no-console
            console.warn(
                `[memwal] serverUrl "${trimmed}" uses plaintext HTTP on a non-localhost host. ` +
                `Signed requests and any bearer material will be visible to the network. ` +
                `Use https:// in production.`,
            );
        }
    } catch {
        // invalid URL — let the fetch call surface the error at request time
    }
    return trimmed;
}

// ============================================================
// Error Sanitization (LOW-26)
// ============================================================

/**
 * LOW-26: Sanitize a raw server error body before surfacing it to callers.
 *
 * - Strips ASCII control characters.
 * - Truncates to at most 200 chars so stack traces / dumps don't leak.
 * - Leaves the untrimmed payload accessible via the returned `raw`
 *   field for debug logging (never included in the thrown message).
 */
export function sanitizeServerError(
    status: number,
    rawBody: string,
): { message: string; raw: string; serverCode?: string } {
    const MAX = 200;
    let serverCode: string | undefined;
    let text = rawBody;

    // Try to parse JSON error bodies and extract a known code field.
    try {
        const parsed = JSON.parse(rawBody);
        if (parsed && typeof parsed === "object") {
            if (typeof parsed.code === "string") serverCode = parsed.code;
            else if (typeof parsed.error === "string") serverCode = parsed.error;
            if (typeof parsed.message === "string") text = parsed.message;
        }
    } catch {
        // not JSON — keep rawBody
    }

    // Strip ASCII control chars (0x00-0x1F, 0x7F) that could corrupt logs.
    // eslint-disable-next-line no-control-regex
    const stripped = text.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
    const truncated =
        stripped.length > MAX ? `${stripped.slice(0, MAX)}...` : stripped;
    const message = `MemWal server error (${status}): ${truncated || "<no message>"}`;
    return { message, raw: rawBody, serverCode };
}

// ============================================================
// Delegate Key → Sui Address Derivation
// ============================================================

/**
 * Derive the Sui address from an Ed25519 delegate key (private key hex).
 *
 * Sui Ed25519 address = blake2b256(0x00 || public_key)[0..32]
 * where 0x00 is the Ed25519 scheme flag.
 *
 * This allows a delegate key to be used as a Sui keypair for signing transactions
 * (e.g. calling seal_approve for SEAL decryption).
 *
 * @param privateKeyHex - Ed25519 private key as hex string
 * @returns Sui address as 0x-prefixed hex string
 *
 * @example
 * ```typescript
 * const suiAddress = await delegateKeyToSuiAddress("abcdef1234...")
 * // "0x1a2b3c..."
 * ```
 */
export async function delegateKeyToSuiAddress(privateKeyHex: string): Promise<string> {
    const ed = await import("@noble/ed25519");
    const { blake2b } = await import("@noble/hashes/blake2.js");

    const privateKey = hexToBytes(privateKeyHex);
    const publicKey = await ed.getPublicKeyAsync(privateKey);

    // Sui Ed25519 address = blake2b256(0x00 || public_key)
    const input = new Uint8Array(33);
    input[0] = 0x00; // Ed25519 scheme flag
    input.set(publicKey, 1);

    const addressBytes = blake2b(input, { dkLen: 32 });
    return "0x" + bytesToHex(addressBytes);
}

/**
 * Get the Ed25519 public key bytes from a delegate key private key hex.
 *
 * @param privateKeyHex - Ed25519 private key as hex string
 * @returns 32-byte public key as Uint8Array
 */
export async function delegateKeyToPublicKey(privateKeyHex: string): Promise<Uint8Array> {
    const ed = await import("@noble/ed25519");
    return ed.getPublicKeyAsync(hexToBytes(privateKeyHex));
}

