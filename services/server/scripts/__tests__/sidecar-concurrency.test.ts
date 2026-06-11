import test from "node:test";
import assert from "node:assert/strict";
import { AsyncSemaphore, WalrusUploadLimitError } from "../sidecar/concurrency.js";

test("acquire resolves immediately while capacity is available", async () => {
    const sem = new AsyncSemaphore(2);
    const release1 = await sem.acquire(50, "test");
    const release2 = await sem.acquire(50, "test");
    assert.deepEqual(sem.snapshot(), { capacity: 2, available: 0, queued: 0 });
    release1();
    release2();
    assert.deepEqual(sem.snapshot(), { capacity: 2, available: 2, queued: 0 });
});

test("waiter acquires the slot after release", async () => {
    const sem = new AsyncSemaphore(1);
    const release1 = await sem.acquire(1_000, "test");
    const pending = sem.acquire(1_000, "test");
    assert.equal(sem.snapshot().queued, 1);
    release1();
    const release2 = await pending;
    assert.deepEqual(sem.snapshot(), { capacity: 1, available: 0, queued: 0 });
    release2();
});

test("waiter times out with WalrusUploadLimitError naming the label", async () => {
    const sem = new AsyncSemaphore(1);
    const release1 = await sem.acquire(1_000, "test");
    await assert.rejects(
        sem.acquire(20, "wallet 3"),
        (err: unknown) => {
            assert.ok(err instanceof WalrusUploadLimitError);
            assert.match((err as Error).message, /wallet 3/);
            return true;
        },
    );
    // The timed-out waiter must be dropped from the queue.
    assert.equal(sem.snapshot().queued, 0);
    release1();
});

test("double release never grows capacity beyond the configured limit", async () => {
    const sem = new AsyncSemaphore(1);
    const release = await sem.acquire(50, "test");
    release();
    release();
    assert.deepEqual(sem.snapshot(), { capacity: 1, available: 1, queued: 0 });
});
