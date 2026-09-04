import test from "node:test";
import assert from "node:assert/strict";
import {
    decodeMemwalV2Envelope,
    encodeMemwalV2Envelope,
    MEMWAL_V2_MAGIC,
    namespaceSealKeyId,
} from "../sidecar/v2-envelope.js";

const NS = `0x${"00".repeat(30)}cafe`;
const DEK = Buffer.alloc(32, 7);
const PLAINTEXT = Buffer.from("hello memwal v2");

test("envelope roundtrip preserves plaintext and D3 layout", () => {
    const nonce = Buffer.alloc(12, 3);
    const { envelope, ciphertextDigest } = encodeMemwalV2Envelope({
        dek: DEK,
        plaintext: PLAINTEXT,
        namespaceId: NS,
        keyVersion: 1n,
        nonce,
    });
    assert.equal(envelope.subarray(0, 8).toString(), "MEMWALV2");
    assert.equal(envelope[8], 1);
    assert.deepEqual(Buffer.from(envelope.subarray(9, 41)), Buffer.from(NS.slice(2), "hex"));
    assert.deepEqual(Buffer.from(envelope.subarray(41, 49)), Buffer.from("0100000000000000", "hex"));
    assert.deepEqual(Buffer.from(envelope.subarray(49, 61)), nonce);
    const ctLen = envelope.readUInt32LE(61);
    assert.equal(envelope.length, 8 + 1 + 32 + 8 + 12 + 4 + ctLen);
    assert.equal(ciphertextDigest.length, 32);
    const decrypted = decodeMemwalV2Envelope({ dek: DEK, envelope });
    assert.deepEqual(decrypted, PLAINTEXT);
});

test("envelope decrypt rejects a wrong DEK", () => {
    const { envelope } = encodeMemwalV2Envelope({
        dek: DEK,
        plaintext: PLAINTEXT,
        namespaceId: NS,
        keyVersion: 0n,
    });
    assert.throws(() => decodeMemwalV2Envelope({ dek: Buffer.alloc(32, 1), envelope }));
});

test("40-byte seal suffix is BCS(namespace_id) || BCS(key_version u64 LE)", () => {
    const suffix = namespaceSealKeyId(NS, 1n);
    assert.equal(suffix.length, 40);
    assert.equal(Buffer.from(suffix).toString("hex").slice(0, 64), "00".repeat(30) + "cafe");
    assert.equal(Buffer.from(suffix.subarray(32)).toString("hex"), "0100000000000000");
    const zero = namespaceSealKeyId(NS, 0n);
    assert.equal(Buffer.from(zero.subarray(32)).toString("hex"), "0000000000000000");
});

test("magic constant is MEMWALV2", () => {
    assert.equal(MEMWAL_V2_MAGIC.toString(), "MEMWALV2");
    assert.equal(MEMWAL_V2_MAGIC.length, 8);
});
