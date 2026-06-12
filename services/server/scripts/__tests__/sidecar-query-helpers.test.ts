import test from "node:test";
import assert from "node:assert/strict";
import {
    blobIdFromRaw,
    isWalrusBlobObjectType,
    ownerMatchesRecipient,
} from "../sidecar/routes/walrus-query.js";

test("blobIdFromRaw converts on-chain U256 decimal to little-endian base64url", () => {
    // 1 → 32-byte LE array [1, 0, ..., 0] → "AQAA...". Walrus blob IDs are
    // unpadded base64url of the 32-byte little-endian representation.
    const oneLe = Buffer.from(new Uint8Array([1, ...new Array(31).fill(0)]));
    assert.equal(blobIdFromRaw("1".padStart(21, "0")), oneLe.toString("base64url"));
});

test("blobIdFromRaw passes through already-encoded ids and rejects empties", () => {
    assert.equal(blobIdFromRaw("AbCd_efg"), "AbCd_efg");
    // Short decimal strings (≤20 chars) are not treated as U256.
    assert.equal(blobIdFromRaw("12345"), "12345");
    assert.equal(blobIdFromRaw(null), null);
    assert.equal(blobIdFromRaw(undefined), null);
    assert.equal(blobIdFromRaw(""), null);
});

test("ownerMatchesRecipient handles string and object owner encodings", () => {
    assert.equal(ownerMatchesRecipient("0xa", "0xa"), true);
    assert.equal(ownerMatchesRecipient({ AddressOwner: "0xa" }, "0xa"), true);
    assert.equal(ownerMatchesRecipient({ ObjectOwner: "0xa" }, "0xa"), true);
    assert.equal(ownerMatchesRecipient({ AddressOwner: "0xb" }, "0xa"), false);
    assert.equal(ownerMatchesRecipient(null, "0xa"), false);
    assert.equal(ownerMatchesRecipient(42, "0xa"), false);
});

test("isWalrusBlobObjectType normalizes 0x-padded package addresses", () => {
    const blobType = "0xfdc88f7d::blob::Blob";
    assert.equal(isWalrusBlobObjectType("0xfdc88f7d::blob::Blob", blobType), true);
    assert.equal(isWalrusBlobObjectType("0x000fdc88f7d::blob::Blob", blobType), true);
    assert.equal(isWalrusBlobObjectType("0xFDC88F7D::blob::Blob", blobType), true);
    assert.equal(isWalrusBlobObjectType("0xother::blob::Blob", blobType), false);
    assert.equal(isWalrusBlobObjectType("0xfdc88f7d::storage::Blob", blobType), false);
    assert.equal(isWalrusBlobObjectType(undefined, blobType), false);
});
