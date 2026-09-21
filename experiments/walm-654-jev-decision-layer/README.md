# WALM-654 Phase-1: Jev as a decision layer for Walrus Memory

External spike under `experiments/` — **does not modify MemWal core** (consolidator, auth, relayer, MCP, or SDK packages) and **does not add Jev as a required dependency** of any MemWal package.

Linear: [WALM-654](https://linear.app/mysten-labs/issue/WALM-654/evaluate-jev-as-a-decision-layer-for-walrus-memory)

## Purpose

Evaluate whether TypeSafe **Jev** (`jev-1.13.0`) improves post-recall decisions for Walrus Memory:

```
application query
  -> WM recall (simulated here: bounded top-K + distances)
  -> Jev decision (relevance Score, answerable Noul, route Choice)
  -> deterministic application policy
  -> answer_from_memory | llm | clarify | review
```

Phase-1 focuses on **answerability + routing + relevance reranking** after a bounded candidate set is already retrieved. Write-path duplicate/conflict/importance is out of scope for this spike directory (see ticket Phase-2).

## Non-goals

- Do **not** make Jev a required MemWal dependency.
- Do **not** replace embeddings, vector retrieval, or the fact extractor.
- Do **not** use Jev for generation, arithmetic, counting, or date comparison.
- Do **not** send an unbounded namespace or treat memory text as instructions.
- Do **not** let Jev delete/overwrite/supersede memories.
- Do **not** send production user data during this spike (synthetic only).

## Layout

```
experiments/walm-654-jev-decision-layer/
  data/synthetic-dataset.json   # ≥12 labeled EN+VI cases
  src/
    jev-client.js               # mock default / live API when key set
    jev-questions.js            # Score + Noul + Choice schema
    policy.js                   # deterministic WITHOUT / WITH / stub
    modes/                      # without_jev, with_jev, with_llm_stub
    metrics.js / benchmark.js / run.js
  test/                         # node:test
  results/mock-run.md           # sample mock benchmark output
```

## How to run

Requires Node ≥ 20. No `npm install` needed (stdlib only).

```bash
cd experiments/walm-654-jev-decision-layer

# unit tests
npm test
# or: node --test test/*.test.js

# mock benchmark (default when TYPESAFE_API_KEY unset)
npm run bench:mock
# or: npm run bench
```

### Real Jev API

```bash
export TYPESAFE_API_KEY=...          # do not commit
export JEV_MODEL=jev-1.13.0          # pinned; avoid jev-latest for experiments
npm run bench
```

Live runs write `results/live-run-<timestamp>.md`. Mock runs overwrite `results/mock-run.md`.

Published TypeSafe price used for `est_cost_usd`: **$0.042 / million input tokens** (output free). Endpoint: `POST https://api.typesafe.ai/v1/systemone`.

## Modes compared (same labeled dataset)

| Mode | Behavior |
| --- | --- |
| **without_jev** | Order by semantic distance only. Route = `answer_from_memory` if top-1 distance &lt; threshold else `llm`. |
| **with_jev** | Same candidates → Jev (or mock) for per-candidate relevance **Score**, answerable **Noul**, overall route **Choice** → deterministic policy reranks and routes. |
| **with_llm_stub** | Dumb keyword Jaccard overlap + injection penalty (third baseline column). |

## Metrics

Printed for **ALL / EN / VI**:

- `hit@1`, `hit@3`
- `false_context_rate` (answered from memory when not answerable, or top-1 irrelevant)
- `answerability_accuracy`, `route_accuracy`
- `p50_latency_ms`, `p95_latency_ms`
- `est_cost_usd`, `fallback_rate`

## How to interpret WITH vs WITHOUT

- If **with_jev** raises `hit@k` / `route_accuracy` / `answerability_accuracy` and lowers `false_context_rate` on hard categories (prompt-injection, contradiction, temporal update, empty retrieval) **without** unacceptable latency/cost or high `fallback_rate`, Phase-1 answerability/routing is a candidate for a follow-up implementation ticket.
- If gains appear only in the mock (label-informed stub) and not with the live API, treat results as non-transferable and keep Jev out of the required dependency graph.
- `without_jev` mirrors “current WM-style” distance thresholding; it is the go/no-go baseline.
- Low Jev confidence is forced away from `answer_from_memory` (policy → `clarify`). API errors set `fallback` and revert to WITHOUT behavior.

## Jev question schema (v1.0.0)

Pinned model: **`jev-1.13.0`**.

| Key | Type | Role |
| --- | --- | --- |
| `overall_answerable` | Noul | Is at least one candidate sufficient to answer? |
| `route` | Choice | `answer_from_memory` \| `llm` \| `clarify` \| `review` |
| `rel_<id>` | Score (4 levels) | Per-candidate usefulness (0=irrelevant/adversarial … 3=directly answers) |
| `ans_<id>` | Noul | Could this candidate alone answer? |

State sent to Jev: `{ query, candidates: [{ id, text, semantic_distance }] }` plus a privacy note. Candidate text is **untrusted data**, never instructions. See `src/jev-questions.js`.

## Dataset categories

Synthetic JSON (`data/synthetic-dataset.json`), EN + Vietnamese:

- exact duplicate, paraphrase, contradiction, temporal update
- empty/irrelevant retrieval, prompt-injection in memory
- correct fact outside top-K, ambiguous / clarify
- ≥12 cases total

## Privacy

- Synthetic / scrubbed data only for this spike.
- WM encryption does **not** keep payloads encrypted once supplied as Jev state.
- Before any production data: review TypeSafe DPA / retention / ZDR; decide whether decrypted memory may leave the WM boundary; redact identifiers.
- Fields sent: query text + candidate id/text/distance. No secrets, no real account ids in the dataset.
- Never commit `TYPESAFE_API_KEY`. Use `.env.example` as a template only.

## Confidence & policy (initial)

| Signal | Action |
| --- | --- |
| High confidence, low-risk route | Allow automatic routing |
| Medium / low confidence on `answer_from_memory` | Downgrade to `clarify` |
| Conflict / injection-like top hit | `review` |
| Jev unavailable (HTTP/429/529/error) | Fall back to `without_jev` |

Thresholds live in `src/policy.js` and must be calibrated per action risk before production.

## Sample mock output

See [`results/mock-run.md`](./results/mock-run.md) (regenerated by `npm run bench:mock`).
