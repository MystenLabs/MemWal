/**
 * `memwal_recall` reports writes that were accepted and then failed.
 *
 * `memwal_remember` returns as soon as the relayer accepts the job, which
 * leaves a window where the write still dies — a SEAL outage, an exhausted
 * upload budget — with nobody listening. `memwal_remember_status` can settle
 * one job, but nothing obliges an agent to call it, and storing a memory is
 * typically the last thing it does in a turn. An unasked question is the same
 * as a silent loss, and silent loss is the worst outcome for a product whose
 * whole promise is durable memory.
 *
 * Recall is the call an agent always makes, so the report rides along there.
 * These tests pin the rendering, and in particular that it never claims
 * anything when the relayer said nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { formatFailedWrites } from "../tools/recall.js";

test("says nothing when the relayer reported no failures", () => {
    assert.equal(formatFailedWrites({ results: [], total: 0 }), "");
    assert.equal(formatFailedWrites({ failed_writes: [] }), "");
});

test("says nothing when the relayer predates the field", () => {
    // An older deployment omits `failed_writes` entirely. That must read as
    // "nothing to report", never as an error or an empty warning banner.
    assert.equal(formatFailedWrites({ results: [] }), "");
    assert.equal(formatFailedWrites(null), "");
    assert.equal(formatFailedWrites(undefined), "");
    assert.equal(formatFailedWrites({ failed_writes: "not-an-array" }), "");
});

test("names the job and states plainly that the fact is not stored", () => {
    const text = formatFailedWrites({
        failed_writes: [
            {
                job_id: "9d304948-c693-408c-aac7-d7ef9ab98f5d",
                namespace: "default",
                error: "Memory encryption backend is unavailable",
                failed_at: "2026-09-15T15:10:11Z",
            },
        ],
    });

    assert.match(text, /NOT stored/);
    assert.match(text, /9d304948-c693-408c-aac7-d7ef9ab98f5d/);
    assert.match(text, /ns=default/);
    // The relayer's own message is passed through: the difference between a
    // SEAL outage and a spent retry budget is what tells the caller whether
    // re-sending is likely to work.
    assert.match(text, /Memory encryption backend is unavailable/);
    assert.match(text, /memwal_remember/);
});

test("reads as singular for one failure and plural for several", () => {
    const one = formatFailedWrites({
        failed_writes: [{ job_id: "a", namespace: "default" }],
    });
    assert.match(one, /1 earlier write was accepted/);
    assert.match(one, /that fact is\b/);

    const many = formatFailedWrites({
        failed_writes: [
            { job_id: "a", namespace: "default" },
            { job_id: "b", namespace: "default" },
        ],
    });
    assert.match(many, /2 earlier writes were accepted/);
    assert.match(many, /those facts are\b/);
});

test("survives a malformed entry rather than dropping the whole report", () => {
    // The warning matters more than its formatting: a row missing fields must
    // still be surfaced, because the alternative is the silent loss this
    // exists to prevent.
    const text = formatFailedWrites({
        failed_writes: [{}, { job_id: "b6da0c96", error: "   " }],
    });

    assert.match(text, /2 earlier writes were accepted/);
    assert.match(text, /\(unknown job\)/);
    assert.match(text, /b6da0c96/);
    // A blank error string adds no information, so it is left off entirely
    // rather than rendered as a dangling dash.
    assert.doesNotMatch(text, /b6da0c96.*—/);
});
