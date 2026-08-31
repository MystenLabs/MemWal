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
// Sui Private Key Formats
// ============================================================

// Bech32 (BIP-173) charset, and the Sui scheme flag for Ed25519.
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const SUI_ED25519_SCHEME_FLAG = 0;

/**
 * Hand-rolled rather than pulling in `decodeSuiPrivateKey` from `@mysten/sui`:
 * this package keeps `@mysten/*` as peer dependencies so the core client works
 * without them, and `MemWal`'s constructor is synchronous so it cannot await a
 * dynamic import. The Python SDK hand-rolls it in `memwal/utils.py` for the
 * same reason.
 */
function bech32Polymod(values: number[]): number {
    const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const value of values) {
        const top = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ value;
        for (let i = 0; i < 5; i++) {
            if ((top >> i) & 1) {
                chk ^= generators[i]!;
            }
        }
    }
    return chk;
}

function bech32HrpExpand(hrp: string): number[] {
    const high: number[] = [];
    const low: number[] = [];
    for (const char of hrp) {
        const code = char.charCodeAt(0);
        high.push(code >> 5);
        low.push(code & 31);
    }
    return [...high, 0, ...low];
}

/**
 * Regroup `data` from `frombits`-wide values to `tobits`-wide ones. Bech32
 * carries 5-bit values; a private key is bytes, so decoding is 5 -> 8.
 */
function convertBits(data: number[], frombits: number, tobits: number, pad: boolean): number[] {
    let acc = 0;
    let bits = 0;
    const ret: number[] = [];
    const maxv = (1 << tobits) - 1;
    const maxAcc = (1 << (frombits + tobits - 1)) - 1;
    for (const value of data) {
        if (value < 0 || value >> frombits) {
            throw new Error("convertBits: value out of range");
        }
        acc = ((acc << frombits) | value) & maxAcc;
        bits += frombits;
        while (bits >= tobits) {
            bits -= tobits;
            ret.push((acc >> bits) & maxv);
        }
    }
    if (pad) {
        if (bits) {
            ret.push((acc << (tobits - bits)) & maxv);
        }
    } else if (bits >= frombits || ((acc << (tobits - bits)) & maxv)) {
        throw new Error("convertBits: invalid incomplete group");
    }
    return ret;
}

/** Decode a bech32 string into its human-readable part and 5-bit data. */
function bech32Decode(bech: string): { hrp: string; data: number[] } {
    if (bech !== bech.toLowerCase() && bech !== bech.toUpperCase()) {
        throw new Error("bech32 string is mixed case");
    }
    const lower = bech.toLowerCase();
    const pos = lower.lastIndexOf("1");
    if (pos < 1 || pos + 7 > lower.length) {
        throw new Error("bech32 string has no valid separator");
    }

    const hrp = lower.slice(0, pos);
    const data: number[] = [];
    for (const char of lower.slice(pos + 1)) {
        const index = BECH32_CHARSET.indexOf(char);
        if (index === -1) {
            throw new Error("bech32 string has a character outside the charset");
        }
        data.push(index);
    }

    if (bech32Polymod([...bech32HrpExpand(hrp), ...data]) !== 1) {
        throw new Error("bech32 checksum mismatch");
    }
    return { hrp, data: data.slice(0, -6) };
}

/**
 * Decode a Sui bech32 `suiprivkey1...` string to its 32-byte Ed25519 seed.
 *
 * Mirrors `decodeSuiPrivateKey` from `@mysten/sui`.
 */
export function decodeSuiPrivateKey(encoded: string): Uint8Array {
    const { hrp, data } = bech32Decode(encoded);
    if (hrp !== "suiprivkey") {
        throw new Error(`expected a suiprivkey string, got prefix '${hrp}'`);
    }

    const payload = convertBits(data, 5, 8, false);
    if (payload.length === 0 || payload[0] !== SUI_ED25519_SCHEME_FLAG) {
        throw new Error("only Ed25519 private keys are supported");
    }

    const seed = payload.slice(1);
    if (seed.length !== 32) {
        throw new Error(`Ed25519 seed must be exactly 32 bytes, got ${seed.length}`);
    }
    return Uint8Array.from(seed);
}

/**
 * Accept either a hex seed or a Sui `suiprivkey1...` string, return hex.
 *
 * Both forms are in circulation — `sui keytool` and wallets hand out bech32,
 * while `generateDelegateKey()` returns hex — so hex-only input would reject a
 * key a user reasonably expects to work, and the "non-hex characters" error it
 * raised named nothing they could act on. Matches the Python SDK's
 * `normalize_private_key`.
 */
export function normalizePrivateKey(key: string): string {
    if (typeof key !== "string") {
        throw new TypeError("normalizePrivateKey: expected string input");
    }
    const candidate = key.trim();
    if (candidate.toLowerCase().startsWith("suiprivkey1")) {
        return bytesToHex(decodeSuiPrivateKey(candidate));
    }
    return candidate.startsWith("0x") || candidate.startsWith("0X")
        ? candidate.slice(2)
        : candidate;
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

/** Replace loopback URLs that leak sidecar topology into client-facing errors. */
export function redactInternalUrls(text: string): string {
    return text.replace(
        /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^ \t)\]>'"]*/gi,
        "[internal]",
    );
}

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
    // Number() so a string "401" (some MCP / HTTP paths) still hits this branch.
    if (Number(status) === 401) {
        return {
            message:
                "401 from relayer: typically wrong private key, key not registered on this account, " +
                "account ID mismatch, or staging/mainnet mismatch. Check .env.local and dashboard credentials. " +
                "Full troubleshooting: https://docs.wal.app/walrus-memory/troubleshooting/overview#401-auth_rejected-errors",
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
    const stripped = redactInternalUrls(
        text.replace(/[\u0000-\u001F\u007F]/g, " "),
    ).trim();
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
 * @param privateKeyHex - Ed25519 private key, hex or `suiprivkey1...`
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

    const privateKey = hexToBytes(normalizePrivateKey(privateKeyHex));
    const publicKey = await ed.getPublicKeyAsync(privateKey);

    // Sui Ed25519 address = blake2b256(0x00 || public_key)
    const input = new Uint8Array(33);
    input[0] = 0x00; // Ed25519 scheme flag
    input.set(publicKey, 1);

    const addressBytes = blake2b(input, { dkLen: 32 });
    return "0x" + bytesToHex(addressBytes);
}

/**
 * Get the Ed25519 public key bytes from a delegate private key.
 *
 * @param privateKeyHex - Ed25519 private key, hex or `suiprivkey1...`
 * @returns 32-byte public key as Uint8Array
 */
export async function delegateKeyToPublicKey(privateKeyHex: string): Promise<Uint8Array> {
    const ed = await import("@noble/ed25519");
    return ed.getPublicKeyAsync(hexToBytes(normalizePrivateKey(privateKeyHex)));
}
