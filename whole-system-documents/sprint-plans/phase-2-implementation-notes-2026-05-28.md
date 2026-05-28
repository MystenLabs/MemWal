# RAG Quality Improvements Phase 2 - Implementation Notes

Date: 2026-05-28
Linear: WALM-54

## Scope Implemented

- WALM-55 timestamp injection: `AnalyzeRequest.occurred_at` is optional and defaults to absent. When present, `/api/analyze` prepends `<occurred_at>...</occurred_at>` to the extractor input and `extract.v6` instructs the LLM to resolve in-turn temporal references against it.
- WALM-56 two-pass extraction: opt-in `extract_with_critique` request flag. The first pass is the existing contextual extractor; the second pass uses `prompts/critique.txt` and returns a corrected final fact list in the same bucketed format.
- WALM-57 contextual embeddings: opt-in `contextual_embedding` request flag. The embedding input is a situated string built from `occurred_at` and the nearest related memories; stored/encrypted plaintext remains the extracted fact text.
- WALM-59 adaptive recall-k: opt-in `adaptive_k` plus optional `limit_hint` (`lookup`, `standard`, `composition`, `survey`) on `/api/recall` and `/api/ask`.
- Benchmark harness: per-turn ingest now forwards normalized RFC3339 `occurred_at`; config toggles can opt into critique, contextual embeddings, and adaptive-k.
- TypeScript and Python SDKs expose the new opt-in fields.

## Default-Behavior Contract

Default request bodies remain byte-equivalent in behavior:

- No `occurred_at` means the extractor input is still exactly `text`.
- `extract_with_critique=false` means no second LLM call.
- `contextual_embedding=false` means embeddings are still computed from the plain fact text.
- `adaptive_k=false` and no `limit_hint` means recall still uses the request `limit` capped at 100.

## Benchmark Validation

The code changes are intentionally behind opt-in flags. Paired LOCOMO and LongMemEval runs have now been completed and archived under `whole-system-documents/benchmark-archive/2026-05-28-phase-2/`.

Completed experiment matrix:

- WALM-55 only: `timestamp_v6`
- WALM-56 only: `critique`
- WALM-57 only: `contextual_embedding`
- WALM-59 only: `adaptive_k`

Result summary:

- Best LOCOMO: `timestamp_v6` baseline at 71.90 vs phase-1 baseline 67.4.
- Best LongMemEval: `critique` default at 77.80 vs phase-1 baseline 77.9.
- Parent-level result: meaningful LOCOMO lift, flat LongMemEval.

## Known Gaps

- The referenced prior archive `whole-system-documents/benchmark-archive/2026-05-21-mem59-extract-v5/` was not present in this checkout before implementation. Full before/after attribution needs that baseline restored or copied into this workspace.
- WALM-58 remains design-doc-first. No vendor or self-hosted reranker call was added to the read hot path without the latency/vendor decision.
- LOCOMO `contextual_embedding` has complete J-score artifacts but no session-map/ingestion stats artifact because a delayed interrupt landed after ingestion completed and before those files were written. Evaluation was recovered with `--skip-ingest`.
