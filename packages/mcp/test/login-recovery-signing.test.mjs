/**
 * WALM-332 — the client's signed request must match the relayer byte for byte.
 *
 * Recovery authenticates with a signature over a canonical message defined in
 * `services/server/src/auth.rs`. The two implementations are in different
 * languages and cannot share code, so the format is duplicated — and a subtle
 * mismatch (a trimmed trailing separator, a dropped empty field) would compile,
 * pass every other test, and fail in production as an opaque 401.
 *
 * The literal below is asserted verbatim in
 * `routes::accounts::tests::whoami_recovery_request_canonical_message_is_stable`.
 * Change one and this fails; change the format in auth.rs and both fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyAsync } from "@noble/ed25519";

const { canonicalRequestMessage, EMPTY_BODY_SHA256 } = await import("../dist/recovery.js");
const { signMessage, hexToBytes } = await import("../dist/crypto.js");
const { generateKeypair } = await import("../dist/crypto.js");

/** Must equal the Rust fixture exactly. */
const PINNED =
    "1700000000.GET./api/whoami." +
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855." +
    "550e8400-e29b-41d4-a716-446655440000.";

test("the client builds the canonical message the relayer expects", () => {
    const message = canonicalRequestMessage({
        timestamp: "1700000000",
        method: "GET",
        path: "/api/whoami",
        bodyHash: EMPTY_BODY_SHA256,
        nonce: "550e8400-e29b-41d4-a716-446655440000",
    });

    assert.equal(message, PINNED, "must match services/server/src/auth.rs byte for byte");
    assert.ok(message.endsWith("."), "the empty account id keeps a trailing separator");
    assert.equal(message.split(".").length - 1, 5, "six fields, five separators");
});

test("the empty-body hash is the real sha256 of nothing", () => {
    assert.equal(EMPTY_BODY_SHA256, createHash("sha256").update("").digest("hex"));
    assert.equal(
        EMPTY_BODY_SHA256,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "the well-known constant the server will compute for a bodyless GET",
    );
});

test("an omitted account id is empty, never the string 'undefined'", () => {
    // A plain template interpolation of an absent value would produce
    // "...undefined" here, which signs cleanly and is rejected by the server
    // with no clue why.
    const message = canonicalRequestMessage({
        timestamp: "1",
        method: "GET",
        path: "/p",
        bodyHash: "h",
        nonce: "n",
    });
    assert.equal(message, "1.GET./p.h.n.");
    assert.doesNotMatch(message, /undefined|null/);
});

test("the signature the client produces verifies against its public key", async () => {
    const kp = await generateKeypair();
    const message = canonicalRequestMessage({
        timestamp: "1700000000",
        method: "GET",
        path: "/api/whoami",
        bodyHash: EMPTY_BODY_SHA256,
        nonce: "550e8400-e29b-41d4-a716-446655440000",
    });

    const sigHex = await signMessage(kp.privateKeyHex, message);
    assert.match(sigHex, /^[0-9a-f]{128}$/, "Ed25519 signatures are 64 bytes");

    const ok = await verifyAsync(
        hexToBytes(sigHex),
        new TextEncoder().encode(message),
        hexToBytes(kp.publicKeyHex),
    );
    assert.equal(ok, true, "the relayer must be able to verify what we signed");

    // And it must not verify a tampered message — otherwise the assertion above
    // proves nothing.
    const tampered = await verifyAsync(
        hexToBytes(sigHex),
        new TextEncoder().encode(message.replace("/api/whoami", "/api/stats")),
        hexToBytes(kp.publicKeyHex),
    );
    assert.equal(tampered, false, "a different path must not verify");
});
