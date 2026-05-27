import assert from "node:assert/strict";
import test from "node:test";

import { isWalrusPackageVersionMismatch } from "../walrus-error-detection.js";

// Production format reference: @mysten/sui's formatMoveAbortMessage builds
// the location segment as '0x<hex>::system::inner_mut'. EWrongVersion = 1
// in walrus::system. See packages/sui/src/client/utils.ts:36-72 and
// contracts/walrus/sources/system.move:26.

test("matches JSON-RPC production format (abort code, no symbolic name)", () => {
    // Real shape: WalrusClientError -> "Failed to <action> (<digest>): MoveAbort..."
    const message =
        "Failed to register blob (0xabcd1234): MoveAbort in 1st command, " +
        "abort code: 1, in '0xc1b6d04d6f8bb89cf68fbdc4e90c0d40b1f3e8e2c3a4b5c6d7e8f9a0b1c2d3e4f::system::inner_mut' (instruction 0)";
    assert.equal(isWalrusPackageVersionMismatch(message), true);
});

test("matches gRPC/GraphQL production format (symbolic EWrongVersion)", () => {
    const message =
        "Failed to certify blob (0xabcd1234): MoveAbort in 1st command, " +
        "'EWrongVersion': 1, in '0xc1b6d04d6f8bb89cf68fbdc4e90c0d40b1f3e8e2c3a4b5c6d7e8f9a0b1c2d3e4f::system::inner_mut' (line 42)";
    assert.equal(isWalrusPackageVersionMismatch(message), true);
});

test("matches even if only the EWrongVersion symbolic name is present (no location)", () => {
    // Defensive: some upstream wrappers may strip the location segment.
    assert.equal(
        isWalrusPackageVersionMismatch("MoveAbort EWrongVersion"),
        true,
    );
});

test("matches even if only ::system::inner_mut is present (no EWrongVersion)", () => {
    // Defensive: matches the location-anchored shape without the symbolic name.
    assert.equal(
        isWalrusPackageVersionMismatch(
            "MoveAbort in 1st command, abort code: 1, in '0xabc::system::inner_mut' (instruction 0)",
        ),
        true,
    );
});

test("is case-insensitive on all anchors", () => {
    assert.equal(
        isWalrusPackageVersionMismatch("moveabort ewrongversion"),
        true,
    );
    assert.equal(
        isWalrusPackageVersionMismatch("MOVEABORT ::SYSTEM::INNER_MUT"),
        true,
    );
});

test("bare EWrongVersion without MoveAbort context is rejected", () => {
    // Guards against random log lines containing the enum name.
    assert.equal(isWalrusPackageVersionMismatch("EWrongVersion"), false);
});

test("bare ::system::inner_mut without MoveAbort context is rejected", () => {
    assert.equal(
        isWalrusPackageVersionMismatch("function ::system::inner_mut called"),
        false,
    );
});

test("MoveAbort from a different module (balance EInsufficient) does not match", () => {
    // EWrongVersion=1 collides numerically with many other modules' abort codes;
    // we must NOT match purely on "abort code: 1" — anchor requires inner_mut OR EWrongVersion.
    const message =
        "MoveAbort in 1st command, abort code: 1, in '0x2::balance::split' (instruction 4)";
    assert.equal(isWalrusPackageVersionMismatch(message), false);
});

test("balance::split MoveAbort (the existing handler's domain) does not match this detector", () => {
    // Ensures we don't double-fire on the existing isMoveAbortBalanceSplit path.
    const message =
        "MoveAbort(MoveLocation { module: balance, function: split }, 2)";
    assert.equal(isWalrusPackageVersionMismatch(message), false);
});

test("unrelated network errors do not match", () => {
    assert.equal(isWalrusPackageVersionMismatch("connection refused"), false);
    assert.equal(isWalrusPackageVersionMismatch("ECONNRESET"), false);
    assert.equal(
        isWalrusPackageVersionMismatch("HTTP 500 from upload relay"),
        false,
    );
});

test("empty / nullish-string inputs do not match", () => {
    // Cast to string so this stays clean under any tsconfig strictness — the
    // helper's runtime guard against undefined / null is the contract we're
    // testing, not the static type narrowing.
    assert.equal(isWalrusPackageVersionMismatch(""), false);
    assert.equal(isWalrusPackageVersionMismatch(undefined as unknown as string), false);
    assert.equal(isWalrusPackageVersionMismatch(null as unknown as string), false);
});
