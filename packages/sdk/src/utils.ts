/**
 * MemWal V2 — Shared Utilities
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

export function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
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

