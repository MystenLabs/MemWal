# RAG Quality Improvements Phase 2 - Benchmark Summary

Date: 2026-05-28
Parent issue: WALM-54

## Status

The Phase 2 benchmark matrix is complete for J-score comparison. LOCOMO and LongMemEval were run for each implemented candidate with `baseline` and `default` presets.

Raw JSON artifacts are archived in `results/`. Checksums are in `manifest.sha256`.

## Before vs After

| Benchmark | Phase 1 baseline, 2026-05-21 | Best Phase 2 run | Delta | Interpretation |
| --- | ---: | ---: | ---: | --- |
| LOCOMO | 67.4 | 71.90 | +4.50 | Meaningful lift |
| LongMemEval | 77.9 | 77.80 | -0.10 | Flat |

The strongest outcome is LOCOMO. LongMemEval did not move meaningfully overall, although temporal-specific behavior improved versus the phase-1 laggard number noted in WALM-54.

## Overall Results

| Experiment | Dataset | Run ID | Baseline J-score | Default J-score | Decision |
| --- | --- | --- | ---: | ---: | --- |
| `timestamp_v6` | LOCOMO | `phase2-timestamp_v6-locomo-20260528-021530` | 71.90 | 71.37 | keep |
| `timestamp_v6` | LongMemEval | `phase2-timestamp_v6-longmemeval-20260528-043120` | 76.13 | 75.98 | keep for temporal mechanism, not overall lift |
| `critique` | LOCOMO | `phase2-critique-locomo-20260528-062521` | 68.41 | 68.83 | do not default |
| `critique` | LongMemEval | `phase2-critique-longmemeval-20260528-045521` | 77.63 | 77.80 | opt-in/follow-up |
| `adaptive_k` | LOCOMO | `phase2-adaptive-locomo-20260528-080110` | 71.66 | 71.00 | do not ship as default |
| `adaptive_k` | LongMemEval | `phase2-adaptive-longmemeval-20260528-075354` | 76.08 | 75.73 | do not ship as default |
| `contextual_embedding` | LOCOMO | `phase2-contextual-locomo-20260528-1636` | 68.65 | 68.82 | do not ship as default |
| `contextual_embedding` | LongMemEval | `phase2-contextual-longmemeval-20260528-1621` | 76.56 | 76.39 | do not ship as default |

## Category Signals

Best LOCOMO run: `timestamp_v6` baseline.

| Category | J-score |
| --- | ---: |
| single_hop | 66.05 |
| multi_hop | 55.36 |
| temporal | 66.67 |
| open_domain | 70.09 |
| adversarial | 86.32 |

Best LongMemEval run: `critique` default.

| Category | J-score |
| --- | ---: |
| single_session_user | 95.29 |
| single_session_assistant | 78.75 |
| preference | 71.83 |
| multi_session | 79.02 |
| temporal | 65.68 |
| knowledge_update | 82.31 |

## Conclusions

- WALM-55 timestamp injection is the clear Phase 2 win. It gives LOCOMO a meaningful overall lift and directly addresses the temporal failure mode.
- LongMemEval overall is flat. The task goal of moving both benchmarks meaningfully upward is only partially satisfied.
- WALM-56 critique has useful LongMemEval signal but does not beat the phase-1 overall score and regresses LOCOMO relative to timestamp-only.
- WALM-57 contextual embeddings did not transfer well to this extracted-fact pipeline in the current implementation.
- WALM-59 adaptive-k did not improve over the timestamp namespace it reused.
- WALM-58 remains design-doc-first; no read-path reranker should be merged before the latency/vendor decision.

## Caveats

- The LOCOMO contextual run has complete J-score artifacts but no session map. Ingestion reached all 5,882 per-turn chunks, then a delayed interrupt occurred before session-map and ingestion stats were written. Evaluation was recovered with `--skip-ingest`.
- `adaptive_k` results measure read-side behavior only because they reuse `timestamp_v6` namespaces.
- The previous 2026-05-21 raw baseline archive was not present in this checkout. The before numbers used here come from WALM-54.

## Verification

- `cd services/server/benchmarks && .venv/bin/python -m py_compile run.py`
- `cd services/server/benchmarks && .venv/bin/python -m pytest tests/test_adapters.py tests/test_metrics.py -q`
- JSON artifact integrity check over all archived baseline/default result files
