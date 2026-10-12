import test from "node:test";
import assert from "node:assert/strict";

// The 9s encode hold on the 75-write bench is not one local encode.
// Relay uploads call computeMetadata; direct uploads also build slivers.
// Both are synchronous WASM on the sidecar event loop. 1000 is the shard
// count this measurement used; a single 332-byte blob must stay well under
// that 9s or the "event loop, not the slot" conclusion is wrong.
test("one 332-byte walrus encode does not take the observed 9s", async () => {
    const wasm = await import(new URL("../node_modules/@mysten/walrus/dist/wasm.mjs", import.meta.url).href);
    const bytes = new Uint8Array(332);
    bytes[0] = 7;
    const bindings = await wasm.getWasmBindings(undefined);
    const shards = 1000;
    const metaStart = performance.now();
    bindings.computeMetadata(shards, bytes);
    const metaMs = performance.now() - metaStart;
    const encodeStart = performance.now();
    bindings.encodeBlob(shards, bytes);
    const encodeMs = performance.now() - encodeStart;
    assert.ok(metaMs < 3_000, `computeMetadata took ${metaMs.toFixed(0)}ms`);
    assert.ok(encodeMs < 3_000, `encodeBlob took ${encodeMs.toFixed(0)}ms`);
    console.log(JSON.stringify({
        bytes: bytes.length,
        shards,
        computeMetadataMs: Number(metaMs.toFixed(1)),
        encodeBlobMs: Number(encodeMs.toFixed(1)),
    }));
});
