# Cross-Encoder Reranking Design - WALM-58

Date: 2026-05-28

## Decision

Do not implement a production cross-encoder call in this pass. WALM-58 is explicitly design-doc-first because the read hot path needs a latency and vendor/hosting decision before code lands.

## Current Code Constraint

`services/server/src/services/ranker.rs::Ranker` is synchronous:

```text
fn rank(hits, weights, now) -> Vec<RankedHit>
```

A true cross-encoder needs an async model call over `(query, candidate)` pairs. Forcing that behind the current sync trait would either block inside the trait or fake the rerank. Neither is acceptable for a read-path experiment.

## Recommended Implementation Shape

Add a second-stage async reranker service rather than overloading the current sync `Ranker` trait:

- Keep `CompositeRanker` as the cheap deterministic scorer.
- Add an async `CrossEncoderReranker` service that accepts `query + hydrated candidates`.
- Run it after vector search and hydration, behind `RecallRequest.cross_encoder_rerank=true`.
- Return metadata only when active: provider, candidate count, rerank latency.

## Provider Options

- Cohere Rerank: fastest integration, likely 200-800ms extra p95 depending network and batch size; adds third-party read-path dependency.
- Self-hosted BGE reranker: avoids vendor dependency but requires GPU/serving operations not currently present in this repo.
- OpenAI-compatible chat scoring: not recommended as the first implementation because per-candidate chat scoring is costlier and noisier than a model built for reranking.

## Go/No-Go Gate

Before implementation:

- Diagnose what fraction of failing LOCOMO/LME cases have the right answer already in top-K but misordered.
- Set a hard read latency budget.
- Choose vendor vs self-host.
- Decide whether `Ranker` becomes async or a separate async reranker service layers after it.

No code should merge for WALM-58 until those answers exist.
