import test from "node:test";
import assert from "node:assert/strict";
import { applyTokenBudget } from "../dist/tokens.js";

test("WALM-756 / GH #1103 repro: recall token budget under high-relevance-only keeps lowest-distance hits", () => {
    // What recall({ query, sort: "recent", maxTokens }) receives from the relayer: newest first.
    const recentOrder = [
        { blob_id: "newest", text: "User mentioned the weather is nice today.", distance: 0.62 },
        { blob_id: "older",  text: "User is allergic to peanuts.",               distance: 0.08 },
    ];
    // With maxTokens=12, each fact is ~10-11 tokens, so only 1 fact can fit.
    const result = applyTokenBudget(recentOrder, 12, "high-relevance-only");
    assert.deepEqual(
        result.results.map((r) => r.blob_id),
        ["older"],
        "Expected lowest-distance hit ('older', distance: 0.08) to be kept",
    );
    assert.equal(result.meta.truncated, true);
});

test("WALM-756 / GH #1103: retained hits preserve caller's requested order", () => {
    // 4 hits in recency order (newest to oldest):
    // hit1: distance 0.40, ~4 tokens
    // hit2: distance 0.10, ~4 tokens
    // hit3: distance 0.50, ~4 tokens
    // hit4: distance 0.15, ~4 tokens
    const recentOrder = [
        { blob_id: "h1", text: "fact 1 text.", distance: 0.40 },
        { blob_id: "h2", text: "fact 2 text.", distance: 0.10 },
        { blob_id: "h3", text: "fact 3 text.", distance: 0.50 },
        { blob_id: "h4", text: "fact 4 text.", distance: 0.15 },
    ];
    // Budget fits 2 hits (~8 tokens):
    // By distance: h2 (0.10), h4 (0.15), h1 (0.40), h3 (0.50)
    // Lowest distance that fit: h2 and h4.
    // In caller's recency order: [h2, h4].
    const result = applyTokenBudget(recentOrder, 8, "high-relevance-only");
    assert.deepEqual(
        result.results.map((r) => r.blob_id),
        ["h2", "h4"],
    );
    assert.equal(result.meta.truncated, true);
});

test("WALM-756 / GH #1103: equal distance breaks ties by original index", () => {
    const hits = [
        { blob_id: "tie-a", text: "text a.", distance: 0.1 },
        { blob_id: "tie-b", text: "text b.", distance: 0.1 },
    ];
    // Budget fits only 1: tie-a should win
    const result = applyTokenBudget(hits, 3, "high-relevance-only");
    assert.deepEqual(result.results.map((r) => r.blob_id), ["tie-a"]);
});
