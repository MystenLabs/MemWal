//! Decision logic for the sidecar upload-queue saturation monitor.
//!
//! The polling loop lives in `main.rs`; parsing and the consecutive-check
//! state live here so the alert decision can be tested without a sidecar.

use serde_json::Value;

/// Sidecar route serving the upload-queue counters (`registerUploadMetricsRoute`
/// in `scripts/sidecar/routes/health.ts`).
pub const UPLOAD_METRICS_PATH: &str = "/metrics/uploads";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UploadQueueSample {
    pub queued: u64,
    pub active: u64,
    pub global_capacity: u64,
}

/// Reads the counters from a `/metrics/uploads` body. A missing or
/// non-integer field is `Err` with that field's JSON pointer; it must never be
/// read as 0.
pub fn parse_upload_metrics(body: &Value) -> Result<UploadQueueSample, &'static str> {
    let field =
        |pointer: &'static str| body.pointer(pointer).and_then(Value::as_u64).ok_or(pointer);
    Ok(UploadQueueSample {
        queued: field("/queuedWalrusUploads")?,
        active: field("/activeWalrusUploads")?,
        global_capacity: field("/walrusUploadLimits/globalCapacity")?,
    })
}

#[derive(Debug, PartialEq, Eq)]
pub enum QueueCheck {
    /// At or below the threshold, with no alerting streak to end.
    Clear,
    /// Back at or below the threshold after a streak that alerted.
    Drained,
    /// Above the threshold; `alert` once the streak is long enough.
    Saturated { consecutive: u32, alert: bool },
}

pub struct SaturationTracker {
    threshold: u64,
    alert_after: u32,
    consecutive: u32,
}

impl SaturationTracker {
    pub fn new(threshold: u64, alert_after: u32) -> Self {
        Self {
            threshold,
            alert_after,
            consecutive: 0,
        }
    }

    pub fn observe(&mut self, queued: u64) -> QueueCheck {
        if queued > self.threshold {
            self.consecutive = self.consecutive.saturating_add(1);
            return QueueCheck::Saturated {
                consecutive: self.consecutive,
                alert: self.consecutive >= self.alert_after,
            };
        }
        let alerted = self.consecutive >= self.alert_after;
        self.consecutive = 0;
        if alerted {
            QueueCheck::Drained
        } else {
            QueueCheck::Clear
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_the_upload_metrics_body() {
        let body = json!({
            "activeWalrusUploads": 5,
            "queuedWalrusUploads": 118,
            "walrusUploadLimits": {
                "globalCapacity": 5,
                "perWalletCapacity": 1,
                "acquireTimeoutMs": 120000
            }
        });
        assert_eq!(
            parse_upload_metrics(&body),
            Ok(UploadQueueSample {
                queued: 118,
                active: 5,
                global_capacity: 5,
            })
        );
    }

    #[test]
    fn a_liveness_body_is_an_error_not_an_empty_queue() {
        let body = json!({ "status": "ok", "uptimeMs": 86_400_000 });
        assert_eq!(parse_upload_metrics(&body), Err("/queuedWalrusUploads"));
    }

    #[test]
    fn a_missing_nested_capacity_is_an_error() {
        let body = json!({ "activeWalrusUploads": 5, "queuedWalrusUploads": 118 });
        assert_eq!(
            parse_upload_metrics(&body),
            Err("/walrusUploadLimits/globalCapacity")
        );
    }

    #[test]
    fn a_non_integer_counter_is_an_error() {
        let body = json!({
            "activeWalrusUploads": 5,
            "queuedWalrusUploads": "118",
            "walrusUploadLimits": { "globalCapacity": 5 }
        });
        assert_eq!(parse_upload_metrics(&body), Err("/queuedWalrusUploads"));
    }

    #[test]
    fn alerts_once_the_queue_stays_above_threshold_for_the_configured_checks() {
        let mut tracker = SaturationTracker::new(20, 3);
        let checks: Vec<QueueCheck> = [21, 40, 120, 118].map(|q| tracker.observe(q)).into();
        assert_eq!(
            checks,
            vec![
                QueueCheck::Saturated {
                    consecutive: 1,
                    alert: false
                },
                QueueCheck::Saturated {
                    consecutive: 2,
                    alert: false
                },
                QueueCheck::Saturated {
                    consecutive: 3,
                    alert: true
                },
                QueueCheck::Saturated {
                    consecutive: 4,
                    alert: true
                },
            ]
        );
    }

    #[test]
    fn a_queue_at_the_threshold_resets_the_streak() {
        let mut tracker = SaturationTracker::new(20, 3);
        tracker.observe(21);
        tracker.observe(21);
        assert_eq!(tracker.observe(20), QueueCheck::Clear);
        assert_eq!(
            tracker.observe(21),
            QueueCheck::Saturated {
                consecutive: 1,
                alert: false
            }
        );
    }

    #[test]
    fn draining_is_reported_only_after_a_streak_that_alerted() {
        let mut tracker = SaturationTracker::new(20, 2);
        tracker.observe(50);
        tracker.observe(50);
        assert_eq!(tracker.observe(0), QueueCheck::Drained);
        assert_eq!(tracker.observe(0), QueueCheck::Clear);
    }
}
