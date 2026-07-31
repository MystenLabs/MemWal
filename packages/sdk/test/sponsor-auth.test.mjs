import assert from "node:assert/strict";
import test from "node:test";

import { sponsorAuthorizationMessage } from "../dist/index.js";

test("sponsor authorization message binds sender, transaction bytes, timestamp, and nonce", async () => {
    const message = await sponsorAuthorizationMessage(
        "0xabc",
        new Uint8Array([1, 2, 3]),
        1_700_000_000,
        "00000000-0000-4000-8000-000000000000",
    );
    assert.equal(
        message,
        [
            "MemWal sponsor authorization",
            "sender: 0xabc",
            "transaction-kind-sha256: 039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
            "timestamp: 1700000000",
            "nonce: 00000000-0000-4000-8000-000000000000",
        ].join("\n"),
    );
});
