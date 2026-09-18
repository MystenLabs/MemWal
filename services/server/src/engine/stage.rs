//! Which step of a recall is running, so one that runs out of time can say
//! where it was stuck (WALM-396).
//!
//! The handler owns a [`StageMarker`] and runs the recall inside
//! [`run_with_deadline`], which makes that marker the task's current one.
//! Anything the recall awaits on the same task — the engine's `fetch_batch`
//! included — calls [`enter`] as it moves on, so the trait needs no extra
//! parameter. Outside a recall (`analyze` shares `fetch_batch`) `enter` does
//! nothing.

use std::future::Future;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;

/// Left for the 504 to reach the caller before its own deadline fires.
const DEADLINE_MARGIN: Duration = Duration::from_millis(1_000);
/// A budget shorter than this cannot fit an embed, so cutting at it would
/// only turn recalls that might have finished into errors.
const MIN_BUDGET: Duration = Duration::from_millis(2_000);
/// Upper bound on a caller-supplied deadline, so no number can overflow an
/// `Instant`. Ten minutes is far past anything a recall caller waits.
const MAX_DEADLINE_MS: u64 = 600_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RecallStage {
    Embed = 0,
    VectorSearch = 1,
    WalrusDownload = 2,
    SealDecrypt = 3,
}

impl RecallStage {
    /// The id sent to callers in a `RECALL_TIMEOUT` body.
    pub fn as_str(self) -> &'static str {
        match self {
            RecallStage::Embed => "embed",
            RecallStage::VectorSearch => "vector_search",
            RecallStage::WalrusDownload => "walrus_download",
            RecallStage::SealDecrypt => "seal_decrypt",
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            0 => RecallStage::Embed,
            1 => RecallStage::VectorSearch,
            2 => RecallStage::WalrusDownload,
            _ => RecallStage::SealDecrypt,
        }
    }
}

/// The stage one recall is in. Shared, because the handler has to read it
/// after the timed-out work has been dropped.
#[derive(Clone, Default)]
pub struct StageMarker(Arc<AtomicU8>);

impl StageMarker {
    pub fn set(&self, stage: RecallStage) {
        self.0.store(stage as u8, Ordering::Relaxed);
    }

    pub fn get(&self) -> RecallStage {
        RecallStage::from_u8(self.0.load(Ordering::Relaxed))
    }
}

tokio::task_local! {
    static CURRENT: StageMarker;
}

/// Mark `stage` as running for the recall this task is serving.
pub fn enter(stage: RecallStage) {
    let _ = CURRENT.try_with(|marker| marker.set(stage));
}

/// How long a recall may run for a caller that said it waits `deadline_ms`.
/// `None` when it said nothing: those callers keep today's behaviour.
pub fn budget_for(deadline_ms: Option<u64>) -> Option<Duration> {
    let caller = Duration::from_millis(deadline_ms?.min(MAX_DEADLINE_MS));
    Some(caller.saturating_sub(DEADLINE_MARGIN).max(MIN_BUDGET))
}

#[derive(Debug)]
pub struct StageTimedOut {
    pub stage: RecallStage,
    pub elapsed_ms: u64,
}

/// Run `fut` as the recall `marker` tracks, giving up after `budget`.
pub async fn run_with_deadline<F: Future>(
    marker: &StageMarker,
    budget: Option<Duration>,
    fut: F,
) -> Result<F::Output, StageTimedOut> {
    let started = Instant::now();
    let tracked = CURRENT.scope(marker.clone(), fut);
    let Some(budget) = budget else {
        return Ok(tracked.await);
    };
    tokio::time::timeout(budget, tracked)
        .await
        .map_err(|_| StageTimedOut {
            stage: marker.get(),
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
}

/// Logs the stage a recall was in if it is dropped before finishing, which
/// is what happens when the caller hangs up. Covers every caller, including
/// those that send no deadline.
pub struct HangUpGuard {
    marker: StageMarker,
    owner: String,
    started: Instant,
    armed: bool,
}

impl HangUpGuard {
    pub fn new(marker: StageMarker, owner: String) -> Self {
        Self {
            marker,
            owner,
            started: Instant::now(),
            armed: true,
        }
    }

    /// The recall finished (or answered its own timeout); nothing to report.
    pub fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for HangUpGuard {
    fn drop(&mut self) {
        if self.armed {
            tracing::warn!(
                owner = %self.owner,
                stage = self.marker.get().as_str(),
                elapsed_ms = self.started.elapsed().as_millis() as u64,
                "recall abandoned by the caller before it finished"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn a_missed_deadline_names_the_stage_that_was_running() {
        let marker = StageMarker::default();
        let outcome = run_with_deadline(&marker, Some(Duration::from_secs(14)), async {
            enter(RecallStage::Embed);
            tokio::time::sleep(Duration::from_secs(1)).await;
            enter(RecallStage::WalrusDownload);
            tokio::time::sleep(Duration::from_secs(60)).await;
        })
        .await;

        let timed_out = outcome.expect_err("a 60s download must not fit a 14s budget");
        assert_eq!(timed_out.stage, RecallStage::WalrusDownload);
        assert_eq!(timed_out.elapsed_ms, 14_000);
    }

    #[tokio::test(start_paused = true)]
    async fn without_a_budget_the_recall_runs_to_completion() {
        // Callers that send no deadline (Python, older SDKs) must see
        // exactly today's behaviour: however slow, the recall finishes.
        let marker = StageMarker::default();
        let outcome = run_with_deadline(&marker, None, async {
            tokio::time::sleep(Duration::from_secs(600)).await;
            7
        })
        .await;

        assert_eq!(outcome.unwrap(), 7);
    }

    #[tokio::test]
    async fn entering_a_stage_outside_a_recall_does_nothing() {
        // `analyze` shares `fetch_batch`, which marks the decrypt step.
        enter(RecallStage::SealDecrypt);
    }

    #[test]
    fn stage_ids_are_the_wire_names() {
        assert_eq!(RecallStage::Embed.as_str(), "embed");
        assert_eq!(RecallStage::VectorSearch.as_str(), "vector_search");
        assert_eq!(RecallStage::WalrusDownload.as_str(), "walrus_download");
        assert_eq!(RecallStage::SealDecrypt.as_str(), "seal_decrypt");
    }

    #[test]
    fn a_fresh_marker_starts_at_embed_and_follows_set() {
        let marker = StageMarker::default();
        assert_eq!(marker.get(), RecallStage::Embed);
        marker.set(RecallStage::SealDecrypt);
        assert_eq!(marker.get(), RecallStage::SealDecrypt);
    }

    #[test]
    fn the_budget_leaves_the_caller_a_second_and_never_drops_below_the_floor() {
        assert_eq!(budget_for(None), None);
        assert_eq!(
            budget_for(Some(15_000)),
            Some(Duration::from_millis(14_000))
        );
        // A deadline too short to fit an embed would only produce errors.
        assert_eq!(budget_for(Some(1_500)), Some(Duration::from_millis(2_000)));
        // Capped, so no caller-supplied number can overflow an `Instant`.
        assert_eq!(
            budget_for(Some(u64::MAX)),
            Some(Duration::from_millis(599_000))
        );
    }
}
