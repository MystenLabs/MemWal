//! Write-stream concurrency limiter.
//!
//! Owns the single in-process budget for active write operations
//! (prep + upload). Every memory item that will result in a sidecar
//! /walrus/upload call must acquire a permit before starting work and
//! release it when the active phase ends.

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio::time::error::Elapsed;

const DEFAULT_WRITE_STREAM_MAX_CONCURRENCY: usize = 8;
const MIN_WRITE_STREAM_MAX_CONCURRENCY: usize = 1;
const MAX_WRITE_STREAM_MAX_CONCURRENCY: usize = 100;

#[derive(Debug)]
pub enum AcquireError {
    Timeout,
    Closed,
}

impl std::fmt::Display for AcquireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AcquireError::Timeout => write!(f, "write stream concurrency limit reached"),
            AcquireError::Closed => write!(f, "write stream limiter closed"),
        }
    }
}

impl std::error::Error for AcquireError {}

/// Guard that releases one or more permits when dropped.
#[derive(Debug)]
pub struct WriteStreamPermit {
    semaphore: Arc<Semaphore>,
    permits: usize,
}

impl Drop for WriteStreamPermit {
    fn drop(&mut self) {
        self.semaphore.add_permits(self.permits);
    }
}

/// In-process concurrency limiter for the write stream.
#[derive(Clone, Debug)]
pub struct WriteStreamLimiter {
    semaphore: Arc<Semaphore>,
    max_permits: usize,
}

impl WriteStreamLimiter {
    pub fn new(max_permits: usize) -> Self {
        let max_permits = max_permits
            .max(MIN_WRITE_STREAM_MAX_CONCURRENCY)
            .min(MAX_WRITE_STREAM_MAX_CONCURRENCY);
        Self {
            semaphore: Arc::new(Semaphore::new(max_permits)),
            max_permits,
        }
    }

    pub fn default_limiter() -> Self {
        Self::new(DEFAULT_WRITE_STREAM_MAX_CONCURRENCY)
    }

    pub fn max_permits(&self) -> usize {
        self.max_permits
    }

    pub fn available_permits(&self) -> usize {
        self.semaphore.available_permits()
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
        let n = n.min(self.max_permits);
        let permit = tokio::time::timeout(timeout, self.semaphore.acquire_many(n as u32))
            .await
            .map_err(|_: Elapsed| AcquireError::Timeout)?
            .map_err(|_| AcquireError::Closed)?;
        permit.forget();
        Ok(WriteStreamPermit {
            semaphore: Arc::clone(&self.semaphore),
            permits: n,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn acquire_returns_permit_when_available() {
        let limiter = WriteStreamLimiter::new(1);
        let permit = limiter.acquire(Duration::from_secs(1)).await.unwrap();
        assert_eq!(limiter.available_permits(), 0);
        drop(permit);
        assert_eq!(limiter.available_permits(), 1);
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
        assert_eq!(limiter.available_permits(), 2);
        let p23 = limiter.acquire_many(2, Duration::from_secs(1)).await.unwrap();
        assert_eq!(limiter.available_permits(), 0);
        drop(p23);
        assert_eq!(limiter.available_permits(), 2);
    }

    #[tokio::test]
    async fn zero_permits_noop() {
        let limiter = WriteStreamLimiter::new(1);
        let guard = limiter.acquire_many(0, Duration::from_secs(1)).await.unwrap();
        assert_eq!(guard.permits, 0);
        assert_eq!(limiter.available_permits(), 1);
    }

    #[tokio::test]
    async fn clamps_out_of_range_values() {
        let low = WriteStreamLimiter::new(0);
        assert_eq!(low.max_permits(), MIN_WRITE_STREAM_MAX_CONCURRENCY);
        let high = WriteStreamLimiter::new(10_000);
        assert_eq!(high.max_permits(), MAX_WRITE_STREAM_MAX_CONCURRENCY);
    }
}
