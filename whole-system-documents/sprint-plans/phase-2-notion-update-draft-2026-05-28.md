# Notion Update Draft - MemWal Phase 2

Draft only. Notion has not been updated.

## RAG Quality Improvements Phase 2 - 2026-05-28

Phase 2 benchmark matrix is complete locally.

Archive:

`whole-system-documents/benchmark-archive/2026-05-28-phase-2/`

## Headline

Phase 2 found one clear improvement: timestamp injection.

| Benchmark | Before Phase 2 | Best Phase 2 | Delta |
| --- | ---: | ---: | ---: |
| LOCOMO | 67.4 | 71.90 | +4.50 |
| LongMemEval | 77.9 | 77.80 | -0.10 |

Interpretation:

- LOCOMO improved meaningfully.
- LongMemEval stayed flat overall.
- The cycle is useful because it identified what to ship and what not to ship.

## Experiment Results

| Experiment | LOCOMO baseline/default | LongMemEval baseline/default | Decision |
| --- | ---: | ---: | --- |
| `timestamp_v6` | 71.90 / 71.37 | 76.13 / 75.98 | keep |
| `critique` | 68.41 / 68.83 | 77.63 / 77.80 | opt-in/follow-up |
| `adaptive_k` | 71.66 / 71.00 | 76.08 / 75.73 | do not default |
| `contextual_embedding` | 68.65 / 68.82 | 76.56 / 76.39 | do not default |

## Recommendation

- Ship/keep WALM-55 timestamp injection.
- Do not default-enable WALM-56 critique yet.
- Do not ship WALM-57 contextual embeddings in this form.
- Keep WALM-58 cross-encoder as a separate design/latency/vendor follow-up.
- Do not default-enable WALM-59 adaptive-k.

## Caveat

LOCOMO contextual embedding has complete J-score artifacts, but lacks session-map/ingestion accounting because ingestion completed and then hit a delayed interrupt before writing those files. Evaluation was recovered with `--skip-ingest`, so the J-score comparison is still valid.

## Bottom Line

Phase 2 is not a full two-benchmark win: LOCOMO moved, LongMemEval did not. It is still a useful experiment cycle because it produced one shippable improvement and clear negative results for the other candidates.
