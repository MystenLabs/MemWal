/**
 * Client-side token estimation + budget truncation for recall payloads.
 *
 * The goal is a lightweight, zero-dependency way to weigh how many tokens a
 * recalled payload will cost before it is injected into a model context — so
 * apps can fit a budget without shipping a full tokenizer.
 *
 * ## Estimation model
 *
 * `estimateTokens` uses a documented character-based approximation rather than a
 * real BPE tokenizer. For English-ish text with common LLM encodings (e.g.
 * `cl100k_base`) tokens average ~4 characters, so we estimate
 * `ceil(chars / CHARS_PER_TOKEN)` with `CHARS_PER_TOKEN = 4`. This is an
 * ESTIMATE, not an exact count:
 *   - It is model/encoding-agnostic and deterministic (safe for CI assertions
 *     like "recall cost ≤ N").
 *   - It will diverge from an exact tokenizer for code, dense punctuation, or
 *     non-Latin scripts (where a single character can be one or more tokens).
 *   - It counts by Unicode code points (via the spread operator), so a
 *     multi-byte character (emoji, CJK) counts as one character, not its UTF-16
 *     length — keeping the estimate stable across scripts.
 *
 * Callers needing exact counts can pass their own `countTokens` function through
 * the recall options; this module is the default fallback.
 */

import type { RecallMemory, RecallTokenMeta, TruncationStrategy } from "./types.js";

/** Characters-per-token divisor for the default approximation (~cl100k_base). */
export const CHARS_PER_TOKEN = 4;

/** A function that returns the token count of a string. */
export type TokenCounter = (text: string) => number;

/**
 * Estimate the number of tokens in `text` using a documented character-based
 * approximation (~`chars / 4`). Deterministic and dependency-free. See the
 * module docs for accuracy caveats.
 *
 * Counts Unicode code points, so `"😀"` is 1 character (not 2 UTF-16 units).
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    // Spread iterates by code point, so surrogate pairs count as one char.
    const chars = [...text].length;
    return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Truncate a string to at most `maxTokens` estimated tokens, on a code-point
 * boundary (never splits a surrogate pair). Uses the inverse of the estimate:
 * keep at most `maxTokens * CHARS_PER_TOKEN` characters. Returns the original
 * string when it already fits.
 */
export function truncateToTokenBudget(
    text: string,
    maxTokens: number,
    countTokens: TokenCounter = estimateTokens,
): string {
    // Infinity = "no limit" → return the whole string. NaN / non-positive = no
    // valid budget → nothing. (Reachable only via the exported standalone helper;
    // applyTokenBudget intercepts non-finite budgets before calling here.)
    if (maxTokens === Infinity) return text;
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) return "";
    if (countTokens(text) <= maxTokens) return text;
    const chars = [...text];
    // Start the character cut at min(actual length, the estimate-derived cap).
    // For the default (~chars/4) estimator this cap fits in one shot. For a
    // custom counter DENSER than one token per char (e.g. a per-code-point CJK
    // tokenizer) the estimate-derived cap can exceed the true answer, so we then
    // shrink to fit below — clamping to `chars.length` first avoids starting the
    // shrink loop above the string's own length.
    let capChars = Math.min(chars.length, Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN)));
    let sliced = chars.slice(0, capChars).join("");
    // Shrink until the (possibly custom) counter agrees the slice fits. Bounded
    // by capChars; for the default estimator this loop does not run.
    while (capChars > 0 && countTokens(sliced) > maxTokens) {
        capChars -= 1;
        sliced = chars.slice(0, capChars).join("");
    }
    return sliced;
}

/** Sum of per-hit token estimates for a list of memories. */
function payloadTokens(results: RecallMemory[], countTokens: TokenCounter): number {
    return results.reduce((sum, m) => sum + countTokens(m.text), 0);
}

/**
 * Trim `results` (already ordered by ascending distance, i.e. most relevant
 * first) to fit `maxTokens` estimated tokens, per `strategy`. Pure — no I/O.
 *
 * Returns the (possibly trimmed) results plus `meta`, where `meta.tokenEstimate`
 * is the estimated token cost of the RETURNED payload (what the caller can
 * assert "≤ N" against) and `meta.truncated` is true if anything was dropped or
 * shortened.
 *
 * A non-finite budget (NaN / Infinity) is treated as "no budget": the payload is
 * returned unchanged with `truncated: false` — a malformed budget must never
 * claim it truncated.
 *
 * Strategies:
 *  - `high-relevance-only`: keep WHOLE hits from the front while they fit; the
 *    first hit that would overflow (and everything after it) is dropped. A
 *    single leading hit larger than the whole budget is itself dropped. No hit
 *    is ever partially shown. Deterministic.
 *  - `drop-tail`: preserve order, keep whole hits from the front, then TRUNCATE
 *    the single boundary hit that straddles the budget so the payload fills to
 *    (about) `maxTokens` — modelling "cut the end of the concatenated payload".
 *    Unlike high-relevance-only, the last kept hit may be a shortened partial.
 *  - `per-hit-cap`: keep every hit but cap each hit's text to an equal share of
 *    the budget (`floor(maxTokens / n)`); hits whose share rounds to zero (more
 *    hits than budget tokens) are dropped rather than emitted empty.
 */
export function applyTokenBudget(
    results: RecallMemory[],
    maxTokens: number,
    strategy: TruncationStrategy = "high-relevance-only",
    countTokens: TokenCounter = estimateTokens,
): { results: RecallMemory[]; meta: RecallTokenMeta } {
    const originalCount = results.length;

    // A non-finite budget (NaN/Infinity) is not a real budget — never truncate,
    // never falsely report truncation. Return the payload as-is.
    if (!Number.isFinite(maxTokens)) {
        return { results, meta: { tokenEstimate: payloadTokens(results, countTokens), truncated: false } };
    }

    // Non-positive budget → empty payload; truncated if there was anything.
    if (maxTokens <= 0) {
        return { results: [], meta: { tokenEstimate: 0, truncated: originalCount > 0 } };
    }

    // Already within budget → return unchanged, truncated:false.
    const fullCost = payloadTokens(results, countTokens);
    if (fullCost <= maxTokens) {
        return { results, meta: { tokenEstimate: fullCost, truncated: false } };
    }

    if (strategy === "per-hit-cap") {
        // Split the budget evenly across the hits; cap each. A zero per-hit share
        // (more hits than tokens) drops the overflow hits rather than emitting
        // empty-text memories.
        const perHit = Math.floor(maxTokens / originalCount);
        const capped: RecallMemory[] = [];
        for (const m of results) {
            if (perHit <= 0) break;
            const text = truncateToTokenBudget(m.text, perHit, countTokens);
            if ([...text].length > 0) capped.push({ ...m, text });
        }
        return {
            results: capped,
            meta: { tokenEstimate: payloadTokens(capped, countTokens), truncated: true },
        };
    }

    if (strategy === "drop-tail") {
        // Keep whole hits from the front; when the next hit straddles the budget,
        // truncate ITS text to the remaining budget (a partial tail) rather than
        // dropping it — "cut the end of the concatenated payload".
        const kept: RecallMemory[] = [];
        let running = 0;
        for (const m of results) {
            const cost = countTokens(m.text);
            if (running + cost <= maxTokens) {
                kept.push(m);
                running += cost;
                continue;
            }
            const remaining = maxTokens - running;
            if (remaining > 0) {
                const text = truncateToTokenBudget(m.text, remaining, countTokens);
                if ([...text].length > 0) {
                    kept.push({ ...m, text });
                    running += countTokens(text);
                }
            }
            break;
        }
        return { results: kept, meta: { tokenEstimate: running, truncated: true } };
    }

    // high-relevance-only: keep whole hits from the front while the running total
    // stays within budget; stop at the first hit that would overflow.
    const kept: RecallMemory[] = [];
    let running = 0;
    for (const m of results) {
        const cost = countTokens(m.text);
        if (running + cost > maxTokens) break;
        kept.push(m);
        running += cost;
    }
    return { results: kept, meta: { tokenEstimate: running, truncated: true } };
}
