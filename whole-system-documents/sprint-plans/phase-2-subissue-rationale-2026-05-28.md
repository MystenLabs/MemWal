# WALM-54 Phase 2 Sub-Issue Rationale

Date: 2026-05-28

## Summary

Phase 2 produced one clear ship candidate and several documented neutral/negative results.

Recommended parent status after review: close the experiment cycle once the PR is reviewed, with follow-up issues for any work that should continue.

## WALM-55 - Timestamp Injection

Recommendation: keep and merge.

Evidence:

- LOCOMO improved from the phase-1 baseline 67.4 to 71.90.
- LOCOMO temporal reached 66.67 in the best `timestamp_v6` run, directly addressing the weakest category called out in WALM-54.
- The implementation is opt-in through `occurred_at`; no timestamp means the extractor input remains unchanged.
- The mechanism fits the privacy floor: the date is written into encrypted fact text and embeddings, not a server-readable metadata index.

Rationale:

This is the only candidate that produced a meaningful benchmark lift on the parent task's harder benchmark. It also matches the diagnosed failure mode: benchmark timestamps were parsed but previously never reached `/api/analyze`.

## WALM-56 - Two-Pass Extraction With Self-Critique

Recommendation: do not enable by default; keep as opt-in or move to follow-up.

Evidence:

- LongMemEval best result came from critique default at 77.80, essentially flat against the phase-1 77.9 baseline.
- LOCOMO critique was lower than timestamp-only: 68.83 default vs 71.90 timestamp baseline.
- The extra critique pass adds write latency and another LLM call.

Rationale:

Critique has useful category-level signal, especially on LongMemEval assistant-side recall, but it does not produce an overall win large enough to justify making the slower path default. It is a follow-up candidate if future failure analysis shows extraction misses remain the dominant error.

## WALM-57 - Contextual Retrieval Embeddings

Recommendation: do not ship in this form; document as negative/neutral result.

Evidence:

- LOCOMO contextual: 68.65 baseline, 68.82 default.
- LongMemEval contextual: 76.56 baseline, 76.39 default.
- Both are below the best Phase 2 runs and do not beat phase-1 LongMemEval.

Rationale:

Anthropic-style contextual retrieval did not transfer cleanly to this pipeline where memories are already extracted atomic facts. The current variant also adds complexity and re-embedding concerns without a measured lift.

## WALM-58 - Cross-Encoder Reranking

Recommendation: keep as design-doc-first follow-up; do not implement in this PR.

Evidence:

- Design doc exists at `whole-system-documents/sprint-plans/cross-encoder-rerank-design-2026-05-28.md`.
- The read hot path needs a latency and vendor/self-hosting decision before code lands.
- A cross-encoder can only help when the right memory is already in the candidate set; Phase 2 did not yet quantify that ceiling enough to justify the dependency.

Rationale:

This candidate is plausible but materially different from the write-side changes. It should be scoped as its own follow-up with explicit latency budget, vendor/hosting choice, and an analysis of top-K miss vs mis-rank failures.

## WALM-59 - Adaptive Recall-K

Recommendation: do not ship as default; document as neutral/negative result.

Evidence:

- LOCOMO adaptive baseline/default: 71.66 / 71.00, below timestamp baseline 71.90.
- LongMemEval adaptive baseline/default: 76.08 / 75.73, below phase-1 77.9 and critique default 77.80.
- Runs reused timestamp namespaces, so this isolates read-side adaptive-k behavior.

Rationale:

Adaptive-k was cheap to test but did not improve the current retrieval stack. The simplest conclusion is that fixed k=10 is not the primary bottleneck for the measured failures.

## Parent-Level Assessment

WALM-54 is partially successful against its numeric goal:

- LOCOMO moved meaningfully upward.
- LongMemEval stayed flat overall.

It is successful as an experiment cycle:

- Candidate hypotheses were implemented behind opt-in flags.
- Paired LOCOMO and LongMemEval results were produced.
- Negative and neutral results are attributable.
- The next work is clearer: ship timestamp injection, avoid defaulting contextual/adaptive, and only revisit critique/reranking with narrower failure analysis.
