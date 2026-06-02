import assert from "node:assert/strict";
import test from "node:test";

import { isWalrusReferencedObjectStale } from "../walrus-error-detection.js";

test("detects Enoki dry-run referenced object stale at explicit version", () => {
    const message =
        "Enoki API error (400): {\"errors\":[{\"code\":\"dry_run_failed\"," +
        "\"message\":\"Error checking transaction input objects: Could not find the " +
        "referenced object 0xea1d755680a7ccd1993dcdde2a71c9cd55f8c9eb2f2d0e1159e41f3f704cef47 " +
        "at version Some(SequenceNumber(899729259))\"}]}";

    assert.equal(isWalrusReferencedObjectStale(message), true);
});

test("detects Enoki dry-run referenced object stale at version None", () => {
    const message =
        "Enoki API error (400): {\"errors\":[{\"code\":\"dry_run_failed\"," +
        "\"message\":\"Error checking transaction input objects: Could not find the " +
        "referenced object 0xef8882011d25fc9ad6efab30a6ca14bb36e000e32cac84629407bc10cd09528c " +
        "at version None\"}]}";

    assert.equal(isWalrusReferencedObjectStale(message), true);
});

test("does not match unrelated dry-run or object errors", () => {
    assert.equal(isWalrusReferencedObjectStale("dry_run_failed: MoveAbort in balance::split"), false);
    assert.equal(isWalrusReferencedObjectStale("Could not find the referenced object 0xabc"), false);
    assert.equal(isWalrusReferencedObjectStale("connection refused"), false);
    assert.equal(isWalrusReferencedObjectStale(""), false);
});
