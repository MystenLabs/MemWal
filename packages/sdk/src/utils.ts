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
