import assert from "node:assert/strict";
import test from "node:test";
import { summariseBulk } from "../tools/remember-bulk.js";

const mk = (statuses: string[]) => ({
    results: statuses.map((status, i) => ({ status, id: `job-${i + 1}` })),
    total: statuses.length,
    succeeded: statuses.filter((s) => s === "done").length,
    // What the SDK computes: total - succeeded, folding timeout into failed.
    failed: statuses.length - statuses.filter((s) => s === "done").length,
});

// Observed on dev: a bulk reported `failed=1` while `memwal_recall` found all
// five facts present. The item had not failed — it had not finished yet, and
// landed shortly after. Calling that "failed" invites a re-save, and
// /api/remember/bulk has no idempotency key, so the re-save is a second paid
// blob that recall then hides behind the first.
test("an unfinished item is never reported as failed", () => {
    const text = summariseBulk(mk(["done", "done", "done", "done", "timeout"]));

    assert.match(text, /Saved 4\/5/);
    assert.doesNotMatch(text, /failed/i, "nothing failed here");
    assert.match(text, /1 still finishing/);
    assert.match(text, /do NOT save them again/);
    assert.match(text, /second paid copy/);
    assert.match(text, /memwal_recall/);
    assert.match(text, /job job-5/, "the agent needs a handle for the pending item");
});

test("a real failure is still called a failure", () => {
    const text = summariseBulk(mk(["done", "failed", "done"]));
    assert.match(text, /Saved 2\/3/);
    assert.match(text, /1 failed/);
    assert.doesNotMatch(text, /still finishing/);
});

test("failures and unfinished items are counted apart", () => {
    const text = summariseBulk(mk(["done", "failed", "timeout", "timeout"]));
    assert.match(text, /Saved 1\/4/);
    assert.match(text, /1 failed/);
    assert.match(text, /2 still finishing/);
});

test("a fully successful batch says nothing alarming", () => {
    const text = summariseBulk(mk(["done", "done", "done"]));
    assert.match(text, /Saved 3\/3/);
    assert.doesNotMatch(text, /failed/i);
    assert.doesNotMatch(text, /still finishing/);
});

test("a results array that disagrees with total falls back to the SDK counts", () => {
    // Never silently contradict the SDK about how many items there were.
    const text = summariseBulk({
        results: [{ status: "done", id: "a" }],
        total: 3,
        succeeded: 1,
        failed: 2,
    });
    assert.match(text, /Saved 1\/3/);
    assert.match(text, /failed=2/);
});
