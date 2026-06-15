//! Write-stream concurrency limiter.
//!
//! Owns the single in-process budget for active write operations
//! (prep + upload). Every memory item that will result in a sidecar
//! /walrus/upload call must acquire a permit before starting work and
//! release it when the active phase ends.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

const DEFAULT_WRITE_STREAM_MAX_CONCURRENCY: usize = 8;
const MIN_WRITE_STREAM_MAX_CONCURRENCY: usize = 1;
const MAX_WRITE_STREAM_MAX_CONCURRENCY: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcquireError {
    Timeout,
    Closed,
    WouldExceedCapacity { requested: usize, max: usize },
}

impl std::fmt::Display for AcquireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AcquireError::Timeout => write!(f, "write stream concurrency limit reached"),
            AcquireError::Closed => write!(f, "write stream limiter closed"),
            AcquireError::WouldExceedCapacity { requested, max } => write!(
                f,
                "write stream request for {requested} permits exceeds capacity of {max}"
            ),
        }
    }
}

impl std::error::Error for AcquireError {}

/// Guard that releases one or more permits when dropped.
#[derive(Debug)]
#[must_use = "permit releases on drop"]
pub struct WriteStreamPermit {
    semaphore: Arc<Semaphore>,
    permits: usize,
}

impl Drop for WriteStreamPermit {
    fn drop(&mut self) {
        self.semaphore.add_permits(self.permits);
    }
}

/// Snapshot of the write-stream limiter state.
#[derive(Clone, Copy, Debug)]
pub struct WriteStreamSnapshot {
    pub total: usize,
    pub available: usize,
    pub waiters: usize,
}

/// Decrements the waiter counter on drop, guarding against future cancellation.
struct WaiterGuard {
    waiters: Arc<AtomicUsize>,
}

impl WaiterGuard {
    fn new(waiters: Arc<AtomicUsize>) -> Self {
        waiters.fetch_add(1, Ordering::Relaxed);
        Self { waiters }
    }
}

impl Drop for WaiterGuard {
    fn drop(&mut self) {
        self.waiters.fetch_sub(1, Ordering::Relaxed);
    }
}

/// In-process concurrency limiter for the write stream.
#[derive(Clone, Debug)]
pub struct WriteStreamLimiter {
    semaphore: Arc<Semaphore>,
    max_permits: usize,
    waiters: Arc<AtomicUsize>,
}

impl WriteStreamLimiter {
    pub fn new(max_permits: usize) -> Self {
        let max_permits = max_permits.clamp(
            MIN_WRITE_STREAM_MAX_CONCURRENCY,
            MAX_WRITE_STREAM_MAX_CONCURRENCY,
        );
        Self {
            semaphore: Arc::new(Semaphore::new(max_permits)),
            max_permits,
            waiters: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn max_permits(&self) -> usize {
        self.max_permits
    }

    /// Return a point-in-time snapshot of limiter state.
    pub fn snapshot(&self) -> WriteStreamSnapshot {
        WriteStreamSnapshot {
            total: self.max_permits,
            available: self.semaphore.available_permits(),
            waiters: self.waiters.load(Ordering::Relaxed),
        }
    }

    /// Acquire a single permit, waiting up to `timeout`.
    pub async fn acquire(&self, timeout: Duration) -> Result<WriteStreamPermit, AcquireError> {
        self.acquire_many(1, timeout).await
    }

    /// Acquire `n` permits atomically with respect to this call, waiting up to `timeout`.
    /// The returned guard releases all `n` permits on drop.
    pub async fn acquire_many(
        &self,
        n: usize,
        timeout: Duration,
    ) -> Result<WriteStreamPermit, AcquireError> {
        if n == 0 {
            return Ok(WriteStreamPermit {
                semaphore: Arc::clone(&self.semaphore),
                permits: 0,
            });
        }
        if n > self.max_permits {
            return Err(AcquireError::WouldExceedCapacity {
                requested: n,
                max: self.max_permits,
            });
        }
        let _waiter_guard = WaiterGuard::new(Arc::clone(&self.waiters));
        let result = tokio::time::timeout(timeout, self.semaphore.acquire_many(n as u32))
            .await
            .map_err(|_| AcquireError::Timeout)
            .and_then(|res| res.map_err(|_| AcquireError::Closed));
        match result {
            Ok(permit) => {
                permit.forget();
                Ok(WriteStreamPermit {
                    semaphore: Arc::clone(&self.semaphore),
                    permits: n,
                })
            }
            Err(e) => Err(e),
        }
    }
}

impl Default for WriteStreamLimiter {
    fn default() -> Self {
        Self::new(DEFAULT_WRITE_STREAM_MAX_CONCURRENCY)
    }
}

#[cfg(test)]
impl WriteStreamLimiter {
    pub fn test_new(max_permits: usize) -> Self {
        Self::new(max_permits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn acquire_returns_permit_when_available() {
        let limiter = WriteStreamLimiter::new(1);
        let permit = limiter.acquire(Duration::from_secs(1)).await.unwrap();
        assert_eq!(limiter.snapshot().available, 0);
        drop(permit);
        assert_eq!(limiter.snapshot().available, 1);
    }

    #[tokio::test]
    async fn acquire_times_out_when_exhausted() {
        let limiter = WriteStreamLimiter::new(1);
        let _permit = limiter.acquire(Duration::from_secs(1)).await.unwrap();
        let err = limiter
            .acquire(Duration::from_millis(50))
            .await
            .unwrap_err();
        assert!(matches!(err, AcquireError::Timeout));
    }

    #[tokio::test]
    async fn acquire_many_returns_all_or_none() {
        let limiter = WriteStreamLimiter::new(3);
        let _p1 = limiter.acquire(Duration::from_secs(1)).await.unwrap();
        // asking for 3 when only 2 are free should time out
        let err = limiter
            .acquire_many(3, Duration::from_millis(50))
            .await
            .unwrap_err();
        assert!(matches!(err, AcquireError::Timeout));
        assert_eq!(limiter.snapshot().available, 2);
        let p23 = limiter
            .acquire_many(2, Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(limiter.snapshot().available, 0);
        drop(p23);
        assert_eq!(limiter.snapshot().available, 2);
    }

    #[tokio::test]
    async fn zero_permits_noop() {
        let limiter = WriteStreamLimiter::new(1);
        let guard = limiter
            .acquire_many(0, Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(guard.permits, 0);
        assert_eq!(limiter.snapshot().available, 1);
    }

    #[tokio::test]
    async fn snapshot_reports_state() {
        let limiter = WriteStreamLimiter::new(3);
        let before = limiter.snapshot();
        assert_eq!(before.total, 3);
        assert_eq!(before.available, 3);
        assert_eq!(before.waiters, 0);

        let permit = limiter.acquire(Duration::from_secs(1)).await.unwrap();
        let during = limiter.snapshot();
        assert_eq!(during.total, 3);
        assert_eq!(during.available, 2);
        assert_eq!(during.waiters, 0);
        drop(permit);

        let after = limiter.snapshot();
        assert_eq!(after.total, 3);
        assert_eq!(after.available, 3);
        assert_eq!(after.waiters, 0);
    }

    #[tokio::test]
    async fn waiters_increments_while_waiting() {
        let limiter = WriteStreamLimiter::new(1);
        let _permit = limiter.acquire(Duration::from_secs(1)).await.unwrap();

        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let waiting = tokio::spawn({
            let limiter = limiter.clone();
            async move {
                // signal that we are about to acquire
                let _ = entered_tx.send(());
                limiter.acquire(Duration::from_millis(200)).await
            }
        });
        entered_rx.await.unwrap();
        tokio::time::timeout(Duration::from_millis(100), async {
            while limiter.snapshot().waiters != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("waiter count should reach 1");

        let result = waiting.await.unwrap();
        assert!(matches!(result, Err(AcquireError::Timeout)));
        assert_eq!(limiter.snapshot().waiters, 0);
    }

    #[tokio::test]
    async fn waiters_decrements_on_timeout() {
        let limiter = WriteStreamLimiter::new(1);
        let _permit = limiter.acquire(Duration::from_secs(1)).await.unwrap();

        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let waiting = tokio::spawn({
            let limiter = limiter.clone();
            async move {
                let _ = entered_tx.send(());
                limiter.acquire(Duration::from_millis(50)).await
            }
        });
        entered_rx.await.unwrap();
        tokio::time::timeout(Duration::from_millis(100), async {
            while limiter.snapshot().waiters != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("waiter count should reach 1");

        let result = waiting.await.unwrap();
        assert!(matches!(result, Err(AcquireError::Timeout)));
        assert_eq!(limiter.snapshot().waiters, 0);
    }

    #[tokio::test]
    async fn waiters_decrements_on_cancellation() {
        let limiter = WriteStreamLimiter::new(1);
        let _permit = limiter.acquire(Duration::from_secs(1)).await.unwrap();

        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn({
            let limiter = limiter.clone();
            async move {
                let _ = entered_tx.send(());
                limiter.acquire(Duration::from_secs(60)).await
            }
        });

        entered_rx.await.unwrap();
        tokio::time::timeout(Duration::from_millis(100), async {
            while limiter.snapshot().waiters != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("waiter count should reach 1");

        handle.abort();
        let _ = handle.await;
        assert_eq!(limiter.snapshot().waiters, 0);
    }

    #[tokio::test]
    async fn clamps_out_of_range_values() {
        let low = WriteStreamLimiter::new(0);
        assert_eq!(low.max_permits(), MIN_WRITE_STREAM_MAX_CONCURRENCY);
        let high = WriteStreamLimiter::new(10_000);
        assert_eq!(high.max_permits(), MAX_WRITE_STREAM_MAX_CONCURRENCY);
    }

    #[tokio::test]
    async fn acquire_many_errors_when_requested_exceeds_capacity() {
        let limiter = WriteStreamLimiter::new(3);
        let err = limiter
            .acquire_many(5, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            AcquireError::WouldExceedCapacity {
                requested: 5,
                max: 3
            }
        ));
    }
}
