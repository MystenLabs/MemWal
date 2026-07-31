import assert from "node:assert/strict";
import test from "node:test";

import { parseSuiNetwork } from "../sidecar/sui-transport-policy.js";

test("network parsing normalizes canonical variants and rejects unknown values", () => {
    assert.equal(parseSuiNetwork(" TESTNET "), "testnet");
    assert.throws(() => parseSuiNetwork("test-net"), /unsupported SUI_NETWORK/);
});
