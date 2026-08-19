/**
 * `memwal_recall` collapses identical results before they reach the model.
 *
 * Observed on a real dev account: a `limit=5` recall returned the same fact
 * five times, consuming the entire retrieval budget on one preference and
 * crowding out every other memory the query should have surfaced.
 *
 * That is expected on the write side. Each remember is a distinct event with
 * its own blob and timestamp, and there is no content-level uniqueness
 * constraint by design (the only unique index is request idempotency on
 * `remember_jobs (owner, idempotency_key)`, which guards retries, not content).
 * So the fix belongs on the read side, and these tests pin that behavior.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { collapseDuplicates } from "../tools/recall.js";

const row = (text: string, distance = 0.5) => ({ text, distance });

test("collapses identical texts and reports the count", () => {
    const { unique, collapsed } = collapseDuplicates([
        row("User prefers dark roast coffee"),
        row("User prefers dark roast coffee"),
        row("User prefers dark roast coffee"),
        row("User prefers dark roast coffee"),
        row("User prefers dark roast coffee"),
    ]);
    assert.equal(unique.length, 1);
    assert.equal(collapsed, 4);
});

test("keeps the highest scoring copy", () => {
    // recall returns rows ranked best-first, so the survivor must be the first
    // one seen, not an arbitrary map entry.
    const { unique } = collapseDuplicates([
        row("same fact", 0.1),
        row("same fact", 0.9),
    ]);
    assert.equal(unique.length, 1);
    assert.equal(unique[0].distance, 0.1);
});

test("normalizes whitespace and case before comparing", () => {
    const { unique, collapsed } = collapseDuplicates([
        row("User prefers dark roast coffee"),
        row("  user prefers   DARK roast coffee  "),
    ]);
    assert.equal(unique.length, 1);
    assert.equal(collapsed, 1);
});

test("preserves rank order of the survivors", () => {
    const { unique } = collapseDuplicates([
        row("first", 0.1),
        row("second", 0.2),
        row("first", 0.3),
        row("third", 0.4),
    ]);
    assert.deepEqual(
        unique.map((m) => m.text),
        ["first", "second", "third"],
    );
});

test("leaves distinct facts untouched", () => {
    // The common case must not lose anything. A dedupe that is too eager is
    // worse than the duplicates it removes.
    const { unique, collapsed } = collapseDuplicates([
        row("deploy region is ap-southeast-1"),
        row("prefers dark roast coffee"),
        row("uses pnpm, not npm"),
    ]);
    assert.equal(unique.length, 3);
    assert.equal(collapsed, 0);
});

test("does not merely substring-match distinct facts", () => {
    // "coffee" appearing in both must not collapse them: these are different
    // statements and losing either would be a silent data loss bug.
    const { unique, collapsed } = collapseDuplicates([
        row("User prefers dark roast coffee"),
        row("User prefers dark roast coffee in the morning only"),
    ]);
    assert.equal(unique.length, 2);
    assert.equal(collapsed, 0);
});

test("handles an empty result set", () => {
    const { unique, collapsed } = collapseDuplicates([]);
    assert.equal(unique.length, 0);
    assert.equal(collapsed, 0);
});
