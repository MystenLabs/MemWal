import assert from "node:assert/strict";
import test from "node:test";

import {
    estimateTokens,
    truncateToTokenBudget,
    applyTokenBudget,
    CHARS_PER_TOKEN,
} from "../dist/index.js";

// Helper: build a RecallMemory-like hit with text of a known char length.
function hit(text, distance) {
    return { blob_id: `blob-${distance}`, text, distance };
}
// A string of exactly `chars` ASCII chars → estimateTokens = ceil(chars/4).
const chars = (n) => "a".repeat(n);

// ── estimateTokens ───────────────────────────────────────────

test("estimateTokens: empty is 0", () => {
    assert.equal(estimateTokens(""), 0);
});

test("estimateTokens: ceil(chars / CHARS_PER_TOKEN)", () => {
    assert.equal(CHARS_PER_TOKEN, 4);
    assert.equal(estimateTokens(chars(4)), 1);
    assert.equal(estimateTokens(chars(5)), 2); // 5/4 → ceil = 2
    assert.equal(estimateTokens(chars(8)), 2);
});

test("estimateTokens: counts Unicode by code point, not UTF-16 length", () => {
    // "😀" is 2 UTF-16 units but 1 code point → 1 char → ceil(1/4) = 1 token.
    assert.equal(estimateTokens("😀"), 1);
    // Four emoji = 4 code points → ceil(4/4) = 1 token (not 8/4 = 2).
    assert.equal(estimateTokens("😀😀😀😀"), 1);
    // CJK: 8 code points → 2 tokens.
    assert.equal(estimateTokens("漢字漢字漢字漢字"), 2);
});

// ── truncateToTokenBudget ────────────────────────────────────

test("truncateToTokenBudget: within budget returns original", () => {
    assert.equal(truncateToTokenBudget(chars(8), 2), chars(8));
});

test("truncateToTokenBudget: over budget cuts to the char cap", () => {
    // budget 1 token → 1*4 = 4 chars kept.
    assert.equal(truncateToTokenBudget(chars(40), 1), chars(4));
});

test("truncateToTokenBudget: zero/neg budget → empty", () => {
    assert.equal(truncateToTokenBudget(chars(40), 0), "");
});

test("truncateToTokenBudget: Infinity budget returns the whole string (no limit)", () => {
    assert.equal(truncateToTokenBudget(chars(40), Infinity), chars(40));
});

test("truncateToTokenBudget: NaN budget returns empty (no valid budget)", () => {
    assert.equal(truncateToTokenBudget(chars(40), NaN), "");
});

test("truncateToTokenBudget: never splits a surrogate pair", () => {
    // 4 emoji (4 code points, 8 UTF-16 units). Budget 1 token = 4 chars → keep
    // all 4 emoji whole, never a half-emoji.
    const out = truncateToTokenBudget("😀😀😀😀", 1);
    assert.equal([...out].length, 4);
    assert.ok(!out.includes("�"), "no replacement char from a split pair");
});

// ── applyTokenBudget: exact / over / under ───────────────────

test("exact-budget: payload exactly at budget is not truncated", () => {
    // two hits of 8 chars = 2 tokens each = 4 tokens total.
    const hits = [hit(chars(8), 0.1), hit(chars(8), 0.2)];
    const { results, meta } = applyTokenBudget(hits, 4);
    assert.equal(results.length, 2);
    assert.equal(meta.truncated, false);
    assert.equal(meta.tokenEstimate, 4);
});

test("under-budget: unchanged, truncated:false", () => {
    const hits = [hit(chars(8), 0.1)];
    const { results, meta } = applyTokenBudget(hits, 100);
    assert.deepEqual(results, hits);
    assert.equal(meta.truncated, false);
    assert.equal(meta.tokenEstimate, 2);
});

test("over-budget high-relevance-only: keeps lowest-distance whole hits, drops the rest", () => {
    // three 2-token hits (8 chars each); budget 5 → keep 2 (4 tokens), drop 3rd.
    const hits = [hit(chars(8), 0.1), hit(chars(8), 0.2), hit(chars(8), 0.3)];
    const { results, meta } = applyTokenBudget(hits, 5, "high-relevance-only");
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.distance), [0.1, 0.2]);
    assert.equal(meta.truncated, true);
    assert.equal(meta.tokenEstimate, 4);
});

test("high-relevance-only: a single leading hit larger than the whole budget is dropped", () => {
    const hits = [hit(chars(40), 0.1)]; // 10 tokens, budget 3
    const { results, meta } = applyTokenBudget(hits, 3, "high-relevance-only");
    assert.equal(results.length, 0);
    assert.equal(meta.truncated, true);
    assert.equal(meta.tokenEstimate, 0);
});

test("drop-tail: truncates the boundary hit (partial tail), unlike high-relevance-only", () => {
    // hit sizes (tokens): [3, 4]; budget 5. high-relevance-only keeps [3] only.
    // drop-tail keeps hit0 whole (3) then truncates hit1 to the remaining 2
    // tokens (8 chars) → both hits present, payload fills to 5.
    const hits = [hit(chars(12), 0.1), hit(chars(16), 0.2)]; // 3 and 4 tokens
    const { results, meta } = applyTokenBudget(hits, 5, "drop-tail");
    assert.equal(results.length, 2, "boundary hit is kept as a partial, not dropped");
    assert.deepEqual(results.map((r) => r.distance), [0.1, 0.2]);
    assert.equal([...results[0].text].length, 12, "first hit intact");
    assert.equal([...results[1].text].length, 8, "second hit truncated to remaining budget");
    assert.equal(meta.tokenEstimate, 5, "payload fills to the budget");
    assert.equal(meta.truncated, true);

    // Contrast: same inputs under high-relevance-only keep only the first hit.
    const hro = applyTokenBudget(hits, 5, "high-relevance-only");
    assert.equal(hro.results.length, 1, "high-relevance-only drops the boundary hit whole");
    assert.notDeepEqual(
        results.map((r) => [...r.text].length),
        hro.results.map((r) => [...r.text].length),
        "drop-tail and high-relevance-only must differ on this input",
    );
});

test("drop-tail: single oversized leading hit is truncated to a partial (not dropped)", () => {
    const hits = [hit(chars(40), 0.1)]; // 10 tokens, budget 3
    const { results, meta } = applyTokenBudget(hits, 3, "drop-tail");
    assert.equal(results.length, 1, "oversized single hit is kept, truncated");
    assert.equal([...results[0].text].length, 12); // 3 tokens * 4 chars
    assert.equal(meta.tokenEstimate, 3);
    assert.equal(meta.truncated, true);
});

test("per-hit-cap: keeps every hit but shortens each to its share", () => {
    // two hits of 40 chars (10 tokens each); budget 4 → perHit = 2 tokens = 8 chars.
    const hits = [hit(chars(40), 0.1), hit(chars(40), 0.2)];
    const { results, meta } = applyTokenBudget(hits, 4, "per-hit-cap");
    assert.equal(results.length, 2, "all hits survive");
    for (const r of results) assert.equal([...r.text].length, 8);
    assert.equal(meta.truncated, true);
    assert.ok(meta.tokenEstimate <= 4, "final estimate within budget");
});

test("per-hit-cap: more hits than tokens drops overflow rather than emitting empty text", () => {
    // 3 hits, budget 2 → perHit = floor(2/3) = 0 → all dropped (no empty-text hits).
    const hits = [hit(chars(8), 0.1), hit(chars(8), 0.2), hit(chars(8), 0.3)];
    const { results, meta } = applyTokenBudget(hits, 2, "per-hit-cap");
    assert.equal(results.length, 0);
    assert.equal(meta.truncated, true);
});

test("mixed-size set: high-relevance-only fills greedily by order", () => {
    // sizes (tokens): 1, 3, 1, 5 ; budget 5 → keep 1+3+1 = 5, drop the 5-token hit.
    const hits = [
        hit(chars(4), 0.1), // 1
        hit(chars(12), 0.2), // 3
        hit(chars(4), 0.3), // 1
        hit(chars(20), 0.4), // 5
    ];
    const { results, meta } = applyTokenBudget(hits, 5, "high-relevance-only");
    assert.deepEqual(results.map((r) => r.distance), [0.1, 0.2, 0.3]);
    assert.equal(meta.tokenEstimate, 5);
    assert.equal(meta.truncated, true);
});

test("Unicode payload: budgeting counts code points, keeps whole hits", () => {
    // two hits of 8 emoji (8 code points → 2 tokens each); budget 2 → keep 1.
    const emoji8 = "😀".repeat(8);
    const hits = [hit(emoji8, 0.1), hit(emoji8, 0.2)];
    const { results, meta } = applyTokenBudget(hits, 2);
    assert.equal(results.length, 1);
    assert.equal([...results[0].text].length, 8, "kept hit is intact, no split pair");
    assert.equal(meta.tokenEstimate, 2);
});

test("zero budget → empty payload, truncated when there was content", () => {
    const hits = [hit(chars(8), 0.1)];
    const { results, meta } = applyTokenBudget(hits, 0);
    assert.equal(results.length, 0);
    assert.equal(meta.truncated, true);
    assert.equal(meta.tokenEstimate, 0);
});

test("empty result set is never truncated", () => {
    const { results, meta } = applyTokenBudget([], 100);
    assert.equal(results.length, 0);
    assert.equal(meta.truncated, false);
    assert.equal(meta.tokenEstimate, 0);
});

test("NaN budget is treated as no-budget: payload unchanged, truncated:false", () => {
    // Regression: a NaN budget must never keep everything AND claim truncation.
    const hits = [hit(chars(8), 0.1), hit(chars(8), 0.2)];
    const { results, meta } = applyTokenBudget(hits, NaN);
    assert.deepEqual(results, hits, "NaN keeps the full payload");
    assert.equal(meta.truncated, false, "NaN must not report truncation");
    assert.equal(meta.tokenEstimate, 4);
});

test("Infinity budget is treated as no-budget: payload unchanged, truncated:false", () => {
    const hits = [hit(chars(8), 0.1), hit(chars(8), 0.2)];
    const { results, meta } = applyTokenBudget(hits, Infinity);
    assert.deepEqual(results, hits);
    assert.equal(meta.truncated, false);
});

test("dense custom counter (tokens > chars) still fits the budget and terminates", () => {
    // A per-code-point CJK-style counter: 2 tokens per character. The estimate-
    // derived char cap (maxTokens*4) exceeds the true answer, so the shrink loop
    // must tighten it down without over/under-shooting.
    const dense = (t) => [...t].length * 2;
    // 10 CJK chars = 20 tokens; budget 6 → must cut to 3 chars (6 tokens).
    const hits = [hit("漢".repeat(10), 0.1)];
    const { results, meta } = applyTokenBudget(hits, 6, "per-hit-cap", dense);
    assert.equal(results.length, 1);
    assert.ok(dense(results[0].text) <= 6, "dense-counter payload stays within budget");
    assert.equal([...results[0].text].length, 3, "cut to exactly the fitting char count");
    assert.ok(meta.tokenEstimate <= 6);
});

test("custom counter truncation uses logarithmic counter calls", () => {
    const text = "漢".repeat(100_000);
    let calls = 0;
    const dense = (value) => {
        calls += 1;
        return [...value].length * 2;
    };

    const out = truncateToTokenBudget(text, 10_000, dense);
    assert.equal([...out].length, 5_000);
    assert.ok(calls <= 20, `expected logarithmic counter calls, got ${calls}`);
});

test("fractional budget behaves consistently across strategies", () => {
    // budget 2.5: high-relevance-only drops a 3-tok hit (0 results);
    // per-hit-cap gives floor(2.5/2)=1 tok/hit; drop-tail truncates the tail.
    const hits = [hit(chars(12), 0.1), hit(chars(12), 0.2)]; // 3 tokens each
    const hro = applyTokenBudget(hits, 2.5, "high-relevance-only");
    assert.equal(hro.results.length, 0, "3-tok hit does not fit a 2.5 budget");
    assert.equal(hro.meta.tokenEstimate, 0);

    const cap = applyTokenBudget(hits, 2.5, "per-hit-cap");
    assert.equal(cap.results.length, 2);
    for (const r of cap.results) assert.ok(estimateTokens(r.text) <= 1);
});

test("drop-tail and high-relevance-only converge when hits fill exactly", () => {
    // Two 2-token hits, budget 4 → both fit whole under either strategy.
    const hits = [hit(chars(8), 0.1), hit(chars(8), 0.2)];
    const dt = applyTokenBudget(hits, 4, "drop-tail");
    const hro = applyTokenBudget(hits, 4, "high-relevance-only");
    assert.deepEqual(dt.results, hro.results, "identical when nothing straddles the budget");
    assert.equal(dt.meta.truncated, false);
    assert.equal(hro.meta.truncated, false);
});

test("custom exact counter is honored (word-count tokenizer)", () => {
    // A toy exact counter: 1 token per whitespace-delimited word.
    const wordCount = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);
    const hits = [hit("one two three four five", 0.1)]; // 5 words
    const { results, meta } = applyTokenBudget(hits, 3, "per-hit-cap", wordCount);
    assert.ok(wordCount(results[0].text) <= 3, "custom counter drives the cap");
    assert.ok(meta.tokenEstimate <= 3);
});
