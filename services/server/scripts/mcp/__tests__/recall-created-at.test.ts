/**
 * `memwal_recall` shows each memory's write-time in its output (WALM-383).
 *
 * A model implementing "current state = the newest checkpoint" has to read the
 * date off the result. Before this, the only dates in a recall response were
 * whatever the memory text happened to mention, so the model either guessed or
 * trusted the ranking — and the ranking is by semantic distance, which carries
 * no recency guarantee at all.
 *
 * The relayer now returns `created_at` on every hit; these tests pin that it
 * survives into the rendered lines the model actually sees.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { formatRecallLine } from "../tools/recall.js";

const row = (over: Record<string, unknown> = {}) => ({
    blob_id: "blob-1",
    text: "shipped the composite ranker",
    distance: 0.25,
    ...over,
});

test("renders the write-time alongside the score", () => {
    const line = formatRecallLine(row({ created_at: "2026-07-06T12:00:00Z" }), 0);

    assert.match(line, /2026-07-06/);
    assert.match(line, /shipped the composite ranker/);
});

test("dates are rendered so two results sort lexicographically by recency", () => {
    // The model compares these as strings. An ISO date sorts correctly that
    // way; a localized one ("Jul 6, 2026") does not.
    const older = formatRecallLine(row({ created_at: "2026-07-01T00:00:00Z" }), 0);
    const newer = formatRecallLine(row({ created_at: "2026-07-06T00:00:00Z" }), 1);

    const date = (line: string) => line.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
    assert.ok(date(newer) > date(older));
});

test("omits the date rather than inventing one when the relayer sent none", () => {
    // An older relayer omits `created_at`. Rendering "unknown" or today's date
    // would both be worse than saying nothing: the first is noise on every
    // line, the second is a lie a newest-wins caller would act on.
    const line = formatRecallLine(row(), 0);

    assert.doesNotMatch(line, /\d{4}-\d{2}-\d{2}/);
    assert.match(line, /shipped the composite ranker/);
});

test("keeps the existing numbering and score format", () => {
    // The line prefix is load-bearing for anything parsing recall output.
    const line = formatRecallLine(row({ created_at: "2026-07-06T12:00:00Z" }), 2);

    assert.ok(line.startsWith("3. "), `expected 1-based numbering, got: ${line}`);
    assert.match(line, /\[score=0\.750\]/);
});

test("a malformed created_at is dropped, not rendered raw", () => {
    const line = formatRecallLine(row({ created_at: "not a date" }), 0);

    assert.doesNotMatch(line, /not a date/);
    assert.match(line, /shipped the composite ranker/);
});
