//! Composite-scoring ranker for recall results.
//!
//! Today (without this module), `/api/recall` and `/api/ask` order results
//! by raw pgvector cosine distance — there is no second signal, so the
//! benchmark harness's preset / `scoring_weights` plumbing is inert (all
//! presets converge — see the 2026-05-13 benchmark archive READMEs).
//!
//! [`CompositeRanker`] blends three signals:
//!
//! - **Semantic similarity** — `1 - cosine_distance`, monotonic in the
//!   pgvector ordering we already have.
//! - **Recency** — `2^(-age_days / half_life_days)` (equivalently
//!   `exp(-age_days * ln(2) / half_life_days)`). A true half-life decay
//!   that puts a memory aged exactly `half_life` days at 0.5, twice that
//!   at 0.25, and so on.
//! - **Importance** — the per-fact bucket score persisted on
//!   `vector_entries.importance` (vital / standard / trivial → 0.9 /
//!   0.5 / 0.2). The column is `NOT NULL DEFAULT 0.5` so legacy rows fall
//!   into the neutral bucket and don't reorder anything when this signal
//!   is enabled.
//!
//! The final score is the weighted sum (see [`crate::types::ScoringWeights`]).
//! The ranker sorts by this score **descending** (higher = better) and
//! returns the reordered list.
//!
//! # Why semantic + recency + importance, and not more signals (yet)
//!
//! - **Access frequency**: would require a write on every recall, hot-row
//!   contention concerns. Deferred.
//! - **BM25 keyword / entity matching**: text is on Walrus behind SEAL.
//!   Server-side text inspection requires either a "shadow store" of
//!   keywords/entities (weakens privacy story) or a 5× cost decrypt-50-
//!   then-rerank approach. Separate architectural decision; not Phase A.1.
//!
//! # Default behaviour preserved
//!
//! [`ScoringWeights::default()`] is `semantic=1.0, recency=0.0` — and the
//! impl short-circuits when `recency` is effectively zero, returning the
//! input order unchanged. So when `/api/recall` is called without
//! `scoring_weights`, ordering is byte-identical to the pre-ranker code.
//!
//! # Why a trait + struct (not just a free function)
//!
//! Matches the [`crate::services::Embedder`] / [`crate::services::Extractor`]
//! pattern. Lets us swap in a [cross-encoder reranker][cohere] (Cohere /
//! BGE) or hybrid retriever later behind the same handler call site, with
//! no churn in `routes/recall.rs`.
//!
//! [cohere]: https://docs.cohere.com/docs/rerank-overview

use crate::engine::HydratedMemory;
use crate::types::{ScoringWeights, SearchHit};
use chrono::{DateTime, Utc};

/// One memory after ranking, paired with the composite score the ranker
/// computed (if any). `score = None` means the ranker short-circuited and
/// didn't compute a score — the handler will leave `RecallResult.score`
/// unset and the field is omitted from the wire response. `score = Some(_)`
/// means the ranker actually ran and the handler should surface the value.
#[derive(Debug, Clone)]
pub struct RankedHit {
    pub memory: HydratedMemory,
    pub score: Option<f64>,
}

/// Re-ranker for hydrated recall results.
///
/// Implementations must be deterministic given `(hits, weights, now)` —
/// no internal clock reads, no RNG. Tests construct synthetic `HydratedMemory`
/// values and verify exact orderings.
pub trait Ranker: Send + Sync {
    /// Reorder `hits` by composite score and return them paired with the
    /// scores. The default `ScoringWeights` (`recency=0`) is the identity
    /// function — input order is preserved and every `RankedHit.score` is
    /// `None` so the handler omits the wire-level `score` field.
    ///
    /// `now` is injected (not `Utc::now()`) so tests are deterministic.
    /// In production, the recall handler passes `Utc::now()` at the point
    /// of the call.
    fn rank(
        &self,
        hits: Vec<HydratedMemory>,
        weights: &ScoringWeights,
        now: DateTime<Utc>,
    ) -> Vec<RankedHit>;
}

/// Two-signal composite ranker — semantic similarity + recency decay.
///
/// Stateless. One instance is constructed at startup and shared via
/// `Arc<dyn Ranker>` on `AppState`.
#[derive(Debug, Default, Clone)]
pub struct CompositeRanker;

impl CompositeRanker {
    /// Compute the composite score for one hit. Exposed for unit tests.
    ///
    /// `created_at = None` (memory has no timestamp) is treated as recency
    /// score 0 — old enough that the decay term has fully attenuated. This
    /// makes the engines' `created_at: None` default safe: if the recall
    /// handler forgets to zip the timestamp on, recency just doesn't help
    /// that hit (it doesn't reorder wrongly).
    pub fn score(hit: &HydratedMemory, weights: &ScoringWeights, now: DateTime<Utc>) -> f64 {
        let semantic_term = weights.semantic * (1.0 - hit.distance);

        let recency_term = if !weights.is_ranker_active() {
            0.0
        } else if let Some(created_at) = hit.created_at {
            let age_secs = (now - created_at).num_seconds().max(0) as f64;
            let age_days = age_secs / 86_400.0;
            // Guard against a non-positive half-life sneaking in via
            // request body — a zero or negative half-life would either
            // divide-by-zero or invert the decay. Treat as "recency has
            // no effect" rather than panicking.
            if weights.recency_half_life_days <= 0.0 {
                0.0
            } else {
                // True half-life decay: factor of 0.5 per `half_life_days`.
                // `exp(-age * ln(2) / half_life)` ≡ `2^(-age / half_life)`.
                // (A naive `exp(-age/half_life)` would give 1/e ≈ 0.368
                // at the half-life mark, which is the time *constant*,
                // not the half-life.)
                let decay =
                    (-age_days * std::f64::consts::LN_2 / weights.recency_half_life_days).exp();
                weights.recency * decay
            }
        } else {
            0.0
        };

        // importance term. `vector_entries.importance` is already
        // in [0.0, 1.0] (bucket values are 0.2 / 0.5 / 0.9), so we don't
        // need a normalisation step — just multiply by the weight.
        //
        // `importance = None` means the recall handler didn't zip the
        // value on (or the engine returned a raw HydratedMemory we never
        // saw a SearchHit for). Symmetric with the `created_at = None`
        // recency branch: treat as neutral (0.0) rather than panicking,
        // so a missing zip doesn't reorder hits incorrectly.
        let importance_term = match hit.importance {
            Some(imp) if weights.importance.abs() >= f64::EPSILON => {
                weights.importance * (imp as f64)
            }
            _ => 0.0,
        };

        semantic_term + recency_term + importance_term
    }
}

impl Ranker for CompositeRanker {
    fn rank(
        &self,
        hits: Vec<HydratedMemory>,
        weights: &ScoringWeights,
        now: DateTime<Utc>,
    ) -> Vec<RankedHit> {
        // Fast path: when recency weight is effectively zero, the score is a
        // monotonic transform of `(1 - distance)` — i.e. the existing
        // pgvector order is already correct. Skip the sort *and* leave each
        // `score = None` so the handler omits the wire-level field, keeping
        // behaviour byte-identical to the pre-ranker code under default
        // weights.
        if !weights.is_ranker_active() {
            return hits
                .into_iter()
                .map(|memory| RankedHit {
                    memory,
                    score: None,
                })
                .collect();
        }

        let mut scored: Vec<RankedHit> = hits
            .into_iter()
            .map(|memory| {
                let s = Self::score(&memory, weights, now);
                RankedHit {
                    memory,
                    score: Some(s),
                }
            })
            .collect();

        // Sort descending by score. NaN scores would only occur if a
        // weight is NaN — `partial_cmp` returns None there; we treat NaN
        // as the smallest value so a malformed request doesn't crash the
        // server.
        scored.sort_by(|a, b| {
            let lhs = a.score.unwrap_or(f64::NEG_INFINITY);
            let rhs = b.score.unwrap_or(f64::NEG_INFINITY);
            rhs.partial_cmp(&lhs).unwrap_or(std::cmp::Ordering::Equal)
        });

        scored
    }
}

// ============================================================
// Diversity reranking — Maximal Marginal Relevance (MMR)
// ============================================================
//
// The [`CompositeRanker`] above is *pointwise*: each hit's score depends
// only on its own `(distance, recency, importance)`. That's the wrong
// shape for multi-hop recall, where the answer needs *several distinct*
// facts and a pointwise ranker happily fills the top-K with K near-copies
// of the single best-matching fact — burying the complementary fact a
// multi-hop question needs below the `limit` cut.
//
// MMR (Carbonell & Goldstein, SIGIR 1998 — "The Use of MMR, Diversity-
// Based Reranking for Reordering Documents and Producing Summaries",
// DOI 10.1145/290941.291025) fixes this by selecting a *set* greedily:
// at each step pick the candidate maximising
//
//     λ · Sim(dᵢ, q)  −  (1−λ) · max_{dⱼ ∈ S} Sim(dᵢ, dⱼ)
//     └── relevance ──┘     └──── redundancy-to-already-picked ────┘
//
// where `S` is the set chosen so far. The first term rewards relevance to
// the query; the second penalises a candidate for looking like something
// already selected. `λ ∈ [0,1]` trades the two: λ=1 reproduces the pure-
// relevance order (today's behaviour), λ=0 is pure diversity.
//
// This is a SECOND stage, not a fourth weight on [`CompositeRanker`] — it
// is set-dependent, so it cannot be a pointwise term. It runs on
// [`crate::types::SearchHit`] (pre-fetch, pre-truncation) because:
//   1. it must run BEFORE the `limit` truncation to rescue a diverse fact
//      sitting just below the cut, and
//   2. the redundancy term needs the raw embedding vectors, which we have
//      cheaply on `SearchHit` before paying any Walrus/SEAL fetch cost.
//
// Design note: `whole-system-documents/sprint-plans/
// direction-diversity-rerank-2026-06-02.md` (full theory, citations, the
// submodular/monotone analysis, λ-sweep plan, and acceptance gates).

/// Server-wide configuration for the MMR diversity reranker.
///
/// MMR is a pipeline-shape decision (it changes *which* candidates survive
/// to the reader), not a per-request preference like `scoring_weights`, so
/// it's configured server-side via env vars and is **off by default** —
/// when `enabled == false` the recall path skips the stage entirely and
/// ordering is byte-identical to today. See [`MmrConfig::from_env`].
#[derive(Debug, Clone, Copy)]
pub struct MmrConfig {
    /// Master switch. `false` ⇒ the reranker is never invoked and recall
    /// ordering is unchanged. Set via `MMR_ENABLED=true`.
    pub enabled: bool,
    /// Relevance↔diversity trade-off `λ ∈ [0,1]`. `1.0` = pure relevance
    /// (identity), `0.0` = pure diversity. The benchmark λ-sweep tries
    /// {0.3, 0.5, 0.7}. Set via `MMR_LAMBDA`. Values outside `[0,1]` are
    /// clamped (a λ>1 or λ<0 has no sensible meaning here).
    pub lambda: f64,
    /// Candidate-pool size `N`: how many top hits the reranker considers
    /// before selecting. The reorder only touches the first `N`; hits
    /// beyond `N` keep their relative order and stay after the reranked
    /// prefix. Must be ≥ the recall `limit` for MMR to have anything to
    /// rescue *into* the visible window. Set via `MMR_POOL_N`. Default 30.
    pub pool_n: usize,
}

impl Default for MmrConfig {
    fn default() -> Self {
        // Off by default: opt in per deployment / per bench run.
        Self {
            enabled: false,
            lambda: 0.5,
            pool_n: 30,
        }
    }
}

impl MmrConfig {
    /// Build from environment variables, falling back to [`Default`] for
    /// any unset/malformed var. Parsing is lenient (a bad value `warn!`s
    /// and uses the default) because a typo'd env var should degrade to
    /// "MMR off / sane λ", never crash startup — but it must be LOUD about
    /// the degrade, because a silently-misparsed bench-run env is the
    /// fastest way to misread a null result as "MMR doesn't help".
    ///
    /// - `MMR_ENABLED` — `true`/`1`/`yes`/`on` ⇒ on; `false`/`0`/`no`/`off`
    ///   ⇒ off; anything else ⇒ off **with a warning** (the typo footgun).
    /// - `MMR_LAMBDA` — float; non-finite / unparseable ⇒ default + warn;
    ///   out of `[0,1]` ⇒ clamped + warn.
    /// - `MMR_POOL_N` — positive integer; invalid ⇒ default + warn.
    ///
    /// Always logs the resolved final state (enabled OR disabled) so a
    /// bench operator can confirm from the startup log exactly what ran.
    pub fn from_env() -> Self {
        let cfg = Self::resolve(
            std::env::var("MMR_ENABLED").ok(),
            std::env::var("MMR_LAMBDA").ok(),
            std::env::var("MMR_POOL_N").ok(),
        );

        // Always log the resolved state — enabled AND disabled — so a
        // bench operator can grep the startup log to confirm what ran,
        // rather than inferring MMR-off from the absence of a log line.
        if cfg.enabled {
            tracing::info!(
                lambda = cfg.lambda,
                pool_n = cfg.pool_n,
                "MMR diversity reranker ENABLED on recall path (composite→MMR layering)"
            );
        } else {
            tracing::info!("MMR diversity reranker DISABLED (recall ordering unchanged)");
        }
        cfg
    }

    /// Pure resolution of the three env values to a config, with loud
    /// `warn!`s on every degrade path. Separated from [`Self::from_env`] so
    /// it's testable without mutating process-global env (which races under
    /// the parallel test runner). `None` = the var was unset.
    pub(crate) fn resolve(
        enabled_raw: Option<String>,
        lambda_raw: Option<String>,
        pool_n_raw: Option<String>,
    ) -> Self {
        let default = Self::default();

        let enabled = match enabled_raw {
            None => default.enabled, // unset → default (off)
            Some(raw) => match raw.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => true,
                "false" | "0" | "no" | "off" | "" => false,
                other => {
                    tracing::warn!(
                        value = %other,
                        "MMR_ENABLED set to an unrecognized token — treating as OFF. \
                         Use true/1/yes/on or false/0/no/off."
                    );
                    false
                }
            },
        };

        let lambda = match lambda_raw {
            None => default.lambda,
            Some(raw) => match raw.trim().parse::<f64>() {
                Ok(x) if x.is_finite() => {
                    let clamped = x.clamp(0.0, 1.0);
                    if (clamped - x).abs() > f64::EPSILON {
                        tracing::warn!(
                            requested = x,
                            used = clamped,
                            "MMR_LAMBDA out of [0,1] — clamped."
                        );
                    }
                    clamped
                }
                _ => {
                    tracing::warn!(
                        value = %raw,
                        default = default.lambda,
                        "MMR_LAMBDA not a finite float — using default."
                    );
                    default.lambda
                }
            },
        };

        let pool_n = match pool_n_raw {
            None => default.pool_n,
            Some(raw) => match raw.trim().parse::<usize>() {
                Ok(n) if n > 0 => n,
                _ => {
                    tracing::warn!(
                        value = %raw,
                        default = default.pool_n,
                        "MMR_POOL_N not a positive integer — using default."
                    );
                    default.pool_n
                }
            },
        };

        Self {
            enabled,
            lambda,
            pool_n,
        }
    }
}

/// Cosine similarity between two equal-length embedding vectors.
///
/// Returns `dot(a,b) / (‖a‖·‖b‖)`. We compute the *true* cosine (dividing
/// by the magnitudes) rather than assuming pre-normalised unit vectors and
/// taking a bare dot product. `text-embedding-3-small` already returns
/// L2-normalised vectors, so in production the denominator is ≈1 and this
/// is a hair slower than a bare dot — but the division is defensive
/// insurance against (a) a future embedding-model swap that *isn't*
/// pre-normalised, and (b) float drift making `‖v‖` drift off 1.0. At
/// N≤pool_n candidates the cost is negligible.
///
/// Edge cases that would otherwise produce `NaN`:
///   - mismatched lengths ⇒ `0.0` (treat as "no measurable similarity";
///     can only happen on a corrupt/legacy row and must not poison the
///     `max` in the redundancy term).
///   - a zero-magnitude vector ⇒ `0.0` (division guard).
fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;
    for (x, y) in a.iter().zip(b.iter()) {
        let (x, y) = (*x as f64, *y as f64);
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom <= 0.0 {
        return 0.0;
    }
    dot / denom
}

/// Reorder `hits` by Maximal Marginal Relevance over the first
/// `config.pool_n` candidates, returning the same hits in MMR order.
///
/// **Contract & invariants**
/// - **Lossless permutation.** The returned `Vec` is exactly the input
///   multiset, reordered — no hit is added, dropped, or duplicated, so
///   `out.len() == hits.len()` always. (The recall handler relies on this
///   to keep `results.len()` stable.)
/// - **Identity when off / trivial.** If `!config.enabled`, or fewer than
///   2 hits, or `λ == 1.0` (pure relevance — MMR's argmax reduces to the
///   already-sorted relevance order), the input is returned **unchanged**.
/// - **Prefix-only reorder.** Only the first `min(pool_n, len)` hits are
///   reranked; any tail beyond `pool_n` is appended in its original order.
///   The input is assumed already sorted best-relevance-first (it comes
///   straight from the pgvector `ORDER BY embedding <=> q`).
/// - **Deterministic.** No clock/RNG; ties broken by original index (the
///   earlier-arriving, i.e. more-relevant, hit wins).
///
/// **Relevance term.** `Sim(dᵢ, q) = 1 − distance` — pgvector already
/// computed the query↔doc cosine distance, so we reuse it instead of
/// re-dotting against the query vector.
///
/// **Redundancy term.** `max_{dⱼ∈S} cosine(embⱼ, embᵢ)` via
/// [`cosine_similarity`] on the stored embeddings, maintained as an
/// incremental running max per remaining candidate so the whole selection
/// is `O(pool_n · K)` doc-doc comparisons rather than `O(pool_n · K²)`.
///
/// **Relevance term — caller-supplied, min-max normalised.** `rel_scores`
/// is the per-hit relevance signal, parallel to `hits` (`rel_scores[i]` is
/// the relevance of `hits[i]`). This is the **composite ranker's score**,
/// not raw `1 − distance` — MMR is the *last* stage and must diversify on
/// the best relevance signal we have (semantic + recency + importance),
/// not on cosine alone. Because composite scores can land on any scale
/// (the weights aren't capped at 1), we **min-max normalise them across
/// the pool to `[0,1]`** before mixing with the cosine redundancy term
/// (itself in `[-1,1]`, effectively `[0,1]` for these embeddings), so a
/// single `λ` trades two comparable quantities. A degenerate pool where
/// every score is equal normalises to all-zeros (no relevance signal) and
/// MMR then orders purely by diversity — acceptable, and the caller's
/// input order (already relevance-sorted) breaks the resulting ties.
///
/// `rel_scores` is assumed ordered so that the input `hits` are already
/// best-relevance-first (they come from the composite ranker's descending
/// sort). A length mismatch is treated defensively (missing scores → the
/// minimum), never a panic.
pub fn mmr_rerank(hits: Vec<SearchHit>, rel_scores: &[f64], config: &MmrConfig) -> Vec<SearchHit> {
    let lambda = config.lambda;

    // Fast paths that are provably the identity permutation — skip all
    // work and hand back the input untouched.
    //   - disabled: the master switch is off.
    //   - <2 hits: nothing to diversify against.
    //   - λ ≥ 1: redundancy term is zeroed; argmax of `λ·relevance` over a
    //     relevance-sorted list is that same list.
    if !config.enabled || hits.len() < 2 || lambda >= 1.0 {
        return hits;
    }

    let pool_n = config.pool_n.min(hits.len());

    // Split: `pool` is reranked, `tail` keeps its original order and is
    // re-appended after. Reranking only the head matches MMR's intent
    // (re-order the top of an IR list — Carbonell & Goldstein note the
    // candidate set R is ≪ the full collection) and bounds the cost.
    let mut pool: Vec<SearchHit> = hits;
    let tail: Vec<SearchHit> = pool.split_off(pool_n);

    let n = pool.len();

    // Min-max normalise the caller's relevance scores over the pool to
    // `[0,1]`. `rel_scores[i]` is non-finite or missing ⇒ treated as the
    // pool minimum (least relevant) rather than poisoning the range.
    let raw: Vec<f64> = (0..n)
        .map(|i| {
            rel_scores
                .get(i)
                .copied()
                .filter(|x| x.is_finite())
                .unwrap_or(f64::NEG_INFINITY)
        })
        .collect();
    let finite_min = raw
        .iter()
        .copied()
        .filter(|x| x.is_finite())
        .fold(f64::INFINITY, f64::min);
    let finite_max = raw
        .iter()
        .copied()
        .filter(|x| x.is_finite())
        .fold(f64::NEG_INFINITY, f64::max);
    let span = finite_max - finite_min;
    // Any non-finite raw score (missing / NaN distance upstream) maps to the
    // pool minimum → normalised relevance 0.0 (never selected for relevance,
    // but still a valid, finite participant — preserves losslessness).
    let relevance: Vec<f64> = raw
        .iter()
        .map(|&x| {
            if !x.is_finite() || span <= 0.0 {
                0.0
            } else {
                (x - finite_min) / span
            }
        })
        .collect();
    let mut selected: Vec<bool> = vec![false; n];
    // `max_sim_to_selected[i]` = redundancy term for candidate i =
    // max cosine to anything already selected. Starts at 0 (nothing
    // selected yet ⇒ no redundancy) and only ever grows as `S` fills.
    let mut max_sim_to_selected: Vec<f64> = vec![0.0; n];
    let mut order: Vec<usize> = Vec::with_capacity(n);

    for _ in 0..n {
        // Pick the unselected candidate with the highest MMR score.
        let mut best_idx: Option<usize> = None;
        let mut best_score = f64::NEG_INFINITY;
        for i in 0..n {
            if selected[i] {
                continue;
            }
            let score = lambda * relevance[i] - (1.0 - lambda) * max_sim_to_selected[i];
            // Strict `>` means ties are broken by the lower index, i.e. the
            // more-relevant (earlier-sorted) hit — a deterministic,
            // sensible tie-break.
            if score > best_score {
                best_score = score;
                best_idx = Some(i);
            }
        }

        let chosen = match best_idx {
            Some(i) => i,
            // Can't happen (loop runs exactly `n` times over `n`
            // candidates, one selected per round) but don't panic.
            None => break,
        };
        selected[chosen] = true;
        order.push(chosen);

        // Update every still-unselected candidate's running max-similarity
        // against the newly-chosen one. This is the incremental step that
        // keeps the whole thing O(n·K) instead of recomputing the max over
        // the whole selected set each round.
        let chosen_emb = &pool[chosen].embedding;
        for i in 0..n {
            if selected[i] {
                continue;
            }
            let sim = cosine_similarity(chosen_emb, &pool[i].embedding);
            if sim > max_sim_to_selected[i] {
                max_sim_to_selected[i] = sim;
            }
        }
    }

    // Materialise the reranked pool by `order`, then re-append the tail.
    // `Option::take` moves each hit out exactly once (no clone of the
    // 1536-float embeddings).
    let mut slots: Vec<Option<SearchHit>> = pool.into_iter().map(Some).collect();
    let mut out: Vec<SearchHit> = Vec::with_capacity(n + tail.len());
    for idx in order {
        if let Some(hit) = slots[idx].take() {
            out.push(hit);
        }
    }
    out.extend(tail);
    out
}

/// One hit paired with the composite score the ranker gave it. Internal to
/// the two-stage pipeline below.
struct ScoredHit {
    hit: SearchHit,
    score: f64,
}

/// Full recall ordering pipeline on `SearchHit`s: **composite scoring
/// first, MMR diversity composition last.**
///
/// This is the correct layering (see the design note): the pointwise
/// [`CompositeRanker`] decides *how good each fact is on its own*
/// (semantic + recency + importance), then MMR composes the *set* —
/// consuming the composite score as its relevance term so diversity is
/// applied on top of the best per-item signal we have, and producing the
/// FINAL order (nothing pointwise runs after it to scramble it).
///
/// Stages:
/// 1. Score every hit with [`CompositeRanker::score`] (works on the
///    `SearchHit` fields directly — no decrypted text needed).
/// 2. Sort descending by score → the composite ordering. At default
///    weights this is a no-op (score is monotone in `1 − distance`, the
///    input is already pgvector-sorted), so the byte-identical-to-today
///    contract holds when MMR is also off.
/// 3. [`mmr_rerank`] with the composite scores as relevance. Off / λ≥1 /
///    <2 hits ⇒ identity, so step 3 is a no-op when MMR is disabled and
///    the result is exactly the composite ordering from step 2.
///
/// Returns the hits in final order (a lossless permutation of the input).
/// `now` is injected for deterministic recency scoring.
pub fn rank_and_diversify(
    hits: Vec<SearchHit>,
    weights: &ScoringWeights,
    mmr: &MmrConfig,
    now: DateTime<Utc>,
) -> Vec<SearchHit> {
    if hits.is_empty() {
        return hits;
    }

    // Stage 1: composite score per hit. We map each SearchHit into the
    // minimal HydratedMemory shape CompositeRanker::score reads (distance
    // / created_at / importance) — the same trick `rank_search_hits` uses,
    // so scoring stays in lockstep with the hydrating recall path.
    let mut scored: Vec<ScoredHit> = hits
        .into_iter()
        .map(|h| {
            let proxy = HydratedMemory {
                blob_id: String::new(),
                text: String::new(),
                distance: h.distance,
                created_at: Some(h.created_at),
                importance: Some(h.importance),
            };
            let score = CompositeRanker::score(&proxy, weights, now);
            ScoredHit { hit: h, score }
        })
        .collect();

    // Stage 2: sort descending by composite score. NaN sorts as smallest
    // (a malformed weight shouldn't crash recall). Stable so equal-score
    // hits keep their pgvector order — preserving the today-ordering at
    // default weights exactly.
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Stage 3: MMR composes the final set/order using the composite scores
    // as the relevance term. Identity when MMR is off.
    let rel_scores: Vec<f64> = scored.iter().map(|s| s.score).collect();
    let ordered_hits: Vec<SearchHit> = scored.into_iter().map(|s| s.hit).collect();
    mmr_rerank(ordered_hits, &rel_scores, mmr)
}

#[cfg(test)]
mod mmr_tests {
    use super::*;
    use crate::services::extractor::{IMPORTANCE_STANDARD, IMPORTANCE_VITAL};
    use chrono::TimeZone;

    fn t_now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 5, 14, 12, 0, 0).unwrap()
    }

    /// Build a `SearchHit` with an explicit embedding. `distance` drives the
    /// relevance term (`1 − distance`); `emb` drives the redundancy term.
    fn sh(blob_id: &str, distance: f64, emb: Vec<f32>) -> SearchHit {
        SearchHit {
            blob_id: blob_id.into(),
            distance,
            created_at: t_now(),
            importance: crate::services::extractor::IMPORTANCE_STANDARD,
            embedding: emb,
        }
    }

    fn ids(hits: &[SearchHit]) -> Vec<&str> {
        hits.iter().map(|h| h.blob_id.as_str()).collect()
    }

    /// Run MMR with relevance derived from each hit's distance (`1 −
    /// distance`), matching how the live pipeline feeds the composite score
    /// (which, at default weights, *is* `1 − distance`). Keeps these unit
    /// tests focused on the MMR mechanism itself rather than composite
    /// scoring, while exercising the real normalised-relevance code path.
    fn run(hits: Vec<SearchHit>, config: &MmrConfig) -> Vec<SearchHit> {
        let rel: Vec<f64> = hits.iter().map(|h| 1.0 - h.distance).collect();
        mmr_rerank(hits, &rel, config)
    }

    /// MMR-on config with a given lambda and a pool large enough to cover
    /// the small fixtures (so the whole input is reranked, no tail).
    fn cfg(lambda: f64) -> MmrConfig {
        MmrConfig {
            enabled: true,
            lambda,
            pool_n: 100,
        }
    }

    // ── cosine_similarity ─────────────────────────────────────

    #[test]
    fn cosine_identical_vectors_is_one() {
        let v = vec![0.3, 0.4, 0.5];
        let c = cosine_similarity(&v, &v);
        assert!((c - 1.0).abs() < 1e-9, "expected 1.0, got {c}");
    }

    #[test]
    fn cosine_orthogonal_vectors_is_zero() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        assert!((cosine_similarity(&a, &b)).abs() < 1e-9);
    }

    #[test]
    fn cosine_is_magnitude_invariant() {
        // Same direction, very different lengths → still ≈1.0. This is the
        // whole reason we use cosine (angle) not dot/euclidean: text length
        // shouldn't change "how similar in meaning".
        let a = vec![1.0, 1.0];
        let b = vec![100.0, 100.0];
        assert!((cosine_similarity(&a, &b) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn cosine_opposite_vectors_is_negative_one() {
        let a = vec![1.0, 0.0];
        let b = vec![-1.0, 0.0];
        assert!((cosine_similarity(&a, &b) + 1.0).abs() < 1e-9);
    }

    #[test]
    fn cosine_mismatched_or_empty_lengths_is_zero_not_nan() {
        // Corrupt/legacy row guard — a length mismatch must yield 0.0 and
        // never NaN (a NaN would poison the running `max` in the redundancy
        // term and silently break ordering).
        assert_eq!(cosine_similarity(&[1.0, 2.0], &[1.0]), 0.0);
        assert_eq!(cosine_similarity(&[], &[]), 0.0);
        assert!(cosine_similarity(&[1.0, 2.0], &[1.0]).is_finite());
    }

    #[test]
    fn cosine_zero_magnitude_is_zero_not_nan() {
        // A zero vector has no direction → undefined cosine → we return 0.0
        // rather than 0/0 = NaN.
        let zero = vec![0.0, 0.0, 0.0];
        let v = vec![1.0, 2.0, 3.0];
        assert_eq!(cosine_similarity(&zero, &v), 0.0);
        assert!(cosine_similarity(&zero, &v).is_finite());
    }

    // ── identity / fast-path contracts ────────────────────────

    #[test]
    fn disabled_is_identity() {
        // The master switch off ⇒ input returned untouched, even with
        // obviously-redundant hits that MMR *would* reorder if enabled.
        let hits = vec![
            sh("a", 0.10, vec![1.0, 0.0]),
            sh("b", 0.11, vec![1.0, 0.0]), // identical embedding to a
            sh("c", 0.40, vec![0.0, 1.0]),
        ];
        let cfg = MmrConfig {
            enabled: false,
            ..cfg(0.5)
        };
        let out = run(hits, &cfg);
        assert_eq!(ids(&out), vec!["a", "b", "c"]);
    }

    #[test]
    fn fewer_than_two_hits_is_identity() {
        let one = vec![sh("solo", 0.2, vec![1.0, 0.0])];
        let out = run(one, &cfg(0.5));
        assert_eq!(ids(&out), vec!["solo"]);

        let none: Vec<SearchHit> = vec![];
        assert!(run(none, &cfg(0.5)).is_empty());
    }

    #[test]
    fn lambda_one_reproduces_relevance_order() {
        // λ=1 ⇒ pure relevance ⇒ the redundancy term is zeroed ⇒ the
        // already-relevance-sorted input is returned unchanged, even though
        // a and b are identical (maximally redundant).
        let hits = vec![
            sh("a", 0.10, vec![1.0, 0.0]),
            sh("b", 0.11, vec![1.0, 0.0]),
            sh("c", 0.40, vec![0.0, 1.0]),
        ];
        let out = run(hits, &cfg(1.0));
        assert_eq!(ids(&out), vec!["a", "b", "c"]);
    }

    // ── the headline behaviour: diverse-fact rescue ───────────

    #[test]
    fn promotes_diverse_fact_over_redundant_high_relevance() {
        // THE point of the whole feature. Three "dog" facts (near-identical
        // embeddings, high relevance) and one "cat" fact (different
        // embedding, slightly lower relevance). Pure relevance would order
        // dog1, dog2, dog3, cat — burying the cat. MMR at λ=0.5 should pull
        // the cat up to 2nd: after picking the top dog, the other dogs are
        // crushed by the redundancy penalty while the cat (dissimilar) is
        // not.
        let dog = vec![1.0, 0.0]; // dog direction
        let cat = vec![0.0, 1.0]; // orthogonal: maximally different
        let hits = vec![
            sh("dog1", 0.08, dog.clone()), // most relevant
            sh("dog2", 0.10, dog.clone()),
            sh("dog3", 0.12, dog.clone()),
            sh("cat", 0.20, cat.clone()), // less relevant, but novel
        ];
        let out = run(hits, &cfg(0.5));
        // dog1 first (most relevant, nothing to be redundant with yet),
        // then cat rescued to 2nd over the redundant dog2/dog3.
        assert_eq!(out[0].blob_id, "dog1");
        assert_eq!(
            out[1].blob_id,
            "cat",
            "expected the diverse cat fact rescued to 2nd, got order {:?}",
            ids(&out)
        );
    }

    #[test]
    fn high_lambda_keeps_redundant_facts_ahead_of_irrelevant() {
        // With λ leaning to relevance (0.8), a redundant-but-relevant fact
        // should still beat a novel-but-irrelevant one — the mirror of the
        // rescue case. Proves λ actually tunes the trade-off.
        let dog = vec![1.0, 0.0];
        let noise = vec![0.0, 1.0];
        let hits = vec![
            sh("dog1", 0.05, dog.clone()),    // very relevant
            sh("dog2", 0.10, dog.clone()),    // redundant but still relevant
            sh("noise", 0.85, noise.clone()), // novel but irrelevant
        ];
        let out = run(hits, &cfg(0.8));
        // dog1 first; at high λ, the still-relevant dog2 should beat the
        // irrelevant noise for 2nd.
        assert_eq!(out[0].blob_id, "dog1");
        assert_eq!(
            out[1].blob_id,
            "dog2",
            "at λ=0.8 the relevant-but-redundant fact should beat noise, got {:?}",
            ids(&out)
        );
    }

    // ── permutation / losslessness invariants ─────────────────

    #[test]
    fn output_is_a_lossless_permutation() {
        // No hit added, dropped, or duplicated — every blob_id in, every
        // blob_id out, same count. The recall handler relies on this.
        let hits = vec![
            sh("a", 0.10, vec![1.0, 0.0, 0.0]),
            sh("b", 0.20, vec![0.0, 1.0, 0.0]),
            sh("c", 0.30, vec![0.0, 0.0, 1.0]),
            sh("d", 0.40, vec![1.0, 1.0, 0.0]),
        ];
        let out = run(hits, &cfg(0.5));
        assert_eq!(out.len(), 4);
        let mut got = ids(&out);
        got.sort_unstable();
        assert_eq!(got, vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn pool_n_smaller_than_input_reranks_prefix_keeps_tail() {
        // pool_n=2 ⇒ only the first two hits are reranked; the tail (c, d)
        // keeps its original relative order and stays after the reranked
        // prefix. Losslessness still holds.
        let dog = vec![1.0, 0.0];
        let cat = vec![0.0, 1.0];
        let hits = vec![
            sh("a", 0.10, dog.clone()),
            sh("b", 0.12, cat.clone()),
            sh("c", 0.30, dog.clone()),
            sh("d", 0.40, cat.clone()),
        ];
        let cfg = MmrConfig {
            enabled: true,
            lambda: 0.5,
            pool_n: 2,
        };
        let out = run(hits, &cfg);
        assert_eq!(out.len(), 4);
        // Tail order preserved: c before d, both after the reranked prefix.
        let order = ids(&out);
        let c_pos = order.iter().position(|&x| x == "c").unwrap();
        let d_pos = order.iter().position(|&x| x == "d").unwrap();
        assert!(
            c_pos < d_pos,
            "tail order should be preserved, got {order:?}"
        );
        assert!(
            c_pos >= 2 && d_pos >= 2,
            "tail must follow the prefix, got {order:?}"
        );
    }

    #[test]
    fn deterministic_across_runs() {
        // No clock/RNG: identical input ⇒ identical output, every time.
        let make = || {
            vec![
                sh("a", 0.10, vec![1.0, 0.0]),
                sh("b", 0.10, vec![1.0, 0.0]), // tie with a on every axis
                sh("c", 0.30, vec![0.0, 1.0]),
            ]
        };
        let r1 = ids(&run(make(), &cfg(0.5)))
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        let r2 = ids(&run(make(), &cfg(0.5)))
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        assert_eq!(r1, r2);
        // Tie-break favours the earlier (more relevant) index: a before b.
        assert_eq!(r1[0], "a");
    }

    #[test]
    fn empty_embeddings_dont_panic_or_nan() {
        // Defensive: if embeddings are missing (empty Vec), the redundancy
        // term collapses to 0 (cosine returns 0 for empty) and MMR degrades
        // gracefully to relevance order rather than panicking.
        let hits = vec![
            sh("a", 0.10, Vec::new()),
            sh("b", 0.20, Vec::new()),
            sh("c", 0.30, Vec::new()),
        ];
        let out = run(hits, &cfg(0.5));
        assert_eq!(out.len(), 3);
        // With zero redundancy everywhere, order is by relevance.
        assert_eq!(ids(&out), vec!["a", "b", "c"]);
    }

    // ── config parsing ────────────────────────────────────────

    #[test]
    fn config_default_is_off() {
        let c = MmrConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.lambda, 0.5);
        assert_eq!(c.pool_n, 30);
    }

    #[test]
    fn config_resolve_unset_is_default_off() {
        let c = MmrConfig::resolve(None, None, None);
        assert!(!c.enabled);
        assert_eq!(c.lambda, 0.5);
        assert_eq!(c.pool_n, 30);
    }

    #[test]
    fn config_resolve_enabled_tokens() {
        for t in ["true", "1", "yes", "on", "TRUE", " On "] {
            assert!(
                MmrConfig::resolve(Some(t.into()), None, None).enabled,
                "{t} should enable"
            );
        }
        for t in ["false", "0", "no", "off", ""] {
            assert!(
                !MmrConfig::resolve(Some(t.into()), None, None).enabled,
                "{t} should disable"
            );
        }
    }

    #[test]
    fn config_resolve_unrecognized_enabled_token_is_off() {
        // The footgun the panel flagged: MMR_ENABLED=tru must NOT silently
        // enable, and must NOT silently look-on either — it resolves OFF
        // (and warns, though we can't assert the log here).
        let c = MmrConfig::resolve(Some("tru".into()), Some("0.7".into()), None);
        assert!(!c.enabled, "a typo'd MMR_ENABLED must resolve OFF");
    }

    #[test]
    fn config_resolve_lambda_clamped_and_parsed() {
        assert_eq!(
            MmrConfig::resolve(None, Some("0.7".into()), None).lambda,
            0.7
        );
        assert_eq!(
            MmrConfig::resolve(None, Some("1.5".into()), None).lambda,
            1.0
        ); // clamp hi
        assert_eq!(
            MmrConfig::resolve(None, Some("-0.5".into()), None).lambda,
            0.0
        ); // clamp lo
           // Unparseable / non-finite → default.
        assert_eq!(
            MmrConfig::resolve(None, Some("abc".into()), None).lambda,
            0.5
        );
        assert_eq!(
            MmrConfig::resolve(None, Some("nan".into()), None).lambda,
            0.5
        );
        assert_eq!(
            MmrConfig::resolve(None, Some("inf".into()), None).lambda,
            0.5
        );
    }

    #[test]
    fn config_resolve_pool_n_validated() {
        assert_eq!(MmrConfig::resolve(None, None, Some("50".into())).pool_n, 50);
        assert_eq!(MmrConfig::resolve(None, None, Some("0".into())).pool_n, 30); // zero → default
        assert_eq!(MmrConfig::resolve(None, None, Some("-5".into())).pool_n, 30); // neg → default
        assert_eq!(MmrConfig::resolve(None, None, Some("x".into())).pool_n, 30);
        // garbage → default
    }

    // ── min-max normalisation of the relevance term ───────────

    #[test]
    fn relevance_is_min_max_normalised_over_pool() {
        // Relevance scores on an arbitrary scale (here 10..40, NOT [0,1])
        // must be rescaled to [0,1] before mixing with the cosine
        // redundancy term, else λ is meaningless. We feed wildly out-of-
        // range composite scores and assert the diverse-fact rescue still
        // happens — which only works if normalisation put relevance and
        // redundancy on the same scale.
        let dog = vec![1.0, 0.0];
        let cat = vec![0.0, 1.0];
        let hits = vec![
            sh("dog1", 0.0, dog.clone()),
            sh("dog2", 0.0, dog.clone()),
            sh("dog3", 0.0, dog.clone()),
            sh("cat", 0.0, cat.clone()),
        ];
        // Composite scores on a 10..40 scale (relevance-sorted desc).
        let rel = vec![40.0, 30.0, 20.0, 15.0];
        let out = mmr_rerank(hits, &rel, &cfg(0.5));
        assert_eq!(out[0].blob_id, "dog1");
        assert_eq!(
            out[1].blob_id,
            "cat",
            "normalised relevance should still let the cat be rescued; got {:?}",
            ids(&out)
        );
    }

    #[test]
    fn all_equal_relevance_orders_purely_by_diversity() {
        // Degenerate pool: every composite score identical → span 0 →
        // relevance normalises to all-zeros → MMR orders purely by
        // diversity, and ties fall back to input order. Must not divide by
        // zero or NaN.
        let dog = vec![1.0, 0.0];
        let cat = vec![0.0, 1.0];
        let hits = vec![
            sh("dog1", 0.0, dog.clone()),
            sh("dog2", 0.0, dog.clone()),
            sh("cat", 0.0, cat.clone()),
        ];
        let rel = vec![5.0, 5.0, 5.0]; // all equal
        let out = mmr_rerank(hits, &rel, &cfg(0.5));
        assert_eq!(out.len(), 3);
        // dog1 first (input order tie-break), then cat (most diverse from
        // dog1), then dog2.
        assert_eq!(ids(&out), vec!["dog1", "cat", "dog2"]);
    }

    #[test]
    fn non_finite_relevance_maps_to_pool_min_not_nan() {
        // A NaN/inf relevance score (e.g. a NaN distance upstream) must map
        // to the pool minimum (normalised 0.0), never poison the range or
        // drop the hit. Losslessness must hold.
        let v = vec![1.0, 0.0];
        let hits = vec![
            sh("a", 0.0, v.clone()),
            sh("b", 0.0, vec![0.0, 1.0]),
            sh("nan", 0.0, vec![0.0, 0.0, 1.0]),
        ];
        let rel = vec![1.0, 0.5, f64::NAN];
        let out = mmr_rerank(hits, &rel, &cfg(0.5));
        assert_eq!(out.len(), 3, "lossless even with a NaN relevance");
        let mut got = ids(&out);
        got.sort_unstable();
        assert_eq!(got, vec!["a", "b", "nan"]);
    }

    // ── rank_and_diversify: the two-stage pipeline ────────────

    /// Build a SearchHit with explicit distance + age + importance, for the
    /// pipeline tests that exercise the composite-scoring stage.
    fn sh_full(
        blob_id: &str,
        distance: f64,
        age_days: i64,
        importance: f32,
        emb: Vec<f32>,
    ) -> SearchHit {
        SearchHit {
            blob_id: blob_id.into(),
            distance,
            created_at: t_now() - chrono::Duration::days(age_days),
            importance,
            embedding: emb,
        }
    }

    #[test]
    fn pipeline_mmr_off_is_pure_composite_order() {
        // With MMR off, rank_and_diversify == the composite ranker: at
        // default weights it preserves pgvector (distance) order.
        let off = MmrConfig {
            enabled: false,
            ..cfg(0.5)
        };
        let hits = vec![
            sh_full("near", 0.10, 0, IMPORTANCE_STANDARD, vec![1.0, 0.0]),
            sh_full("mid", 0.30, 0, IMPORTANCE_STANDARD, vec![1.0, 0.0]),
            sh_full("far", 0.50, 0, IMPORTANCE_STANDARD, vec![0.0, 1.0]),
        ];
        let out = rank_and_diversify(hits, &ScoringWeights::default(), &off, t_now());
        assert_eq!(ids(&out), vec!["near", "mid", "far"]);
    }

    #[test]
    fn pipeline_layering_mmr_order_survives_active_weights() {
        // THE REGRESSION TEST FOR THE LAYERING FIX. Even with active
        // (importance-heavy) weights — which previously triggered a SECOND
        // pointwise sort that scrambled MMR — the diverse fact must survive
        // in the FINAL order. Composite scores first, MMR composes last,
        // nothing re-sorts after.
        let dog = vec![1.0, 0.0];
        let cat = vec![0.0, 1.0];
        // Three redundant dogs (one VITAL so importance weight would, under
        // the old broken layering, re-sort it to the top and bury the cat),
        // and a STANDARD-importance cat.
        let hits = vec![
            sh_full("dog1", 0.08, 0, IMPORTANCE_STANDARD, dog.clone()),
            sh_full("dog_vital", 0.10, 0, IMPORTANCE_VITAL, dog.clone()),
            sh_full("dog3", 0.12, 0, IMPORTANCE_STANDARD, dog.clone()),
            sh_full("cat", 0.20, 0, IMPORTANCE_STANDARD, cat.clone()),
        ];
        // Importance-heavy weights — the case that broke before the refactor.
        let weights = ScoringWeights {
            semantic: 0.3,
            recency: 0.0,
            recency_half_life_days: 30.0,
            importance: 0.7,
        };
        let out = rank_and_diversify(hits, &weights, &cfg(0.5), t_now());
        // The cat (diverse) must appear in the top 2 — NOT buried below all
        // three dogs by a post-MMR importance re-sort. Pin it at position 2:
        // after the top dog, the cat's novelty beats the redundant dogs.
        assert_eq!(
            out[1].blob_id,
            "cat",
            "layering bug: composite re-sort buried the diverse fact; order {:?}",
            ids(&out)
        );
    }

    #[test]
    fn pipeline_empty_input_is_empty() {
        let out = rank_and_diversify(vec![], &ScoringWeights::default(), &cfg(0.5), t_now());
        assert!(out.is_empty());
    }

    #[test]
    fn pipeline_is_lossless_permutation_under_active_weights() {
        use crate::services::extractor::IMPORTANCE_VITAL;
        let hits = vec![
            sh_full("a", 0.10, 0, IMPORTANCE_STANDARD, vec![1.0, 0.0, 0.0]),
            sh_full("b", 0.20, 5, IMPORTANCE_VITAL, vec![0.0, 1.0, 0.0]),
            sh_full("c", 0.30, 10, IMPORTANCE_STANDARD, vec![0.0, 0.0, 1.0]),
        ];
        let weights = ScoringWeights {
            semantic: 0.5,
            recency: 0.3,
            recency_half_life_days: 30.0,
            importance: 0.2,
        };
        let out = rank_and_diversify(hits, &weights, &cfg(0.5), t_now());
        let mut got = ids(&out);
        got.sort_unstable();
        assert_eq!(got, vec!["a", "b", "c"]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 5, 14, 12, 0, 0).unwrap()
    }

    fn hit(blob_id: &str, distance: f64, age_days: i64) -> HydratedMemory {
        HydratedMemory {
            blob_id: blob_id.into(),
            text: format!("text for {}", blob_id),
            distance,
            created_at: Some(now() - chrono::Duration::days(age_days)),
            // Default to the neutral bucket so existing tests stay
            // semantically the same — `importance_term` is only non-zero
            // when both the weight and the per-hit value are set.
            importance: Some(crate::services::extractor::IMPORTANCE_STANDARD),
        }
    }

    /// Variant for importance tests: lets the test pin the bucket
    /// value (vital / standard / trivial) per hit.
    fn hit_imp(blob_id: &str, distance: f64, age_days: i64, importance: f32) -> HydratedMemory {
        HydratedMemory {
            blob_id: blob_id.into(),
            text: format!("text for {}", blob_id),
            distance,
            created_at: Some(now() - chrono::Duration::days(age_days)),
            importance: Some(importance),
        }
    }

    fn ids(hits: &[RankedHit]) -> Vec<&str> {
        hits.iter().map(|h| h.memory.blob_id.as_str()).collect()
    }

    #[test]
    fn default_weights_preserve_input_order() {
        // Default weights = semantic-only = identity transform on a
        // list already cosine-sorted by pgvector. This is the byte-
        // identical-to-today contract.
        let hits = vec![
            hit("near", 0.10, 0),
            hit("middle", 0.30, 100),
            hit("far", 0.50, 1),
        ];
        let ranked = CompositeRanker.rank(hits, &ScoringWeights::default(), now());
        assert_eq!(ids(&ranked), vec!["near", "middle", "far"]);
    }

    #[test]
    fn recency_zero_is_short_circuit_no_reorder() {
        // Even with a non-default semantic weight, recency=0 means the
        // score is monotonic in distance, so the input order is kept.
        // Important: we don't sort, we return-as-is. Pin that here.
        let weights = ScoringWeights {
            semantic: 5.0,
            recency: 0.0,
            recency_half_life_days: 30.0,
            importance: 0.0,
        };
        // Deliberately out-of-cosine-order input — proves we don't
        // re-sort it.
        let hits = vec![hit("b", 0.50, 0), hit("a", 0.10, 0), hit("c", 0.30, 0)];
        let ranked = CompositeRanker.rank(hits, &weights, now());
        assert_eq!(ids(&ranked), vec!["b", "a", "c"]);
    }

    #[test]
    fn recency_heavy_promotes_recent_memory() {
        // Two hits: "older" has slightly better semantic match, "newer"
        // has a tiny semantic edge but is brand new. With recency-heavy
        // weights, "newer" should win.
        let older = hit("older", 0.20, 365); // 1 year old
        let newer = hit("newer", 0.25, 0); // today
        let weights = ScoringWeights {
            semantic: 0.4,
            recency: 0.6,
            recency_half_life_days: 30.0,
            importance: 0.0,
        };
        let ranked = CompositeRanker.rank(vec![older, newer], &weights, now());
        assert_eq!(ids(&ranked), vec!["newer", "older"]);
    }

    #[test]
    fn semantic_dominates_when_recency_weight_small() {
        // Same two hits, but now recency is a small tie-breaker. The
        // older memory's semantic edge should hold.
        let older = hit("older", 0.10, 365);
        let newer = hit("newer", 0.50, 0);
        let weights = ScoringWeights {
            semantic: 1.0,
            recency: 0.01,
            recency_half_life_days: 30.0,
            importance: 0.0,
        };
        let ranked = CompositeRanker.rank(vec![older, newer], &weights, now());
        assert_eq!(ids(&ranked), vec!["older", "newer"]);
    }

    #[test]
    fn missing_created_at_treated_as_no_recency_contribution() {
        // A hit with `created_at = None` (engine forgot to populate, or
        // benchmark mode) gets recency score 0. With recency-only weights
        // it should rank below any hit that *does* have a timestamp.
        let mut undated = hit("undated", 0.10, 0);
        undated.created_at = None;
        let dated_old = hit("dated_old", 0.50, 90); // older but timestamped
        let weights = ScoringWeights {
            semantic: 0.0,
            recency: 1.0,
            recency_half_life_days: 30.0,
            importance: 0.0,
        };
        let ranked = CompositeRanker.rank(vec![undated, dated_old], &weights, now());
        // dated_old has SOME recency contribution (e^(-3) ≈ 0.05); undated
        // has 0. So dated_old wins.
        assert_eq!(ids(&ranked), vec!["dated_old", "undated"]);
    }

    #[test]
    fn future_created_at_clamps_age_to_zero() {
        // Defence against clock skew / a row inserted with a created_at
        // in the future (shouldn't happen but pin behaviour). Age clamps
        // at 0, so recency score is 1.0 * recency_weight.
        let weights = ScoringWeights {
            semantic: 0.0,
            recency: 1.0,
            recency_half_life_days: 30.0,
            importance: 0.0,
        };
        let mut future_hit = hit("future", 0.50, 0);
        future_hit.created_at = Some(now() + chrono::Duration::days(7));
        let score = CompositeRanker::score(&future_hit, &weights, now());
        // exp(-0/30) = 1.0; recency weight = 1.0 → score should be exactly 1.0.
        assert!((score - 1.0).abs() < 1e-9, "expected 1.0, got {}", score);
    }

    #[test]
    fn non_positive_half_life_disables_recency() {
        // Guard: a request with half_life <= 0 would otherwise divide
        // by zero / invert the decay. Verify we just zero out recency
        // instead of crashing.
        let weights = ScoringWeights {
            semantic: 0.0,
            recency: 1.0,
            recency_half_life_days: 0.0,
            importance: 0.0,
        };
        let h = hit("any", 0.10, 0);
        let score = CompositeRanker::score(&h, &weights, now());
        assert_eq!(score, 0.0);
    }

    #[test]
    fn empty_hits_returns_empty() {
        let weights = ScoringWeights {
            semantic: 1.0,
            recency: 1.0,
            recency_half_life_days: 30.0,
            importance: 0.0,
        };
        let ranked = CompositeRanker.rank(vec![], &weights, now());
        assert!(ranked.is_empty());
    }

    #[test]
    fn half_life_formula_matches_spec() {
        // A memory exactly at the half-life mark should have recency
        // contribution = recency_weight * 0.5.
        let weights = ScoringWeights {
            semantic: 0.0,
            recency: 1.0,
            recency_half_life_days: 30.0,
            importance: 0.0,
        };
        let h = hit("at_half_life", 0.50, 30);
        let score = CompositeRanker::score(&h, &weights, now());
        assert!(
            (score - 0.5).abs() < 1e-9,
            "expected 0.5 at half_life, got {}",
            score
        );
    }

    #[test]
    fn short_circuit_returns_score_none() {
        // When recency=0 the ranker short-circuits — every RankedHit must
        // carry `score: None` so the handler omits the wire-level `score`
        // field. Pins the "byte-identical to today's response shape" contract.
        let weights = ScoringWeights::default();
        let hits = vec![hit("a", 0.10, 0), hit("b", 0.30, 0)];
        let ranked = CompositeRanker.rank(hits, &weights, now());
        assert!(
            ranked.iter().all(|r| r.score.is_none()),
            "expected all scores None on short-circuit, got {:?}",
            ranked.iter().map(|r| r.score).collect::<Vec<_>>()
        );
    }

    #[test]
    fn full_path_returns_score_some() {
        // When recency>0 the ranker runs the math — every RankedHit must
        // carry `score: Some(_)` so the handler can surface it for client
        // debugging.
        let weights = ScoringWeights {
            semantic: 0.5,
            recency: 0.5,
            recency_half_life_days: 30.0,
            importance: 0.0,
        };
        let hits = vec![hit("a", 0.10, 5), hit("b", 0.30, 60)];
        let ranked = CompositeRanker.rank(hits, &weights, now());
        assert!(
            ranked.iter().all(|r| r.score.is_some()),
            "expected all scores Some on full path"
        );
        // Sanity: scores should be sorted descending.
        let scores: Vec<f64> = ranked.iter().map(|r| r.score.unwrap()).collect();
        for w in scores.windows(2) {
            assert!(w[0] >= w[1], "scores not in descending order: {:?}", scores);
        }
    }

    // ── importance signal tests ───────────────────────────────

    #[test]
    fn importance_only_promotes_vital_over_trivial() {
        // Same distance + same age. The only differentiator is the bucket:
        // vital (0.9) should outrank trivial (0.2) when the importance
        // weight is the sole non-zero signal.
        use crate::services::extractor::{IMPORTANCE_TRIVIAL, IMPORTANCE_VITAL};
        let trivial = hit_imp("trivial", 0.20, 5, IMPORTANCE_TRIVIAL);
        let vital = hit_imp("vital", 0.20, 5, IMPORTANCE_VITAL);
        let weights = ScoringWeights {
            semantic: 0.0,
            recency: 0.0,
            recency_half_life_days: 30.0,
            importance: 1.0,
        };
        let ranked = CompositeRanker.rank(vec![trivial, vital], &weights, now());
        assert_eq!(ids(&ranked), vec!["vital", "trivial"]);
    }

    #[test]
    fn importance_activates_ranker_without_recency() {
        // A non-zero importance weight on its own should activate the
        // ranker (is_ranker_active() returns true → ranker computes
        // scores, not short-circuits). Pins the is_ranker_active update.
        let weights = ScoringWeights {
            semantic: 1.0,
            recency: 0.0,
            recency_half_life_days: 30.0,
            importance: 0.5,
        };
        assert!(weights.is_ranker_active());
        let h = hit("a", 0.10, 0);
        let ranked = CompositeRanker.rank(vec![h], &weights, now());
        assert!(
            ranked[0].score.is_some(),
            "expected score Some when importance>0"
        );
    }

    #[test]
    fn importance_heavy_overrides_small_semantic_edge() {
        // "vital_far" has a slightly worse semantic match but a vital
        // bucket; "trivial_near" has a tiny semantic edge but a trivial
        // bucket. With importance-heavy weights, vital_far should win.
        use crate::services::extractor::{IMPORTANCE_TRIVIAL, IMPORTANCE_VITAL};
        let trivial_near = hit_imp("trivial_near", 0.20, 0, IMPORTANCE_TRIVIAL);
        let vital_far = hit_imp("vital_far", 0.25, 0, IMPORTANCE_VITAL);
        let weights = ScoringWeights {
            semantic: 0.3,
            recency: 0.0,
            recency_half_life_days: 30.0,
            importance: 0.7,
        };
        let ranked = CompositeRanker.rank(vec![trivial_near, vital_far], &weights, now());
        assert_eq!(ids(&ranked), vec!["vital_far", "trivial_near"]);
    }

    #[test]
    fn importance_zero_weight_is_inert() {
        // Even if every hit has a non-zero importance value, a zero
        // importance weight contributes nothing — the existing semantic
        // order should be preserved exactly.
        use crate::services::extractor::{IMPORTANCE_TRIVIAL, IMPORTANCE_VITAL};
        let vital_far = hit_imp("vital_far", 0.50, 0, IMPORTANCE_VITAL);
        let trivial_near = hit_imp("trivial_near", 0.10, 0, IMPORTANCE_TRIVIAL);
        // Default-ish weights (semantic only, no importance).
        let ranked = CompositeRanker.rank(
            vec![trivial_near, vital_far],
            &ScoringWeights::default(),
            now(),
        );
        // trivial_near has better cosine (0.10 vs 0.50) → wins.
        assert_eq!(ids(&ranked), vec!["trivial_near", "vital_far"]);
    }

    #[test]
    fn importance_missing_value_treated_as_neutral() {
        // A hit with `importance = None` (zip helper didn't populate, or
        // engine emitted a raw HydratedMemory we never saw a SearchHit
        // for) gets importance_term = 0.0. Mirrors the
        // `missing_created_at_treated_as_no_recency_contribution` case
        // for the recency signal.
        use crate::services::extractor::IMPORTANCE_VITAL;
        let mut undated_unrated = hit("undated_unrated", 0.10, 0);
        undated_unrated.importance = None;
        let vital = hit_imp("vital", 0.50, 0, IMPORTANCE_VITAL);
        let weights = ScoringWeights {
            semantic: 0.5,
            recency: 0.0,
            recency_half_life_days: 30.0,
            importance: 1.0,
        };
        let ranked = CompositeRanker.rank(vec![undated_unrated, vital], &weights, now());
        // undated_unrated: 0.5 * (1-0.10) + 1.0 * 0 (None) = 0.45
        // vital:           0.5 * (1-0.50) + 1.0 * 0.9    = 1.15
        // vital wins.
        assert_eq!(ids(&ranked), vec!["vital", "undated_unrated"]);
    }

    #[test]
    fn importance_score_formula_exact() {
        // Pin the exact arithmetic: semantic * (1 - distance) +
        // importance * bucket_value. Recency weight is 0 so the recency
        // term drops out cleanly.
        use crate::services::extractor::IMPORTANCE_STANDARD;
        let h = hit_imp("h", 0.20, 0, IMPORTANCE_STANDARD); // 0.5
        let weights = ScoringWeights {
            semantic: 1.0,
            recency: 0.0,
            recency_half_life_days: 30.0,
            importance: 0.4,
        };
        let score = CompositeRanker::score(&h, &weights, now());
        // 1.0 * (1.0 - 0.20) + 0.4 * 0.5 = 0.8 + 0.2 = 1.0
        assert!((score - 1.0).abs() < 1e-9, "expected 1.0, got {}", score);
    }
}
