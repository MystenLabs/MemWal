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
use crate::types::ScoringWeights;
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
