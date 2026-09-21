import test from "node:test";
import assert from "node:assert/strict";

process.env.WALRUS_UPLOAD_MAX_CONCURRENCY = "1";
process.env.WALRUS_UPLOAD_PER_WALLET_CONCURRENCY = "1";
process.env.WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS = "1000";

const { acquireWalrusUploadSlots, getUploadCounts, walrusUploadLimitSnapshot } =
  await import("../sidecar/concurrency.js");

test("global acquire timeout releases the wallet reservation and queue count", async () => {
  const release = await acquireWalrusUploadSlots(0, "held-global");
  try {
    await assert.rejects(
      acquireWalrusUploadSlots(1, "queued-global"),
      /global upload slot/
    );
    assert.deepEqual(getUploadCounts(), { active: 1, queued: 0 });
    assert.deepEqual(walrusUploadLimitSnapshot(1).wallet, {
      capacity: 1,
      available: 1,
      queued: 0,
    });
  } finally {
    release();
  }
  const releaseNext = await acquireWalrusUploadSlots(1, "after-timeout");
  releaseNext();
  assert.deepEqual(getUploadCounts(), { active: 0, queued: 0 });
});

test("releasing an old holder twice cannot free a successor's slot", async () => {
  const releaseFirst = await acquireWalrusUploadSlots(0, "first");
  const second = acquireWalrusUploadSlots(0, "second");
  releaseFirst();
  const releaseSecond = await second;
  try {
    releaseFirst();
    assert.deepEqual(getUploadCounts(), { active: 1, queued: 0 });
    assert.deepEqual(walrusUploadLimitSnapshot(0).wallet, {
      capacity: 1,
      available: 0,
      queued: 0,
    });
  } finally {
    releaseSecond();
  }
  assert.deepEqual(getUploadCounts(), { active: 0, queued: 0 });
});
