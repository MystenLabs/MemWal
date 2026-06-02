import assert from "node:assert/strict";
import test from "node:test";

import { isWalrusBlobObjectMissingFromEffects } from "../walrus-error-detection.js";

test("detects Walrus blob object missing from transaction effects", () => {
    const message =
        "walrus upload failed: Internal Error: walrus upload failed: " +
        "Blob object not found in transaction effects for transaction " +
        "(EZkVUtPRGGW8NehBemRpoxx6yHCxjNazVxgy3uiNj7Qc)";

    assert.equal(isWalrusBlobObjectMissingFromEffects(message), true);
});

test("matches case-insensitively", () => {
    assert.equal(
        isWalrusBlobObjectMissingFromEffects("blob object NOT found in TRANSACTION effects"),
        true,
    );
});

test("does not match unrelated Walrus or Enoki errors", () => {
    assert.equal(isWalrusBlobObjectMissingFromEffects("Sponsored transaction has expired"), false);
    assert.equal(isWalrusBlobObjectMissingFromEffects("Could not find the referenced object at version None"), false);
    assert.equal(isWalrusBlobObjectMissingFromEffects("Blob expired or not found across aggregators"), false);
    assert.equal(isWalrusBlobObjectMissingFromEffects(""), false);
});
