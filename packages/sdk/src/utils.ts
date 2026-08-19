/**
 * Walrus Memory — Shared Utilities
 *
 * Common crypto and encoding helpers used across the SDK.
 */

import type { ScoringWeights } from "./types.js";

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

/**
 * BCS-encode a u64 as 8 little-endian bytes, hex — matching `bcs::to_bytes(&u64)`
 * on the Move side. Used to tail a SEAL key id with the account's rotation
 * counter so it matches what `seal_approve` parses back out.
 *
 * Hand-rolled rather than pulling in @mysten/bcs: this package keeps @mysten/*
 * as peer dependencies, and eight bytes are not worth a dynamic import.
 */
export function u64ToLeHex(value: bigint): string {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
        throw new Error(`u64ToLeHex: ${value} is out of u64 range`);
    }
    let hex = "";
    for (let i = 0n; i < 8n; i++) {
        hex += Number((value >> (i * 8n)) & 0xffn)
            .toString(16)
            .padStart(2, "0");
    }
    return hex;
}

export function scoringWeightsToWire(weights?: ScoringWeights): object | undefined {
    if (!weights) return undefined;

    return {
        semantic: weights.semantic,
        recency: weights.recency,
        recency_half_life_days: weights.recencyHalfLifeDays,
        importance: weights.importance,
    };
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
 * GH #696 — user-facing copy when a memwal_* tool is called without a session.
 * Locked string: do not paraphrase.
 */
export const MEMWAL_LOGIN_REQUIRED_MESSAGE =
    "Walrus Memory isn't signed in. Call the memwal_login tool, then retry.";

const AUTH_REJECTED_MESSAGE =
    "401 from relayer: typically wrong private key, key not registered on this account, " +
    "account ID mismatch, or staging/mainnet mismatch. Check .env.local and dashboard credentials. " +
    "Full troubleshooting: https://docs.wal.app/walrus-memory/troubleshooting/overview#401-auth_rejected-errors";

/**
 * Relayer 401s are sometimes forwarded with status as a string (JSON-RPC /
 * wrapTool / HTTP /api/mcp). Strict `=== 401` skipped the special-case and
 * produced `Walrus Memory server error (401): <no message>`.
 */
function isUnauthorizedStatus(status: number | string): boolean {
    return Number(status) === 401;
}

function isEmptyErrorBody(rawBody: string): boolean {
    // eslint-disable-next-line no-control-regex
    return !String(rawBody ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").trim();
}

/**
 * LOW-26: Sanitize a raw server error body before surfacing it to callers.
 *
 * - Strips ASCII control characters.
 * - Truncates to at most 200 chars so stack traces / dumps don't leak.
 * - Leaves the untrimmed payload accessible via the returned `raw`
 *   field for debug logging (never included in the thrown message).
 * - Empty 401 / string status "401" (no-session) returns
 *   {@link MEMWAL_LOGIN_REQUIRED_MESSAGE} instead of `<no message>`.
 */
export function sanitizeServerError(
    status: number | string,
    rawBody: string,
): { message: string; raw: string; serverCode?: string } {
    if (isUnauthorizedStatus(status)) {
        // Empty 401 is the relayer's constant-time reject *and* the no-session
        // case memwal_* callers hit. Distinguish AUTH_REJECTED when the body
        // carries a rejection signal (WALM-318). Clock-drift 401s never reach
        // here — signedRequest / manual.ts throw via clockDriftErrorFromResponse.
        if (isEmptyErrorBody(rawBody)) {
            return {
                message: MEMWAL_LOGIN_REQUIRED_MESSAGE,
                raw: rawBody,
                serverCode: "UNAUTHENTICATED",
            };
        }
        return {
            message: AUTH_REJECTED_MESSAGE,
            raw: rawBody,
            serverCode: "AUTH_REJECTED",
        };
    }

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
    const message = `Walrus Memory server error (${status}): ${truncated || "<no message>"}`;
    return { message, raw: rawBody, serverCode };
}

/**
 * Machine-readable reason the relayer sets on the `x-auth-error` header when it
 * rejects a request because the signed timestamp is outside its accepted
 * clock-drift window.
 */
export const ERR_TIMESTAMP_OUT_OF_BOUNDS = "ERR_TIMESTAMP_OUT_OF_BOUNDS";

/**
 * When a rejected response carries `x-auth-error: ERR_TIMESTAMP_OUT_OF_BOUNDS`,
 * build an actionable clock-drift error (with `serverCode` set) so the caller
 * can fix node time rather than seeing an opaque 401. Returns `null` otherwise.
 */
export function clockDriftErrorFromResponse(
    res: { status: number; headers: Headers },
): (Error & { status?: number; serverCode?: string }) | null {
    if (res.status !== 401) return null;
    if (res.headers.get("x-auth-error") !== ERR_TIMESTAMP_OUT_OF_BOUNDS) return null;
    const err = new Error(
        "Request rejected: signed timestamp is outside the relayer's accepted clock-drift window. " +
            "Synchronize this client's clock (NTP); if the deployment needs a wider tolerance, " +
            "raise AUTH_MAX_CLOCK_DRIFT_SECS on the relayer.",
    ) as Error & { status?: number; serverCode?: string };
    err.status = res.status;
    err.serverCode = ERR_TIMESTAMP_OUT_OF_BOUNDS;
    return err;
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
