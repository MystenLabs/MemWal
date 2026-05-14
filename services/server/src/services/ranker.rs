//! Ranker service — **placeholder module**.
//!
//! Reserves the namespace for re-ranking and composite scoring of recall
//! results. On the current dev base, `recall` returns hits ordered by raw
//! pgvector cosine distance — there is no composite score, no reranker, no
//! signal beyond semantic similarity. The `ask` handler displays
//! `1.0 - distance` as a "relevance" number for human reading, but it does
//! not affect ordering. The benchmark harness's preset/`scoring_weights`
//! plumbing is therefore inert against this server (all presets converge —
//! see the benchmark archive READMEs).
//!
//! This module is intentionally empty in Phase 2. The trait, types, and
//! implementations land when a real caller exists. Likely first uses:
//!
//! - **Composite scoring** — combine semantic distance with importance,
//!   recency, and frequency weights as a configurable scoring policy
//!   (this is what wires up the benchmark presets).
//! - **Cross-encoder reranking** — pass top-K vector hits through a stronger
//!   pairwise model (e.g. Cohere Rerank, BGE reranker) for the final ordering.
//! - **Hybrid scoring** — blend BM25 keyword scores with vector similarity
//!   (paired with a future `Retriever` trait that exposes BM25).
//!
//! Adding any of these is the work of a follow-up task (the AI-improvement
//! track). This file exists so the structural home is named and discoverable.
