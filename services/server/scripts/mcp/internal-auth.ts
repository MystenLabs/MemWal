/**
 * =============================================================================
 * MCP INTERNAL-ORIGIN VERIFICATION
 * =============================================================================
 * `x-memwal-internal-*` headers carry decisions the relayer has already made
 * (currently the resolved OAuth scope). They are trusted input, so the sidecar
 * must confirm they actually came from the relayer before reading any of them.
 *
 * `/mcp/*` is mounted BEFORE `sharedSecretAuthMiddleware` (sidecar/app.ts)
 * because the `Authorization` header already carries the end user's delegate
 * key, leaving no room for the sidecar's shared secret. The relayer therefore
 * presents the same secret in a dedicated internal header instead.
 *
 * `SIDECAR_AUTH_TOKEN` is read from the environment on every call rather than
 * imported from sidecar/middleware.ts, whose module-level `process.exit(1)`
 * guard would fire inside unit tests that never intend to boot the sidecar.
 * =============================================================================
 */
import { timingSafeEqual } from "node:crypto";

export const INTERNAL_TOKEN_HEADER = "x-memwal-internal-sidecar-token";

export function verifyInternalOrigin(headers: Headers): boolean {
    const expected = process.env.SIDECAR_AUTH_TOKEN;
    if (!expected) return false;

    const provided = headers.get(INTERNAL_TOKEN_HEADER);
    if (provided === null) return false;

    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);
    // timingSafeEqual requires equal lengths; a length mismatch is already a
    // mismatch, so short-circuit rather than throwing.
    return providedBuf.length === expectedBuf.length
        && timingSafeEqual(providedBuf, expectedBuf);
}
