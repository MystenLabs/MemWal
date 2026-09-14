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
 * Isomorphic SHA-256 hash.
 *
 * Hashes in userland rather than reaching for a platform digest, so there is no
 * Node builtin to import and nothing for a browser bundler to externalise —
 * the WALM-136 / GH #322 landmine, where Vite quietly stubs `crypto`, the app
 * builds clean, and the browser crashes the first time the path runs.
 *
 * This previously preferred WebCrypto and fell back to `node:crypto`. The
 * fallback could never help a browser — when `crypto.subtle` is missing it is
 * because the page is not a secure context, and `node:crypto` is not there
 * either — so it only served Node <19 (EOL April 2025) while being the sole
 * source of the bundler exposure. `sha256hex` is on the signed-request path,
 * so every remember and recall runs through it.
 *
 * Stays `async` though `sha256` is synchronous: the signature is public API and
 * callers already await it.
 */
export async function sha256hex(data: string): Promise<string> {
    const { sha256 } = await import("@noble/hashes/sha2.js");
    return bytesToHex(sha256(new TextEncoder().encode(data)));
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
    authError?: string | null,
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

    // Auth-path 503 only: Sui could not be consulted (WALM-429). Other
    // relayer 503s (Redis, rate limiter, LLM) keep the generic sanitizer
    // so they are not mislabeled as a credential-verification failure.
    if (Number(status) === 503 && authError === "AUTH_UPSTREAM_UNAVAILABLE") {
        return {
            message:
                "Walrus Memory temporarily cannot verify credentials (upstream unavailable). Retry; this is not a sign-in failure.",
            raw: rawBody,
            serverCode: "AUTH_UPSTREAM_UNAVAILABLE",
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

// ============================================================
// SEAL SessionKey lifecycle (WALM-162)
// ============================================================

/**
 * How long before the cached SessionKey's usable deadline the SDK starts
 * rebuilding it in the background.
 *
 * This is distinct from `SEAL_SESSION_SAFETY_MARGIN_MS` in `memwal.ts`. The
 * safety margin is a *staleness guard*: it shortens the cache's usable window
 * so we never ship a session a key server would already consider expired. It
 * is entirely reactive — the request that first observes the shortened
 * deadline is the one that pays for the rebuild.
 *
 * The refresh-ahead window is the *proactive* half: once the cached session
 * enters it, a cache hit still returns immediately with the (still valid)
 * bytes and a rebuild is kicked off out of band, so the swap happens between
 * user-facing calls instead of inside one.
 */
export const SEAL_SESSION_REFRESH_AHEAD_MS = 60_000;

/** Lifecycle state of a cached SEAL SessionKey at a given instant. */
export type SealSessionCacheState =
    /** Comfortably valid — serve from cache, do nothing else. */
    | "fresh"
    /** Still valid, but inside the refresh-ahead window — serve from cache AND rebuild in the background. */
    | "refresh-ahead"
    /** Past its usable deadline — the caller must block on a rebuild. */
    | "expired";

/**
 * Decide what to do with a cached SEAL SessionKey.
 *
 * Pure so the refresh policy is unit-testable without standing up the SEAL /
 * Sui peer dependencies that a real `SessionKey.create()` needs.
 *
 * @param expiresAt - Absolute epoch-millis deadline already reduced by the
 *   safety margin (i.e. the cache entry's `expiresAt`).
 * @param now - Current epoch millis.
 * @param refreshAheadMs - Width of the proactive window. Values <= 0 disable
 *   refresh-ahead and reduce this to the original lazy behaviour.
 */
export function sealSessionCacheState(
    expiresAt: number,
    now: number,
    refreshAheadMs: number = SEAL_SESSION_REFRESH_AHEAD_MS,
): SealSessionCacheState {
    if (!Number.isFinite(expiresAt) || now >= expiresAt) return "expired";
    if (refreshAheadMs > 0 && now >= expiresAt - refreshAheadMs) return "refresh-ahead";
    return "fresh";
}

/**
 * Markers that identify a rejected request as "the SEAL SessionKey we sent is
 * no longer acceptable", rather than any other server-side failure.
 *
 * `ExpiredSessionKeyError` / "Session key has expired" are what `@mysten/seal`
 * raises from `SessionKey.import()` and from a key server answering
 * `InvalidCertificate`; the sidecar echoes both the message and the constructor
 * name (`errorName`) in its failure body.
 */
const SEAL_SESSION_EXPIRED_MARKERS = [
    "expiredsessionkeyerror",
    "session key has expired",
    "invalidcertificate",
];

/**
 * True when a rejected response body legibly names an expired SEAL session.
 *
 * Deliberately body-driven rather than status-driven: a bare status match
 * would turn every relayer 500 into a session rebuild plus retry. Note that
 * the relayer redacts `AppError::Internal` bodies, so on a stock deployment
 * this predicate is only reachable when the sidecar's own body survives to the
 * client. See the WALM-162 notes in `memwal.ts` for why proactive refresh —
 * not this recovery path — is the primary fix.
 */
export function isSealSessionExpiredResponse(status: number, rawBody: string): boolean {
    if (Number(status) < 400) return false;
    const haystack = String(rawBody ?? "").toLowerCase();
    if (!haystack) return false;
    return SEAL_SESSION_EXPIRED_MARKERS.some((marker) => haystack.includes(marker));
}

/** Error shape shared by the SEAL session helpers below. */
export type SealSessionError = Error & {
    status?: number;
    serverCode?: string;
    cause?: unknown;
};

/**
 * Deterministic build failures — a missing or too-old `@mysten/sui` /
 * `@mysten/seal`, or a relayer `/config` that cannot describe a Sui transport.
 * These fail identically on every attempt, so they are tagged 400 to stop the
 * documented `withRetry` helper (`docs/sdk/production-readiness.md`) from
 * burning its budget on them.
 *
 * The peer deps are loaded through dynamic `import()`, so the common
 * missing-package case never reaches the hand-written checks below — it throws
 * out of the import itself. Those resolver messages are matched here too.
 *
 * A package that resolves but is too old does NOT throw from the import: the
 * import is a namespace import, so a missing export is just `undefined`.
 * `buildSealSessionInner()` guards `Ed25519Keypair` and `SessionKey` explicitly
 * and produces the "not found in @mysten/..." messages above.
 */
const SEAL_SESSION_PERMANENT_MARKERS = [
    "not found in @mysten/sui",
    "ensure @mysten/sui",
    "get /config response",
    "get /config requires",
    // Node ESM / CJS resolution, bundlers, and a package that resolves but no
    // longer exports what we import.
    "cannot find package",
    "cannot find module",
    "err_module_not_found",
    "failed to resolve module specifier",
];

/** ASCII control characters, stripped from error text before it is surfaced. */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]", "g");

function isPermanentSealSessionFailure(message: string): boolean {
    const lower = message.toLowerCase();
    return SEAL_SESSION_PERMANENT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Wrap whatever `buildSealSessionInner()` threw in an error that says what
 * actually failed and carries a `.status` the documented retry helpers can
 * classify.
 *
 * Without this the raw throw escapes before any `fetch`, so it never passes
 * through `sanitizeServerError` and reaches callers with `status === undefined`
 * — which `withRetry` treats as retryable, so an unfixable missing-peer-dep
 * error gets retried for the full budget while telling the caller nothing
 * about SEAL.
 */
export function sealSessionBuildError(cause: unknown): SealSessionError {
    const detail =
        cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);
    // Strip control chars and loopback URLs, matching `sanitizeServerError`.
    const sanitized = redactInternalUrls(detail.replace(CONTROL_CHARS, " ")).trim();
    const permanent = isPermanentSealSessionFailure(sanitized);
    const err = new Error(
        `Failed to build SEAL session: ${sanitized || "<no message>"}`,
    ) as SealSessionError;
    err.name = "MemWalSealSessionError";
    // 400: deterministic (peer deps / relayer config) — do not retry.
    // 503: transient (Sui RPC, key server, network) — retry with backoff.
    err.status = permanent ? 400 : 503;
    err.serverCode = permanent ? "SEAL_SESSION_UNAVAILABLE" : "SEAL_SESSION_BUILD_FAILED";
    err.cause = cause;
    return err;
}

/**
 * Build the error surfaced when the server rejected our SEAL session as
 * expired *and* a single rebuild-and-retry did not fix it.
 *
 * Tagged 400, not the server's status: the rebuild already happened and failed,
 * so this is terminal. Leaving the wire status (typically 500) on `.status`
 * would make the documented `withRetry` helper and `waitForRememberJob`'s
 * `status >= 500` poll loop keep retrying a clock-skew failure that cannot
 * resolve itself. The real response is preserved on `.cause`.
 */
export function sealSessionExpiredError(status: number, rawBody: string): SealSessionError {
    const err = new Error(
        "SEAL session expired: the relayer rejected this request's SEAL SessionKey even after " +
            "the SDK rebuilt it. This usually means the client clock is skewed relative to the " +
            "SEAL key servers. Check system time; see " +
            "https://docs.wal.app/walrus-memory/troubleshooting/overview",
    ) as SealSessionError;
    err.name = "MemWalSealSessionError";
    err.status = 400;
    err.serverCode = "SEAL_SESSION_EXPIRED";
    err.cause = { status, body: rawBody };
    return err;
}
