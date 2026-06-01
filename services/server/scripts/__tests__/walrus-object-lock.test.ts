import assert from "node:assert/strict";
import test from "node:test";

import { isWalrusObjectLockEquivocation } from "../walrus-error-detection.js";

// Exact production error from the object-lock incident (testnet job 3d607892…).
const PROD_OBJECT_LOCK_ERROR =
    "walrus upload failed: Internal Error: walrus upload failed: " +
    "Transaction is rejected as invalid by more than 1/3 of validators by stake (non-retriable). " +
    "Non-retriable errors: [Object (0x36f866a4d400ec3dd5d8b0bac30cc36ab6d56172634a6b4dea9e2a554a43b08e, " +
    "SequenceNumber(884613305), o#B61aVqEgDskxru255FTdzua2RxbbnhDMFxmQ8SCxvj3n) already locked by a " +
    "different transaction: TransactionDigest(8bjFgRyXRRYwrzQapgEjpHnGhdfNDY7d6xA82BtHrp3F) with 6842 stake].";

test("detects the exact production object-lock error", () => {
    assert.equal(isWalrusObjectLockEquivocation(PROD_OBJECT_LOCK_ERROR), true);
});

test("detects each equivocation phrase variant", () => {
    const cases = [
        "object 0xabc already locked by a different transaction",
        "rejected as invalid by more than 1/3 of validators by stake",
        "this error is non-retriable",
        "the input object is equivocated",
        "equivocation detected on gas coin",
        "object reserved for another transaction",
    ];
    for (const msg of cases) {
        assert.equal(isWalrusObjectLockEquivocation(msg), true, msg);
    }
});

test("matching is case-insensitive", () => {
    assert.equal(
        isWalrusObjectLockEquivocation("ALREADY LOCKED BY A DIFFERENT TRANSACTION"),
        true,
    );
});

test("recoverable lock-at-version is NOT an equivocation", () => {
    // This class is retryable (rebuild against a fresh version) and must not be
    // swept into the abort path.
    assert.equal(
        isWalrusObjectLockEquivocation("object is locked at version 17"),
        false,
    );
});

test("unrelated errors and empty input do not match", () => {
    assert.equal(isWalrusObjectLockEquivocation("connection refused"), false);
    assert.equal(isWalrusObjectLockEquivocation("MoveAbort(0x2::balance, split, 2)"), false);
    assert.equal(isWalrusObjectLockEquivocation(""), false);
});
