import test from "node:test";
import assert from "node:assert/strict";
import { WalrusClient } from "@mysten/walrus";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { MetadataEncoder } from "../sidecar/metadata-encoder.js";
test("worker preserves metadata, nonce and digest while HTTP event loop stays responsive", async () => {
 const client = new WalrusClient({ network: "testnet", suiClient: new SuiGrpcClient({network:"testnet",baseUrl:"https://fullnode.testnet.sui.io:443"}) });
 const worker = new MetadataEncoder();
 const fetchBefore = globalThis.fetch;
 globalThis.fetch = async () => { throw new Error("metadata encoding must not fetch"); };
 try {
  const input = { bytes: new Uint8Array(328).fill(42), nonce: new Uint8Array(32).fill(7), numShards: 1000 };
  const expected = await client.computeBlobMetadata(input);
  let ticks = 0; const timer = setInterval(() => ticks++, 10);
  const actual = await Promise.all(Array.from({length:3}, () => worker.compute(input)));
  clearInterval(timer);
  assert.ok(ticks > 2, `event loop did not progress (${ticks} ticks)`);
  const otherNonce = new Uint8Array(32).fill(8);
  const cached = await worker.compute({ ...input, nonce: otherNonce });
  assert.deepEqual(cached.nonce, otherNonce);
  assert.equal(cached.blobId, expected.blobId);
  for (const item of actual) {
   assert.equal(item.blobId, expected.blobId);
   assert.deepEqual(item.rootHash, expected.rootHash);
   assert.deepEqual(item.metadata, expected.metadata);
   assert.deepEqual(item.nonce, expected.nonce);
   assert.deepEqual(await item.blobDigest(), await expected.blobDigest());
  }
 } finally { globalThis.fetch = fetchBefore; await worker.close(); }
});

test("closed encoder restarts for a subsequent request", async () => {
 const worker = new MetadataEncoder();
 const input = { bytes: new Uint8Array(32), nonce: new Uint8Array(32), numShards: 10 };
 try {
  const first = await worker.compute(input);
  await worker.close();
  const second = await worker.compute(input);
  assert.equal(first.blobId, second.blobId);
 } finally { await worker.close(); }
});

test("worker shutdown rejects in-flight work and can recover", async () => {
 const worker = new MetadataEncoder();
 const pending = worker.compute({ bytes: new Uint8Array(328), numShards: 1000 });
 const rejected = assert.rejects(pending, /encoder exited/);
 await worker.close();
 await rejected;
 try {
  const result = await worker.compute({ bytes: new Uint8Array(32), numShards: 10 });
  assert.ok(result.blobId);
 } finally { await worker.close(); }
});
