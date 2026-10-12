import { describe, test } from "node:test";
import assert from "node:assert/strict";

process.env.WALRUS_UPLOAD_MAX_CONCURRENCY = "1";
process.env.WALRUS_UPLOAD_PER_WALLET_CONCURRENCY = "1";
process.env.WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS = "1000";

const { acquireWalrusUploadSlots, getUploadCounts, setJobSlotIdleMsForTests, walrusUploadLimitSnapshot } =
  await import("../sidecar/concurrency.js");

describe("upload slots", { concurrency: 1 }, () => {
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

test("a disconnected waiter never becomes the next holder", async () => {
  const held = await acquireWalrusUploadSlots(0, "holder");
  const controller = new AbortController();
  const dropped = acquireWalrusUploadSlots(1, "dropped", "dropped-job", { signal: controller.signal });
  controller.abort();
  await assert.rejects(dropped, /disconnected/);
  assert.deepEqual(getUploadCounts(), { active: 1, queued: 0 });
  held();
  const next = await acquireWalrusUploadSlots(1, "next-holder");
  next();
  assert.deepEqual(getUploadCounts(), { active: 0, queued: 0 });
});

test("one job keeps the slot across steps and releases it when the write finishes", async () => {
  const encode = await acquireWalrusUploadSlots(0, "encode", "job-lease", { holdForJob: true });
  const other = acquireWalrusUploadSlots(1, "other", "job-other");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(getUploadCounts(), { active: 1, queued: 1 });
  const register = await acquireWalrusUploadSlots(0, "register", "job-lease", { holdForJob: true });
  assert.equal(getUploadCounts().queued, 1);
  encode();
  assert.equal(getUploadCounts().active, 1);
  register.finishJob();
  register();
  const releaseOther = await other;
  releaseOther();
  assert.deepEqual(getUploadCounts(), { active: 0, queued: 0 });
});

test("an idle job slot frees itself so a dropped client cannot pin it", async () => {
  setJobSlotIdleMsForTests(40);
  try {
    const step = await acquireWalrusUploadSlots(0, "idle-step", "job-idle", { holdForJob: true });
    step();
    assert.equal(getUploadCounts().active, 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(getUploadCounts(), { active: 0, queued: 0 });
  } finally {
    setJobSlotIdleMsForTests(15_000);
  }
});
});
