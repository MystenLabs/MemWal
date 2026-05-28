# Linear Update Draft - WALM-54

Draft only. Linear has not been updated.

## Parent Comment Draft

Phase 2 benchmark matrix is complete locally and archived under:

`whole-system-documents/benchmark-archive/2026-05-28-phase-2/`

Summary:

- LOCOMO moved from the phase-1 baseline 67.4 to best Phase 2 score 71.90 (`timestamp_v6` baseline), a meaningful +4.5 J lift.
- LongMemEval stayed flat overall: phase-1 baseline 77.9 vs best Phase 2 score 77.80 (`critique` default).
- Timestamp injection is the clear ship candidate. It directly targets the temporal failure mode and produced the strongest overall LOCOMO result.
- Critique has useful LongMemEval signal but does not justify default enablement yet because LOCOMO regresses versus timestamp-only and the extra LLM pass adds write latency.
- Contextual embeddings and adaptive-k did not beat the timestamp-only baseline and should not ship as defaults from this cycle.
- Cross-encoder reranking remains design-doc-first; no read-path reranker was implemented without a latency/vendor decision.

Artifacts:

- `whole-system-documents/benchmark-archive/2026-05-28-phase-2/summary.md`
- `whole-system-documents/benchmark-archive/2026-05-28-phase-2/results/`
- `whole-system-documents/sprint-plans/phase-2-subissue-rationale-2026-05-28.md`

Caveat:

The LOCOMO contextual embedding run has complete J-score artifacts, but no session map/ingestion stats artifact. Ingestion reached all 5,882 per-turn chunks, then a delayed interrupt landed before writing the session map. Eval recovered with `--skip-ingest`; J-score comparison remains usable.

Recommended closure:

- WALM-55: merge/keep.
- WALM-56: opt-in or follow-up, not default.
- WALM-57: move to follow-up/drop with negative-result rationale.
- WALM-58: follow-up after latency/vendor decision.
- WALM-59: move to follow-up/drop with neutral-result rationale.

## Sub-Issue Status Drafts

### WALM-55

Recommended status: keep in review / merge after PR review.

Timestamp injection produced the strongest LOCOMO result: 71.90 vs phase-1 baseline 67.4. The implementation is opt-in through `occurred_at` and preserves default behavior when absent.

### WALM-56

Recommended status: follow-up or keep opt-in, not default.

Critique produced the best LongMemEval Phase 2 score, 77.80, but that is flat against phase-1 77.9 and regresses LOCOMO compared with timestamp-only.

### WALM-57

Recommended status: follow-up/drop with negative-result rationale.

Contextual embeddings did not improve either benchmark enough to justify default enablement: LOCOMO 68.82 default, LongMemEval 76.39 default.

### WALM-58

Recommended status: follow-up.

Design doc exists. No implementation should land before deciding latency budget and vendor/self-hosting path.

### WALM-59

Recommended status: follow-up/drop with neutral-result rationale.

Adaptive-k reused timestamp namespaces and did not beat timestamp-only: LOCOMO 71.66/71.00, LongMemEval 76.08/75.73.
