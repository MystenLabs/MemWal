/**
 * `memwal_recall` can cut weakly related top-K hits with `maxDistance`.
 *
 * The sidecar is pinned to an SDK that may not accept object-form
 * `recall({ maxDistance })`, so the cutoff is applied here on `result.results`
 * — same polarity as the SDK: cosine distance, keep `distance < maxDistance`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { emptyRecallText, filterByMaxDistance, formatRecallLine } from "../tools/recall.js";

const row = (text: string, distance: number) => ({ text, distance });

test("omitting maxDistance leaves every hit in place", () => {
    const results = [
        row("close", 0.1),
        row("far", 0.9),
    ];
    assert.deepEqual(filterByMaxDistance(results), results);
    assert.deepEqual(filterByMaxDistance(results, undefined), results);
});

test("drops hits whose distance is at or above maxDistance", () => {
    const kept = filterByMaxDistance(
        [row("kept", 0.49), row("equal", 0.5), row("worse", 0.9)],
        0.5,
    );
    assert.deepEqual(
        kept.map((m) => m.text),
        ["kept"],
    );
});

test("keeps hits whose distance is below maxDistance", () => {
    const kept = filterByMaxDistance([
        row("best", 0.1),
        row("ok", 0.499),
        row("boundary", 0.5),
    ], 0.5);
    assert.deepEqual(
        kept.map((m) => ({ text: m.text, distance: m.distance })),
        [
            { text: "best", distance: 0.1 },
            { text: "ok", distance: 0.499 },
        ],
    );
});

test("all hits outside maxDistance does not use decrypt-failure wording", () => {
    const results = [row("far", 0.9), row("farther", 1.1)];
    const filtered = filterByMaxDistance(results, 0.5);
    assert.equal(filtered.length, 0);
    const text = emptyRecallText(results.length, 3);
    assert.match(text, /outside maxDistance/);
    assert.doesNotMatch(text, /decrypt/);
    assert.doesNotMatch(text, /download/);
});

test("displayed score is 1 minus cosine distance", () => {
    const line = formatRecallLine(
        { text: "shipped the composite ranker", distance: 0.25 },
        0,
    );
    assert.match(line, /\[score=0\.750 distance=0\.250\]/);
    assert.equal((1 - 0.25).toFixed(3), "0.750");
});
