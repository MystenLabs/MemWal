# Phase 2 Benchmark Config - Redacted

Date: 2026-05-28
Parent issue: WALM-54

The live benchmark `config.yaml` is not archived here because it contains credentials. This file captures the non-secret settings needed to understand the runs.

## Environment

- Server URL used by artifacts: `http://localhost:3001`
- Server mode: benchmark mode
- Network/relayer credentials: not archived
- Judge model: `openai/gpt-4o`
- Answer model: `openai/gpt-4o-mini`
- Evaluation mode: e2e LLM-as-judge
- Recall limit: 10 unless `adaptive_k=true`
- Presets evaluated per experiment: `baseline`, `default`

## Presets

| Preset | Semantic | Importance | Recency | Frequency |
| --- | ---: | ---: | ---: | ---: |
| `baseline` | 1.0 | 0.0 | 0.0 | 0.0 |
| `default` | 0.5 | 0.2 | 0.2 | 0.1 |

## Ingest Strategy

| Benchmark | Strategy |
| --- | --- |
| LOCOMO | `per_turn` |
| LongMemEval | `session` |

## Experiment Toggles

| Experiment | `occurred_at` | `extract_with_critique` | `contextual_embedding` | `adaptive_k` |
| --- | --- | --- | --- | --- |
| `timestamp_v6` | yes | false | false | false |
| `critique` | yes | true | false | false |
| `contextual_embedding` | yes | false | true | false |
| `adaptive_k` | yes | false | false | true |

## Notes

- `adaptive_k` evaluations reused the `timestamp_v6` namespaces via `namespace_run_id`; they did not perform fresh ingestion.
- `contextual_embedding` LOCOMO ingestion completed all 5,882 chunks, but the process received a delayed interrupt before writing session-map and ingestion stats. The eval artifacts are complete and were recovered with `--skip-ingest`.
