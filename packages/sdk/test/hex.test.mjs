import assert from "node:assert/strict";
import test from "node:test";

import { hexToBytes } from "../dist/utils.js";

test("hexToBytes round-trips even hex", () => {
    assert.deepEqual(hexToBytes("deadbeef"), Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
    assert.deepEqual(hexToBytes("0xdeadbeef"), Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
    assert.deepEqual(hexToBytes("0XDEADBEEF"), Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
});

test("hexToBytes rejects empty, odd-length, and non-hex input", () => {
    assert.throws(() => hexToBytes(""), /empty hex string/);
    assert.throws(() => hexToBytes("0x"), /empty hex string/);
    assert.throws(() => hexToBytes("abc"), /odd-length/);
    assert.throws(() => hexToBytes("zz"), /non-hex/);
    assert.throws(() => hexToBytes("ab  cd"), /non-hex/);
});
