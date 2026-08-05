use super::{
    ExecResult, ObjectInfo, OwnedBlob, SharedObjectInfo, SuiApi, SuiEpoch, SuiErr, WalrusEpoch,
};
use async_trait::async_trait;
use base64::Engine as _;
use prost_types::FieldMask;
use std::collections::VecDeque;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use sui_rpc::field::FieldMaskUtil;
use sui_rpc::proto::sui::rpc::v2::{
    get_object_result, BatchGetObjectsRequest, ExecuteTransactionRequest, GetBalanceRequest,
    GetEpochRequest, GetObjectRequest, GetServiceInfoRequest, GetTransactionRequest,
    ListDynamicFieldsRequest, ListOwnedObjectsRequest, VerifySignatureRequest,
    VerifySignatureResponse,
};
use sui_sdk_types::{Digest, Transaction, TransactionEffects, UserSignature};
use tokio::sync::{Mutex, OwnedSemaphorePermit, RwLock, Semaphore};
use tokio::time::Instant;

const MAX_REQUESTS_PER_WINDOW: u32 = 1_000_000;
const MAX_REQUEST_WINDOW: Duration = Duration::from_secs(60 * 60);
const DEFAULT_RATE_LIMIT_COOLDOWN: Duration = Duration::from_secs(2);
const MAX_RATE_LIMIT_COOLDOWN: Duration = Duration::from_secs(60 * 60);
// Must cover one full 10-second provider window: a request arriving just
// after the 2,970th admission still gets a bounded chance to enter next window.
const INTERACTIVE_GATE_BUDGET: Duration = Duration::from_secs(12);
const DEFAULT_RPC_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RPC_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_RPC_MAX_IN_FLIGHT: usize = 64;
const MAX_RPC_MAX_IN_FLIGHT: usize = 10_000;
const BACKGROUND_QUOTA_PERCENT: usize = 90;
static RETRY_JITTER_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RequestPriority {
    #[default]
    Interactive,
    Background,
}

#[derive(Clone, Copy, Debug)]
pub struct RetryBudget {
    pub attempts: u32,
    pub base_delay_ms: u64,
}

impl RetryBudget {
    pub const INTERACTIVE: Self = Self {
        attempts: 3,
        base_delay_ms: 500,
    };
}

#[cfg(test)]
pub async fn with_retry<T, F, Fut>(budget: RetryBudget, mut operation: F) -> Result<T, SuiErr>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, SuiErr>>,
{
    let attempts = budget.attempts.max(1);
    for attempt in 0..attempts {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(error) if !error.is_retryable() || attempt + 1 == attempts => return Err(error),
            Err(_) => {
                let exponent = attempt.min(16);
                let base = budget.base_delay_ms.saturating_mul(1_u64 << exponent);
                // Small deterministic jitter avoids synchronized clients while keeping tests stable.
                let jitter = base.saturating_mul(((attempt as u64 * 37) % 21) + 90) / 100;
                tokio::time::sleep(Duration::from_millis(jitter)).await;
            }
        }
    }
    unreachable!("attempts is clamped to at least one")
}

#[derive(Clone)]
struct RateGate {
    requests_per_window: usize,
    window: Duration,
    state: Arc<Mutex<RateGateState>>,
    in_flight: Arc<Semaphore>,
    background_in_flight: Arc<Semaphore>,
}

struct RateGateState {
    admitted_at: VecDeque<Instant>,
    cooldown_until: Option<Instant>,
}

impl RateGate {
    fn new(requests_per_window: u32, window: Duration) -> Result<Self, SuiErr> {
        if requests_per_window == 0 {
            return Err(SuiErr::Rejected(
                "SUI_RPC_REQUESTS_PER_WINDOW must be greater than zero".into(),
            ));
        }
        if requests_per_window > MAX_REQUESTS_PER_WINDOW {
            return Err(SuiErr::Rejected(format!(
                "SUI_RPC_REQUESTS_PER_WINDOW must not exceed {MAX_REQUESTS_PER_WINDOW}"
            )));
        }
        if window.is_zero() {
            return Err(SuiErr::Rejected(
                "SUI_RPC_WINDOW_SECS must be greater than zero".into(),
            ));
        }
        if window > MAX_REQUEST_WINDOW {
            return Err(SuiErr::Rejected(
                "SUI_RPC_WINDOW_SECS must not exceed 3600".into(),
            ));
        }
        Ok(Self {
            requests_per_window: requests_per_window as usize,
            window,
            state: Arc::new(Mutex::new(RateGateState {
                admitted_at: VecDeque::new(),
                cooldown_until: None,
            })),
            in_flight: Arc::new(Semaphore::new(DEFAULT_RPC_MAX_IN_FLIGHT)),
            background_in_flight: Arc::new(Semaphore::new(
                DEFAULT_RPC_MAX_IN_FLIGHT * BACKGROUND_QUOTA_PERCENT / 100,
            )),
        })
    }

    fn with_max_in_flight(mut self, max_in_flight: usize) -> Result<Self, SuiErr> {
        if !(2..=MAX_RPC_MAX_IN_FLIGHT).contains(&max_in_flight) {
            return Err(SuiErr::Rejected(format!(
                "SUI_RPC_MAX_IN_FLIGHT must be between 2 and {MAX_RPC_MAX_IN_FLIGHT}"
            )));
        }
        let background = (max_in_flight * BACKGROUND_QUOTA_PERCENT / 100)
            .min(max_in_flight - 1)
            .max(1);
        self.in_flight = Arc::new(Semaphore::new(max_in_flight));
        self.background_in_flight = Arc::new(Semaphore::new(background));
        Ok(self)
    }

    async fn acquire(&self, priority: RequestPriority) -> RateGatePermit {
        let started = Instant::now();
        let background = if matches!(priority, RequestPriority::Background) {
            Some(
                Arc::clone(&self.background_in_flight)
                    .acquire_owned()
                    .await
                    .expect("security-delete background RPC semaphore is never closed"),
            )
        } else {
            None
        };
        let total = Arc::clone(&self.in_flight)
            .acquire_owned()
            .await
            .expect("security-delete RPC semaphore is never closed");
        loop {
            let wait = {
                let mut state = self.state.lock().await;
                let now = Instant::now();
                if state.cooldown_until.is_some_and(|deadline| deadline <= now) {
                    state.cooldown_until = None;
                }
                if let Some(deadline) = state.cooldown_until {
                    deadline.saturating_duration_since(now)
                } else {
                    while state
                        .admitted_at
                        .front()
                        .is_some_and(|admitted| now.duration_since(*admitted) >= self.window)
                    {
                        state.admitted_at.pop_front();
                    }
                    let admission_limit = match priority {
                        RequestPriority::Interactive => self.requests_per_window,
                        RequestPriority::Background => {
                            (self.requests_per_window * BACKGROUND_QUOTA_PERCENT / 100).max(1)
                        }
                    };
                    if state.admitted_at.len() < admission_limit {
                        state.admitted_at.push_back(now);
                        crate::observability::record_security_delete_sui_rpc_admission(
                            state.admitted_at.len(),
                            self.requests_per_window,
                            started.elapsed(),
                        );
                        return RateGatePermit {
                            _total: total,
                            _background: background,
                        };
                    }
                    let oldest = *state
                        .admitted_at
                        .front()
                        .expect("a full request window has an oldest admission");
                    self.window.saturating_sub(now.duration_since(oldest))
                }
            };
            tokio::time::sleep(wait).await;
        }
    }

    async fn cool_down_for(&self, duration: Duration) {
        let deadline = Instant::now() + duration;
        let mut state = self.state.lock().await;
        state.cooldown_until = Some(
            state
                .cooldown_until
                .map_or(deadline, |current| current.max(deadline)),
        );
    }
}

struct RateGatePermit {
    _total: OwnedSemaphorePermit,
    _background: Option<OwnedSemaphorePermit>,
}

#[derive(Clone)]
struct Timed<T> {
    value: T,
    fetched_at: Instant,
}

/// Gas price, keyed by the SUI epoch it was fetched in (gas price changes per Sui epoch).
type EpochGasPrice = (SuiEpoch, u64);

/// Walrus epoch schedule — the `epoch_duration_ms`/`first_epoch_start_ms` pair that lets a
/// Walrus epoch (e.g. `Blob.storage.end_epoch`) be converted into a wall-clock timestamp via
/// [`expires_at_from_epoch`]. Read from the Walrus staking pool's state object, which is a
/// SEPARATE on-chain object from the system object `walrus_epoch()` reads.
#[derive(Clone, Copy, Debug)]
pub struct WalrusEpochSchedule {
    pub epoch_duration_ms: u64,
    pub first_epoch_start_ms: u64,
}

/// Production gRPC implementation. Cloning it is cheap: `sui_rpc::Client`
/// clones the underlying channel and all caches/rate state are shared.
#[derive(Clone)]
pub struct SuiClient {
    rpc: sui_rpc::Client,
    gate: RateGate,
    epoch: Arc<RwLock<Option<Timed<SuiEpoch>>>>,
    walrus_epoch: Arc<RwLock<Option<Timed<WalrusEpoch>>>>,
    walrus_epoch_schedule: Arc<RwLock<Option<Timed<WalrusEpochSchedule>>>>,
    gas_price: Arc<RwLock<Option<Timed<EpochGasPrice>>>>,
    chain: Arc<RwLock<Option<[u8; 32]>>>,
    walrus_package: Option<String>,
    walrus_system: Option<String>,
    walrus_staking_pool: Option<String>,
    priority: RequestPriority,
    attempt_timeout: Duration,
}

impl SuiClient {
    pub fn new(grpc_url: &str, requests_per_window: u32, window: Duration) -> Result<Self, SuiErr> {
        let rpc = sui_rpc::Client::new(grpc_url)
            .map_err(|error| SuiErr::Rejected(format!("invalid Sui gRPC URL: {error}")))?;
        Ok(Self {
            rpc,
            gate: RateGate::new(requests_per_window, window)?,
            epoch: Arc::new(RwLock::new(None)),
            walrus_epoch: Arc::new(RwLock::new(None)),
            walrus_epoch_schedule: Arc::new(RwLock::new(None)),
            gas_price: Arc::new(RwLock::new(None)),
            chain: Arc::new(RwLock::new(None)),
            walrus_package: None,
            walrus_system: None,
            walrus_staking_pool: None,
            priority: RequestPriority::Interactive,
            attempt_timeout: DEFAULT_RPC_ATTEMPT_TIMEOUT,
        })
    }

    pub fn with_rpc_limits(
        mut self,
        attempt_timeout: Duration,
        max_in_flight: usize,
    ) -> Result<Self, SuiErr> {
        if attempt_timeout.is_zero() || attempt_timeout > MAX_RPC_ATTEMPT_TIMEOUT {
            return Err(SuiErr::Rejected(
                "SUI_RPC_ATTEMPT_TIMEOUT_MS must be between 1 and 60000".into(),
            ));
        }
        self.attempt_timeout = attempt_timeout;
        self.gate = self.gate.with_max_in_flight(max_in_flight)?;
        Ok(self)
    }

    pub fn with_walrus_config(
        mut self,
        package_id: String,
        system_object_id: String,
        staking_pool_id: String,
    ) -> Self {
        self.walrus_package = Some(package_id);
        self.walrus_system = Some(system_object_id);
        self.walrus_staking_pool = Some(staking_pool_id);
        self
    }

    pub fn background(&self) -> Self {
        let mut client = self.clone();
        client.priority = RequestPriority::Background;
        client
    }

    pub async fn verify_signature_request(
        &self,
        request: VerifySignatureRequest,
    ) -> Result<VerifySignatureResponse, SuiErr> {
        self.call(|mut client| {
            let request = request.clone();
            async move {
                client
                    .signature_verification_client()
                    .verify_signature(request)
                    .await
                    .map(|response| response.into_inner())
            }
        })
        .await
    }

    async fn call<T, F, Fut>(&self, mut f: F) -> Result<T, SuiErr>
    where
        F: FnMut(sui_rpc::Client) -> Fut,
        Fut: Future<Output = Result<T, tonic::Status>>,
    {
        let budget = RetryBudget::INTERACTIVE;
        let interactive_deadline = Instant::now() + INTERACTIVE_GATE_BUDGET;
        for attempt in 0..budget.attempts {
            let client = self.rpc.clone();
            let _in_flight = if matches!(self.priority, RequestPriority::Interactive) {
                let remaining = interactive_deadline.saturating_duration_since(Instant::now());
                tokio::time::timeout(remaining, self.gate.acquire(self.priority))
                    .await
                    .map_err(|_| {
                        SuiErr::Transport("Sui RPC gate wait exceeded interactive budget".into())
                    })?
            } else {
                self.gate.acquire(self.priority).await
            };
            let response = tokio::time::timeout(self.attempt_timeout, f(client)).await;
            let error = match response {
                Err(_) => SuiErr::Transport(format!(
                    "Sui RPC attempt exceeded {}ms deadline",
                    self.attempt_timeout.as_millis()
                )),
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(status))
                    if status.code() == tonic::Code::ResourceExhausted
                        || has_provider_retry_metadata(&status) =>
                {
                    crate::observability::record_security_delete_sui_rpc_provider_rate_limit();
                    let cooldown = provider_retry_delay(&status);
                    crate::observability::record_security_delete_sui_rpc_cooldown(cooldown);
                    self.gate.cool_down_for(cooldown).await;
                    if provider_forbids_retry(&status) {
                        return Err(SuiErr::RateLimited);
                    }
                    SuiErr::RateLimited
                }
                Ok(Err(status))
                    if matches!(
                        status.code(),
                        tonic::Code::Unavailable
                            | tonic::Code::DeadlineExceeded
                            | tonic::Code::Aborted
                    ) =>
                {
                    SuiErr::Transport(status.to_string())
                }
                Ok(Err(status)) => return Err(Self::classify_rejection(status)),
            };
            if attempt + 1 == budget.attempts {
                return Err(error);
            }
            let delay = budget
                .base_delay_ms
                .saturating_mul(1_u64 << attempt.min(16));
            let sequence = RETRY_JITTER_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let jitter =
                delay.saturating_mul(((sequence * 37 + u64::from(attempt)) % 21) + 90) / 100;
            tokio::time::sleep(Duration::from_millis(jitter)).await;
        }
        unreachable!("interactive retry budget is non-zero")
    }

    fn classify_rejection(status: tonic::Status) -> SuiErr {
        let message = status.to_string();
        if status.code() == tonic::Code::NotFound {
            return SuiErr::NotFound(message);
        }
        if status.code() == tonic::Code::InvalidArgument
            && message.contains("Invalid withdraw reservation")
            && message.contains("Available amount in account")
            && message.contains("is less than requested")
        {
            SuiErr::SponsorFundsUnavailable(message)
        } else {
            SuiErr::Rejected(message)
        }
    }

    fn object_info(object: sui_rpc::proto::sui::rpc::v2::Object) -> Result<ObjectInfo, SuiErr> {
        let json = object.json.as_deref().map(prost_json);
        let blob_id = json
            .as_ref()
            .and_then(|v| find_json_scalar(v, "blob_id"))
            .map(|id| canonical_blob_id(&id));
        let end_epoch = json
            .as_ref()
            .and_then(|v| find_json_u64(v, "end_epoch"))
            .map(WalrusEpoch);
        // Read at the top level only. A nested search would happily pick up some other
        // struct's package id; only the object's own field is meaningful here.
        let package_id = json
            .as_ref()
            .and_then(|value| value.get("package_id"))
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        Ok(ObjectInfo {
            object_id: object
                .object_id
                .ok_or_else(|| SuiErr::Transport("object response omitted object_id".into()))?,
            version: object
                .version
                .ok_or_else(|| SuiErr::Transport("object response omitted version".into()))?,
            digest: object
                .digest
                .ok_or_else(|| SuiErr::Transport("object response omitted digest".into()))?,
            owner: object.owner.and_then(|owner| owner.address),
            blob_id,
            end_epoch,
            package_id,
        })
    }

    fn exec_result(
        transaction: sui_rpc::proto::sui::rpc::v2::ExecutedTransaction,
    ) -> Result<ExecResult, SuiErr> {
        let digest = transaction
            .digest
            .ok_or_else(|| SuiErr::Transport("transaction response omitted digest".into()))?;
        let effects = transaction
            .effects
            .ok_or_else(|| SuiErr::Transport("transaction response omitted effects".into()))?;
        let effects = TransactionEffects::try_from(&effects)
            .map_err(|error| SuiErr::Transport(format!("invalid effects response: {error}")))?;
        Ok(ExecResult {
            digest,
            status: effects.status().clone(),
        })
    }
}

fn provider_retry_delay(status: &tonic::Status) -> Duration {
    if let Some(delay) = metadata_duration(status, "grpc-retry-pushback-ms", true) {
        return delay.min(MAX_RATE_LIMIT_COOLDOWN);
    }
    if let Some(delay) = metadata_duration(status, "retry-after", false) {
        return delay.min(MAX_RATE_LIMIT_COOLDOWN);
    }
    DEFAULT_RATE_LIMIT_COOLDOWN
}

fn has_provider_retry_metadata(status: &tonic::Status) -> bool {
    status.metadata().contains_key("grpc-retry-pushback-ms")
        || status.metadata().contains_key("retry-after")
}

fn provider_forbids_retry(status: &tonic::Status) -> bool {
    status
        .metadata()
        .get("grpc-retry-pushback-ms")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().starts_with('-'))
}

fn metadata_duration(status: &tonic::Status, key: &str, milliseconds: bool) -> Option<Duration> {
    let value = status.metadata().get(key)?.to_str().ok()?.trim();
    if let Ok(amount) = value.parse::<u64>() {
        return Some(if milliseconds {
            Duration::from_millis(amount)
        } else {
            Duration::from_secs(amount)
        });
    }
    if milliseconds {
        return None;
    }
    let retry_at = httpdate::parse_http_date(value).ok()?;
    Some(
        retry_at
            .duration_since(SystemTime::now())
            .unwrap_or(Duration::ZERO),
    )
}

#[async_trait]
impl SuiApi for SuiClient {
    async fn batch_get_objects(&self, ids: &[String]) -> Result<Vec<Option<ObjectInfo>>, SuiErr> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let requests = ids
            .iter()
            .map(|id| {
                let mut request = GetObjectRequest::default();
                request.object_id = Some(id.clone());
                request
            })
            .collect::<Vec<_>>();
        let response = self
            .call(|mut client| {
                let mut request = BatchGetObjectsRequest::default();
                request.requests = requests.clone();
                request.read_mask = Some(FieldMask::from_paths([
                    "object_id",
                    "version",
                    "digest",
                    "owner",
                    "json",
                ]));
                async move {
                    client
                        .ledger_client()
                        .batch_get_objects(request)
                        .await
                        .map(|r| r.into_inner())
                }
            })
            .await?;
        if response.objects.len() != ids.len() {
            return Err(SuiErr::Transport(
                "BatchGetObjects result count did not match request".into(),
            ));
        }
        response
            .objects
            .into_iter()
            .map(|result| match result.result {
                Some(get_object_result::Result::Object(object)) => {
                    Self::object_info(object).map(Some)
                }
                Some(get_object_result::Result::Error(error))
                    if error.code == tonic::Code::NotFound as i32 =>
                {
                    Ok(None)
                }
                Some(get_object_result::Result::Error(error)) => {
                    Err(SuiErr::Rejected(error.message))
                }
                Some(_) => Err(SuiErr::Transport(
                    "BatchGetObjects returned an unsupported result variant".into(),
                )),
                None => Err(SuiErr::Transport(
                    "BatchGetObjects returned an empty result".into(),
                )),
            })
            .collect()
    }

    async fn current_epoch(&self) -> Result<SuiEpoch, SuiErr> {
        if let Some(cached) = self
            .epoch
            .read()
            .await
            .as_ref()
            .filter(|c| c.fetched_at.elapsed() < Duration::from_secs(30))
        {
            return Ok(cached.value);
        }
        let epoch = self
            .call(|mut client| async move {
                client
                    .ledger_client()
                    .get_epoch(GetEpochRequest::latest())
                    .await
                    .map(|r| {
                        r.into_inner()
                            .epoch
                            .and_then(|e| e.epoch)
                            .unwrap_or_default()
                    })
            })
            .await?;
        let epoch = SuiEpoch(epoch);
        *self.epoch.write().await = Some(Timed {
            value: epoch,
            fetched_at: Instant::now(),
        });
        Ok(epoch)
    }

    /// Walrus epoch — the clock `Blob.storage.end_epoch` is measured in.
    ///
    /// Read from the Walrus system *state* object (the versioned inner object hung
    /// off the system object as a dynamic field), whose Move struct carries
    /// `committee.epoch`. This is deliberately NOT `current_epoch()`: the Sui
    /// ledger epoch and the Walrus epoch are independent clocks that diverge by
    /// hundreds on a long-running network (testnet: Sui 1159 vs Walrus 457), so
    /// comparing `end_epoch` against the Sui epoch marks every live blob expired.
    async fn walrus_epoch(&self) -> Result<WalrusEpoch, SuiErr> {
        if let Some(cached) = self
            .walrus_epoch
            .read()
            .await
            .as_ref()
            .filter(|c| c.fetched_at.elapsed() < Duration::from_secs(30))
        {
            return Ok(cached.value);
        }
        // Resolve the state object from chain — never from configuration. It is a DYNAMIC
        // FIELD of the system object, so its object id changes whenever Walrus bumps the
        // system version. Pinning that id in config would rot exactly like a pinned
        // package id does, and rot silently: a stale-but-still-readable snapshot object
        // returns a FROZEN epoch, which quietly stops expiring genuinely-dead blobs.
        let parent = self
            .walrus_system
            .clone()
            .ok_or_else(|| SuiErr::Rejected("Walrus system object ID is not configured".into()))?;
        // Page through every field: `ListDynamicFields` gives no ordering guarantee, so a
        // positional pick (first/last) is a coin flip the moment a version bump leaves the
        // old field in place — and picking the OLD one returns a frozen epoch, which
        // silently stops expiring genuinely-dead blobs.
        let mut fields = Vec::new();
        let mut page_token: Option<Vec<u8>> = None;
        loop {
            let parent = parent.clone();
            let token = page_token.clone();
            let response = self
                .call(move |mut client| {
                    let parent = parent.clone();
                    let token = token.clone();
                    async move {
                        let mut request = ListDynamicFieldsRequest::default();
                        request.parent = Some(parent);
                        request.page_size = Some(50);
                        request.page_token = token.map(Into::into);
                        // `name` carries the BCS-encoded key — the system version — and is
                        // what makes the selection deterministic. Without it we would be
                        // guessing.
                        request.read_mask = Some(FieldMask::from_paths(["field_id", "name"]));
                        client
                            .state_client()
                            .list_dynamic_fields(request)
                            .await
                            .map(|r| r.into_inner())
                    }
                })
                .await?;
            fields.extend(response.dynamic_fields);
            match response.next_page_token {
                Some(token) if !token.is_empty() => page_token = Some(token.to_vec()),
                _ => break,
            }
        }
        // Walrus keys the state field by the system `version` (a Move u64), so select the
        // HIGHEST version — the newest state — rather than trusting page order.
        let state_id = fields
            .iter()
            .filter_map(|field| {
                let id = field.field_id.clone()?;
                let name = field.name.as_ref()?;
                let version: u64 = bcs::from_bytes(name.value.as_ref()?).ok()?;
                Some((version, id))
            })
            .max_by_key(|(version, _)| *version)
            .map(|(_, id)| id)
            .ok_or_else(|| {
                SuiErr::Transport(
                    "Walrus system object exposes no versioned state dynamic field".into(),
                )
            })?;
        let json = self
            .call(|mut client| {
                let id = state_id.clone();
                async move {
                    let mut request = GetObjectRequest::default();
                    request.object_id = Some(id);
                    request.read_mask = Some(FieldMask::from_paths(["json"]));
                    client
                        .ledger_client()
                        .get_object(request)
                        .await
                        .map(|r| r.into_inner().object.and_then(|o| o.json))
                }
            })
            .await?
            .ok_or_else(|| SuiErr::Rejected("Walrus system state object not found".into()))?;
        let value = prost_json(&json);
        let epoch = walrus_committee_epoch(&value).ok_or_else(|| {
            tracing::warn!(
                state_object = %state_id,
                json = %serde_json::to_string(&value).unwrap_or_default().chars().take(400).collect::<String>(),
                "walrus system state: committee.epoch not found"
            );
            SuiErr::Transport("Walrus system state JSON omitted committee.epoch".into())
        })?;
        let epoch = WalrusEpoch(epoch);
        *self.walrus_epoch.write().await = Some(Timed {
            value: epoch,
            fetched_at: Instant::now(),
        });
        Ok(epoch)
    }

    /// Walrus epoch schedule — `epoch_duration_ms`/`first_epoch_start_ms`, used to convert a
    /// Walrus epoch into a wall-clock timestamp via [`expires_at_from_epoch`].
    ///
    /// Mirrors `walrus_epoch()`'s structure exactly, but reads a DIFFERENT on-chain object:
    /// the Walrus staking pool's own versioned state (hung off the staking pool object as a
    /// dynamic field), not the system object. See `walrus_epoch()`'s doc comment for why the
    /// state id must be resolved from chain (never pinned in config) and why the HIGHEST
    /// dynamic-field version must be selected rather than trusting page order.
    async fn walrus_epoch_schedule(&self) -> Result<WalrusEpochSchedule, SuiErr> {
        if let Some(cached) = self
            .walrus_epoch_schedule
            .read()
            .await
            .as_ref()
            .filter(|c| c.fetched_at.elapsed() < Duration::from_secs(30))
        {
            return Ok(cached.value);
        }
        let parent = self.walrus_staking_pool.clone().ok_or_else(|| {
            SuiErr::Rejected("Walrus staking pool object ID is not configured".into())
        })?;
        let mut fields = Vec::new();
        let mut page_token: Option<Vec<u8>> = None;
        loop {
            let parent = parent.clone();
            let token = page_token.clone();
            let response = self
                .call(move |mut client| {
                    let parent = parent.clone();
                    let token = token.clone();
                    async move {
                        let mut request = ListDynamicFieldsRequest::default();
                        request.parent = Some(parent);
                        request.page_size = Some(50);
                        request.page_token = token.map(Into::into);
                        // `name` carries the BCS-encoded key — the staking pool version — and
                        // is what makes the selection deterministic. Without it we would be
                        // guessing.
                        request.read_mask = Some(FieldMask::from_paths(["field_id", "name"]));
                        client
                            .state_client()
                            .list_dynamic_fields(request)
                            .await
                            .map(|r| r.into_inner())
                    }
                })
                .await?;
            fields.extend(response.dynamic_fields);
            match response.next_page_token {
                Some(token) if !token.is_empty() => page_token = Some(token.to_vec()),
                _ => break,
            }
        }
        // Walrus keys the state field by the pool `version` (a Move u64), so select the
        // HIGHEST version — the newest state — rather than trusting page order.
        let state_id = fields
            .iter()
            .filter_map(|field| {
                let id = field.field_id.clone()?;
                let name = field.name.as_ref()?;
                let version: u64 = bcs::from_bytes(name.value.as_ref()?).ok()?;
                Some((version, id))
            })
            .max_by_key(|(version, _)| *version)
            .map(|(_, id)| id)
            .ok_or_else(|| {
                SuiErr::Transport(
                    "Walrus staking pool object exposes no versioned state dynamic field".into(),
                )
            })?;
        let json = self
            .call(|mut client| {
                let id = state_id.clone();
                async move {
                    let mut request = GetObjectRequest::default();
                    request.object_id = Some(id);
                    request.read_mask = Some(FieldMask::from_paths(["json"]));
                    client
                        .ledger_client()
                        .get_object(request)
                        .await
                        .map(|r| r.into_inner().object.and_then(|o| o.json))
                }
            })
            .await?
            .ok_or_else(|| SuiErr::Rejected("Walrus staking pool state object not found".into()))?;
        let value = prost_json(&json);
        let schedule = parse_epoch_schedule(&value).ok_or_else(|| {
            tracing::warn!(
                state_object = %state_id,
                json = %serde_json::to_string(&value).unwrap_or_default().chars().take(400).collect::<String>(),
                "walrus staking pool state: epoch_duration/first_epoch_start not found"
            );
            SuiErr::Transport(
                "Walrus staking pool state JSON omitted epoch_duration/first_epoch_start".into(),
            )
        })?;
        *self.walrus_epoch_schedule.write().await = Some(Timed {
            value: schedule,
            fetched_at: Instant::now(),
        });
        Ok(schedule)
    }

    async fn reference_gas_price(&self) -> Result<u64, SuiErr> {
        let epoch = self.current_epoch().await?;
        if let Some(cached) = self
            .gas_price
            .read()
            .await
            .as_ref()
            .filter(|c| c.value.0 == epoch)
        {
            return Ok(cached.value.1);
        }
        let price = self
            .call(|mut client| async move { client.get_reference_gas_price().await })
            .await?;
        *self.gas_price.write().await = Some(Timed {
            value: (epoch, price),
            fetched_at: Instant::now(),
        });
        Ok(price)
    }

    async fn execute_tx(
        &self,
        tx_bytes: &[u8],
        signatures: Vec<Vec<u8>>,
    ) -> Result<ExecResult, SuiErr> {
        let tx: Transaction = bcs::from_bytes(tx_bytes)
            .map_err(|error| SuiErr::Rejected(format!("invalid transaction BCS: {error}")))?;
        let signatures = signatures
            .into_iter()
            .map(|bytes| {
                UserSignature::from_bytes(&bytes)
                    .map(Into::into)
                    .map_err(|error| SuiErr::Rejected(format!("invalid user signature: {error}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut request = ExecuteTransactionRequest::default();
        request.transaction = Some(tx.into());
        request.signatures = signatures;
        request.read_mask = Some(FieldMask::from_paths(["digest", "effects"]));
        let response = self
            .call(|mut client| {
                let request = request.clone();
                async move {
                    client
                        .execution_client()
                        .execute_transaction(request)
                        .await
                        .map(|r| r.into_inner())
                }
            })
            .await?;
        Self::exec_result(
            response
                .transaction
                .ok_or_else(|| SuiErr::Transport("execute response omitted transaction".into()))?,
        )
    }

    async fn get_tx_status(&self, digest: &str) -> Result<Option<ExecResult>, SuiErr> {
        let parsed: Digest = digest
            .parse()
            .map_err(|error| SuiErr::Rejected(format!("invalid transaction digest: {error}")))?;
        let request = GetTransactionRequest::new(&parsed)
            .with_read_mask(FieldMask::from_paths(["digest", "effects"]));
        let response = self
            .call(|mut client| {
                let request = request.clone();
                async move {
                    client
                        .ledger_client()
                        .get_transaction(request)
                        .await
                        .map(|r| r.into_inner())
                }
            })
            .await;
        match response {
            Ok(response) => response.transaction.map(Self::exec_result).transpose(),
            // The node does not have this transaction: it has not landed (yet). This is the
            // ordinary answer while a submission is still in flight, not a failure — callers
            // distinguish "absent" from "errored" to decide whether a batch may be retried.
            Err(SuiErr::NotFound(_)) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn list_owned_blobs(
        &self,
        owner: &str,
        page_cursor: Option<String>,
    ) -> Result<(Vec<OwnedBlob>, Option<String>), SuiErr> {
        let package = self
            .walrus_package
            .as_ref()
            .ok_or_else(|| SuiErr::Rejected("Walrus package ID is not configured".into()))?;
        let page_token = page_cursor
            .map(|token| {
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(token)
                    .map(Into::into)
                    .map_err(|_| SuiErr::Rejected("invalid owned-object page cursor".into()))
            })
            .transpose()?;
        let mut request = ListOwnedObjectsRequest::default();
        request.owner = Some(owner.to_owned());
        request.page_size = Some(1000);
        request.page_token = page_token;
        request.read_mask = Some(FieldMask::from_paths([
            "object_id",
            "version",
            "digest",
            "owner",
            "json",
        ]));
        request.object_type = Some(format!("{package}::blob::Blob"));
        let response = self
            .call(|mut client| {
                let request = request.clone();
                async move {
                    client
                        .state_client()
                        .list_owned_objects(request)
                        .await
                        .map(|r| r.into_inner())
                }
            })
            .await?;
        let blobs = response
            .objects
            .into_iter()
            .map(Self::object_info)
            .map(|result| {
                let object = result?;
                Ok(OwnedBlob {
                    object_id: object.object_id,
                    blob_id: object.blob_id.ok_or_else(|| {
                        SuiErr::Transport("Walrus Blob JSON omitted blob_id".into())
                    })?,
                    end_epoch: object.end_epoch.ok_or_else(|| {
                        SuiErr::Transport("Walrus Blob JSON omitted end_epoch".into())
                    })?,
                })
            })
            .collect::<Result<Vec<_>, SuiErr>>()?;
        let next = response
            .next_page_token
            .map(|bytes| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes));
        Ok((blobs, next))
    }

    async fn chain_id(&self) -> Result<[u8; 32], SuiErr> {
        if let Some(chain) = *self.chain.read().await {
            return Ok(chain);
        }
        let chain_text = self
            .call(|mut client| async move {
                client
                    .ledger_client()
                    .get_service_info(GetServiceInfoRequest::default())
                    .await
                    .map(|r| r.into_inner().chain_id.unwrap_or_default())
            })
            .await?;
        let digest: Digest = chain_text
            .parse()
            .map_err(|error| SuiErr::Transport(format!("invalid chain id: {error}")))?;
        let chain = digest.into_inner();
        *self.chain.write().await = Some(chain);
        Ok(chain)
    }

    async fn address_balance(&self, address: &str) -> Result<u64, SuiErr> {
        let address = address.to_owned();
        self.call(|mut client| {
            let mut request = GetBalanceRequest::default();
            request.owner = Some(address.clone());
            request.coin_type = Some("0x2::sui::SUI".into());
            async move {
                client.state_client().get_balance(request).await.map(|r| {
                    r.into_inner()
                        .balance
                        .and_then(|b| b.address_balance)
                        .unwrap_or_default()
                })
            }
        })
        .await
    }

    async fn walrus_system_object(&self) -> Result<SharedObjectInfo, SuiErr> {
        let id = self
            .walrus_system
            .clone()
            .ok_or_else(|| SuiErr::Rejected("Walrus system object ID is not configured".into()))?;
        let object = self
            .batch_get_objects(std::slice::from_ref(&id))
            .await?
            .into_iter()
            .next()
            .flatten()
            .ok_or_else(|| SuiErr::Rejected("Walrus system object was not found".into()))?;
        let version = self
            .call(|mut client| {
                let id = id.clone();
                async move {
                    let mut request = GetObjectRequest::default();
                    request.object_id = Some(id);
                    request.read_mask = Some(FieldMask::from_paths(["owner"]));
                    client.ledger_client().get_object(request).await.map(|r| {
                        r.into_inner()
                            .object
                            .and_then(|o| o.owner)
                            .and_then(|o| o.version)
                            .unwrap_or_default()
                    })
                }
            })
            .await?;
        Ok(SharedObjectInfo {
            object_id: object.object_id,
            initial_shared_version: version,
            mutable: true,
            // Carried through from the same read — no extra RPC.
            package_id: object.package_id,
        })
    }
}

fn prost_json(value: &prost_types::Value) -> serde_json::Value {
    use prost_types::value::Kind;
    match value.kind.as_ref() {
        Some(Kind::NullValue(_)) | None => serde_json::Value::Null,
        // `google.protobuf.Value.NumberValue` is always f64, but every Move
        // integer field this "json" blob can carry (u8/u16/u32/u64 — u128/u256
        // arrive pre-stringified, e.g. Blob.blob_id) is a whole number. Emitting
        // it as-is round-trips through serde_json as e.g. `6.0`, and `"6.0"`
        // fails `str::parse::<u64>()` in `find_json_u64` below. Prefer the
        // integer form whenever the value is exactly whole AND representable
        // without loss as an f64 (|n| <= 2^53) — `*n as i64` SATURATES for
        // whole f64 magnitudes at or beyond 2^63, which would silently turn
        // e.g. a bogus/overflowed field into a valid-looking `i64::MAX`
        // rather than failing loudly. No real u8..u64 Move field reaches
        // 2^53, so this never rejects a legitimate value; anything larger
        // falls through to the float formatting below, where a downstream
        // `str::parse::<u64>()` fails loudly instead of trusting a
        // fabricated number.
        Some(Kind::NumberValue(n))
            if n.fract() == 0.0 && n.is_finite() && *n >= 0.0 && *n <= 9007199254740992.0 =>
        {
            serde_json::json!(*n as i64)
        }
        Some(Kind::NumberValue(n)) => serde_json::json!(n),
        Some(Kind::StringValue(s)) => serde_json::Value::String(s.clone()),
        Some(Kind::BoolValue(b)) => serde_json::Value::Bool(*b),
        Some(Kind::StructValue(s)) => serde_json::Value::Object(
            s.fields
                .iter()
                .map(|(k, v)| (k.clone(), prost_json(v)))
                .collect(),
        ),
        Some(Kind::ListValue(l)) => {
            serde_json::Value::Array(l.values.iter().map(prost_json).collect())
        }
    }
}

/// Walrus blob ids are canonically the URL-safe unpadded base64 of the
/// 32-byte id — that is what `vector_entries` (and therefore the tracking
/// table) stores and what every HTTP surface speaks. The on-chain
/// `Blob.blob_id` is a Move u256, which the gRPC JSON rendering
/// pre-stringifies as its DECIMAL value (the id bytes read little-endian),
/// so without conversion no chain-scanned blob id ever matches a tracked
/// row and the resolver marks every real row `not_owner`. Convert at this
/// boundary so every `SuiApi` consumer compares like with like. A value
/// that isn't a plain decimal u256 is returned unchanged (defensive;
/// nothing on-chain produces one today).
fn canonical_blob_id(raw: &str) -> String {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return raw.to_owned();
    }
    // Base-10 to base-256, little-endian (u256 = LE interpretation of the id).
    let mut bytes = [0u8; 32];
    for digit in raw.bytes() {
        let mut carry = u32::from(digit - b'0');
        for byte in bytes.iter_mut() {
            let value = u32::from(*byte) * 10 + carry;
            *byte = (value & 0xff) as u8;
            carry = value >> 8;
        }
        if carry != 0 {
            // Overflows 256 bits — not a u256 blob id after all.
            return raw.to_owned();
        }
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn find_json_scalar(value: &serde_json::Value, key: &str) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => map
            .get(key)
            .and_then(|v| match v {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Number(n) => Some(n.to_string()),
                _ => find_json_scalar(v, key),
            })
            .or_else(|| map.values().find_map(|v| find_json_scalar(v, key))),
        serde_json::Value::Array(values) => values.iter().find_map(|v| find_json_scalar(v, key)),
        _ => None,
    }
}

fn find_json_u64(value: &serde_json::Value, key: &str) -> Option<u64> {
    find_json_scalar(value, key).and_then(|value| value.parse().ok())
}

/// The current Walrus epoch, read at the EXACT path `committee.epoch`.
///
/// Deliberately not a recursive key search: the system state also carries a
/// `future_accounting` ring buffer whose entries each hold their own, FUTURE, `epoch`
/// (e.g. 469..476 while the current epoch is 457). A recursive search returns one of
/// those — a silently-wrong, larger epoch that would terminally expire live blobs, which
/// is worse than the bug this function exists to fix. Every step is an exact key lookup.
///
/// A dynamic field may be returned either bare or wrapped in a Move `Field { name, value }`,
/// so the `value` wrapper is unwrapped if present.
fn walrus_committee_epoch(value: &serde_json::Value) -> Option<u64> {
    let root = value.get("value").unwrap_or(value);
    let epoch = root.get("committee")?.get("epoch")?;
    match epoch {
        serde_json::Value::Number(number) => number.as_u64(),
        serde_json::Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

/// Parse epoch_duration/first_epoch_start from the Walrus staking pool's
/// state object JSON. Mirrors walrus_committee_epoch()'s exact-path,
/// unwrap-the-Field-wrapper approach — see that function's doc comment
/// for why this must not be a recursive/fuzzy key search.
fn parse_epoch_schedule(value: &serde_json::Value) -> Option<WalrusEpochSchedule> {
    let root = value.get("value").unwrap_or(value);
    let parse_u64_field = |key: &str| -> Option<u64> {
        match root.get(key)? {
            serde_json::Value::Number(n) => n.as_u64(),
            serde_json::Value::String(s) => s.parse().ok(),
            _ => None,
        }
    };
    Some(WalrusEpochSchedule {
        epoch_duration_ms: parse_u64_field("epoch_duration")?,
        first_epoch_start_ms: parse_u64_field("first_epoch_start")?,
    })
}

/// Convert a Walrus epoch to its wall-clock expiry timestamp.
pub fn expires_at_from_epoch(
    end_epoch: WalrusEpoch,
    schedule: &WalrusEpochSchedule,
) -> chrono::DateTime<chrono::Utc> {
    let expires_at_ms = schedule.first_epoch_start_ms as i64
        + (end_epoch.0 as i64) * schedule.epoch_duration_ms as i64;
    chrono::DateTime::from_timestamp_millis(expires_at_ms).unwrap_or_else(chrono::Utc::now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn rate_gate_rejects_zero_limits() {
        assert!(RateGate::new(0, Duration::from_secs(10)).is_err());
        assert!(RateGate::new(3_000, Duration::ZERO).is_err());
        assert!(RateGate::new(MAX_REQUESTS_PER_WINDOW + 1, Duration::from_secs(10)).is_err());
        assert!(RateGate::new(3_000, MAX_REQUEST_WINDOW + Duration::from_secs(1)).is_err());
    }

    #[tokio::test]
    async fn rpc_limits_reject_unsafe_values() {
        let client = || SuiClient::new("http://127.0.0.1:1", 10, Duration::from_secs(1)).unwrap();
        assert!(client().with_rpc_limits(Duration::ZERO, 64).is_err());
        assert!(client()
            .with_rpc_limits(MAX_RPC_ATTEMPT_TIMEOUT + Duration::from_millis(1), 64)
            .is_err());
        assert!(client()
            .with_rpc_limits(DEFAULT_RPC_ATTEMPT_TIMEOUT, 1)
            .is_err());
        assert!(client()
            .with_rpc_limits(DEFAULT_RPC_ATTEMPT_TIMEOUT, MAX_RPC_MAX_IN_FLIGHT + 1)
            .is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn rate_gate_enforces_the_rolling_window_after_a_burst() {
        let gate = RateGate::new(2, Duration::from_millis(50)).unwrap();
        let _ = gate.acquire(RequestPriority::Interactive).await;
        let _ = gate.acquire(RequestPriority::Interactive).await;
        let waiting_gate = gate.clone();
        let waiter =
            tokio::spawn(async move { waiting_gate.acquire(RequestPriority::Interactive).await });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());

        tokio::time::advance(Duration::from_millis(49)).await;
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        tokio::time::advance(Duration::from_millis(1)).await;
        let _ = waiter.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn provider_quota_allows_exactly_three_thousand_per_ten_seconds() {
        let gate = RateGate::new(3_000, Duration::from_secs(10)).unwrap();
        for _ in 0..3_000 {
            let _ = gate.acquire(RequestPriority::Interactive).await;
        }
        let waiting_gate = gate.clone();
        let waiter =
            tokio::spawn(async move { waiting_gate.acquire(RequestPriority::Interactive).await });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());

        tokio::time::advance(Duration::from_millis(9_999)).await;
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        tokio::time::advance(Duration::from_millis(1)).await;
        let _ = waiter.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn cloned_rate_gates_share_admissions() {
        let gate = RateGate::new(1, Duration::from_millis(50)).unwrap();
        let clone = gate.clone();
        let _ = gate.acquire(RequestPriority::Interactive).await;
        let waiter = tokio::spawn(async move { clone.acquire(RequestPriority::Interactive).await });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        tokio::time::advance(Duration::from_millis(50)).await;
        let _ = waiter.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn background_traffic_reserves_window_capacity_for_interactive_calls() {
        let gate = RateGate::new(10, Duration::from_secs(1)).unwrap();
        for _ in 0..9 {
            let _ = gate.acquire(RequestPriority::Background).await;
        }
        let background_gate = gate.clone();
        let background_waiter =
            tokio::spawn(async move { background_gate.acquire(RequestPriority::Background).await });
        tokio::task::yield_now().await;
        assert!(!background_waiter.is_finished());

        let _ = gate.acquire(RequestPriority::Interactive).await;
        assert!(!background_waiter.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        let _ = background_waiter.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn cooldown_blocks_available_capacity_and_extends() {
        let gate = RateGate::new(10, Duration::from_secs(1)).unwrap();
        gate.cool_down_for(Duration::from_millis(30)).await;
        tokio::time::advance(Duration::from_millis(10)).await;
        gate.cool_down_for(Duration::from_millis(30)).await;
        let waiting_gate = gate.clone();
        let waiter =
            tokio::spawn(async move { waiting_gate.acquire(RequestPriority::Interactive).await });
        tokio::task::yield_now().await;

        tokio::time::advance(Duration::from_millis(29)).await;
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        tokio::time::advance(Duration::from_millis(1)).await;
        let _ = waiter.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_acquires_never_oversubscribe_the_window() {
        let gate = RateGate::new(3, Duration::from_secs(1)).unwrap();
        let mut waiters = Vec::new();
        for _ in 0..4 {
            let gate = gate.clone();
            waiters.push(tokio::spawn(async move {
                gate.acquire(RequestPriority::Interactive).await
            }));
        }
        tokio::task::yield_now().await;
        assert_eq!(
            waiters.iter().filter(|waiter| waiter.is_finished()).count(),
            3
        );

        tokio::time::advance(Duration::from_secs(1)).await;
        for waiter in waiters {
            let _ = waiter.await.unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_waiter_does_not_consume_a_future_admission() {
        let gate = RateGate::new(1, Duration::from_secs(1)).unwrap();
        let _ = gate.acquire(RequestPriority::Interactive).await;
        let waiting_gate = gate.clone();
        let waiter =
            tokio::spawn(async move { waiting_gate.acquire(RequestPriority::Interactive).await });
        tokio::task::yield_now().await;
        waiter.abort();

        tokio::time::advance(Duration::from_secs(1)).await;
        let _ = gate.acquire(RequestPriority::Interactive).await;
    }

    #[test]
    fn provider_retry_delay_prefers_grpc_pushback() {
        let mut status = tonic::Status::resource_exhausted("quota");
        status.metadata_mut().insert(
            "grpc-retry-pushback-ms",
            tonic::metadata::MetadataValue::from_static("1500"),
        );
        status.metadata_mut().insert(
            "retry-after",
            tonic::metadata::MetadataValue::from_static("60"),
        );
        assert_eq!(provider_retry_delay(&status), Duration::from_millis(1_500));
    }

    #[test]
    fn provider_retry_delay_supports_seconds_and_http_dates() {
        let mut seconds = tonic::Status::resource_exhausted("quota");
        seconds.metadata_mut().insert(
            "retry-after",
            tonic::metadata::MetadataValue::from_static("7"),
        );
        assert_eq!(provider_retry_delay(&seconds), Duration::from_secs(7));

        let retry_at = httpdate::fmt_http_date(SystemTime::now() + Duration::from_secs(60));
        let mut date = tonic::Status::resource_exhausted("quota");
        date.metadata_mut().insert(
            "retry-after",
            tonic::metadata::MetadataValue::try_from(retry_at.as_str()).unwrap(),
        );
        let delay = provider_retry_delay(&date);
        assert!(delay >= Duration::from_secs(58));
        assert!(delay <= Duration::from_secs(60));
    }

    #[test]
    fn provider_retry_delay_falls_back_and_bounds_extreme_values() {
        let malformed = tonic::Status::resource_exhausted("quota");
        assert_eq!(
            provider_retry_delay(&malformed),
            DEFAULT_RATE_LIMIT_COOLDOWN
        );

        let mut extreme = tonic::Status::resource_exhausted("quota");
        extreme.metadata_mut().insert(
            "retry-after",
            tonic::metadata::MetadataValue::from_static("999999"),
        );
        assert_eq!(provider_retry_delay(&extreme), MAX_RATE_LIMIT_COOLDOWN);
    }

    #[test]
    fn negative_grpc_pushback_forbids_retry() {
        let mut status = tonic::Status::resource_exhausted("quota");
        status.metadata_mut().insert(
            "grpc-retry-pushback-ms",
            tonic::metadata::MetadataValue::from_static("-1"),
        );
        assert!(provider_forbids_retry(&status));
        assert_eq!(provider_retry_delay(&status), DEFAULT_RATE_LIMIT_COOLDOWN);
    }

    #[tokio::test]
    async fn with_retry_retries_then_succeeds() {
        let calls = AtomicU32::new(0);
        let value = with_retry(
            RetryBudget {
                attempts: 3,
                base_delay_ms: 1,
            },
            || async {
                if calls.fetch_add(1, Ordering::SeqCst) < 2 {
                    Err(SuiErr::Transport("temporary".into()))
                } else {
                    Ok(7)
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(value, 7);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn rejected_errors_do_not_retry() {
        let calls = AtomicU32::new(0);
        let result: Result<(), _> = with_retry(
            RetryBudget {
                attempts: 3,
                base_delay_ms: 1,
            },
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(SuiErr::Rejected("bad transaction".into()))
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn classifies_observed_sponsor_address_balance_rejection() {
        let error = SuiClient::classify_rejection(tonic::Status::invalid_argument(
            "Error checking transaction input objects: Invalid withdraw reservation: \
             Available amount in account for object id 0xffebc1 is less than requested: 0 < 10000000000",
        ));
        assert!(matches!(error, SuiErr::SponsorFundsUnavailable(_)));
    }

    #[test]
    fn leaves_other_invalid_argument_rejections_generic() {
        let error = SuiClient::classify_rejection(tonic::Status::invalid_argument(
            "Invalid withdraw reservation for an unrelated reason",
        ));
        assert!(matches!(error, SuiErr::Rejected(_)));
    }

    /// "Absent from the chain" is read from the gRPC status CODE, whatever the node's wording.
    #[test]
    fn classifies_not_found_from_the_status_code_not_the_message() {
        let error = SuiClient::classify_rejection(tonic::Status::not_found(
            "transaction 9xQeWv is unknown to this node",
        ));
        assert!(
            matches!(error, SuiErr::NotFound(_)),
            "a NOT_FOUND status must classify as NotFound whatever the message says",
        );
    }

    /// Pins WHY the code is the only sound source. A `tonic::Status` renders its code as a
    /// human description, so `NOT_FOUND` stringifies to "...not found..." even when the node's
    /// own message never says it. Matching that text appears to work — but it is reading a
    /// third-party `Display` impl, and it equally matches any OTHER status whose message happens
    /// to mention a missing object (see the test below). The coupling is asserted here so that
    /// if tonic ever rewords this, it fails loudly instead of silently changing what we treat
    /// as an absent transaction.
    #[test]
    fn status_display_leaks_the_code_description_which_is_why_text_matching_is_unsound() {
        let rendered =
            tonic::Status::not_found("no mention of the phrase in this message").to_string();
        assert!(
            rendered.contains("not found"),
            "tonic renders the NOT_FOUND code as prose; text-matching keyed off that accident",
        );
    }

    /// The mirror image: a node that merely MENTIONS "not found" in some other failure must not
    /// be mistaken for an absent transaction — that would report a real error as "not on chain",
    /// and the reconciler would go on to re-execute a batch that may already have committed.
    #[test]
    fn does_not_treat_a_message_mentioning_not_found_as_absent() {
        let error = SuiClient::classify_rejection(tonic::Status::internal(
            "internal error: object not found while loading state",
        ));
        assert!(
            matches!(error, SuiErr::Rejected(_)),
            "only the NOT_FOUND code means absent; the message text does not",
        );
    }

    /// The Walrus system state carries MANY keys named `epoch`: `committee.epoch` is the
    /// current one, while the `future_accounting` ring buffer holds a row per FUTURE epoch.
    /// A recursive key search returns one of the future values — a silently-wrong, LARGER
    /// epoch, which terminally expires live blobs. That is strictly worse than the bug this
    /// parser exists to fix, because the value looks plausible.
    ///
    /// Real shape observed on testnet 2026-07-13: committee.epoch = 457, while
    /// future_accounting held 469..476.
    #[test]
    fn walrus_epoch_reads_committee_not_future_accounting() {
        let state = serde_json::json!({
            "committee": { "epoch": "457", "members": [] },
            "future_accounting": { "ring_buffer": [
                { "epoch": "469", "used_capacity": "0" },
                { "epoch": "470", "used_capacity": "0" },
            ]},
        });
        assert_eq!(
            walrus_committee_epoch(&state),
            Some(457),
            "must read committee.epoch; a recursive search returns a future_accounting epoch"
        );
        // The recursive helper is order-dependent, and therefore unsafe here: with no
        // top-level `committee` to find first it descends into `future_accounting` and
        // returns a FUTURE epoch. `walrus_committee_epoch` is immune because it addresses
        // the exact path instead of searching.
        let future_first = serde_json::json!({
            "future_accounting": { "ring_buffer": [{ "epoch": "469" }] },
        });
        assert_eq!(
            find_json_u64(&future_first, "epoch"),
            Some(469),
            "documents the trap: a recursive search happily returns a future epoch"
        );
        assert_eq!(
            walrus_committee_epoch(&future_first),
            None,
            "the exact-path read refuses rather than returning a future epoch"
        );

        // A dynamic field may arrive wrapped in a Move `Field { name, value }`.
        let wrapped = serde_json::json!({ "name": "3", "value": state });
        assert_eq!(walrus_committee_epoch(&wrapped), Some(457));

        // Real gRPC renders Move integers as f64 (`457.0`), not strings.
        let numeric = serde_json::json!({ "committee": { "epoch": 457 } });
        assert_eq!(walrus_committee_epoch(&numeric), Some(457));

        // Absent committee must fail LOUDLY (None -> SuiErr), never default to 0: epoch 0
        // would make `end_epoch <= 0 + margin` false for every blob, silently disabling
        // expiry forever.
        assert_eq!(walrus_committee_epoch(&serde_json::json!({"foo": 1})), None);
        assert_eq!(
            walrus_committee_epoch(&serde_json::json!({"committee": {"members": []}})),
            None
        );
    }

    #[test]
    fn extracts_nested_walrus_json_fields() {
        let value =
            serde_json::json!({"fields":{"blob_id":"abc","storage":{"fields":{"end_epoch":"42"}}}});
        assert_eq!(find_json_scalar(&value, "blob_id").as_deref(), Some("abc"));
        assert_eq!(find_json_u64(&value, "end_epoch"), Some(42));
    }

    /// Real pair captured from a live devstack blob: the on-chain gRPC JSON's
    /// decimal u256 must convert to the exact base64url id `vector_entries`
    /// stores, or the resolver/prepare matching never succeeds.
    #[test]
    fn canonical_blob_id_converts_decimal_u256_to_base64url() {
        assert_eq!(
            canonical_blob_id(
                "71180928686078069463321821488956377929528921675534717096403130587581791296721"
            ),
            "0VwrVHM_VXTQsjAzue8-jjIPslHqwpgz_lbA8Fj6Xp0"
        );
        // Zero is a valid u256 → the all-zero 32-byte id.
        assert_eq!(
            canonical_blob_id("0"),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        );
        // Non-decimal (already-canonical) and overflowing values pass through.
        assert_eq!(
            canonical_blob_id("0VwrVHM_VXTQsjAzue8-jjIPslHqwpgz_lbA8Fj6Xp0"),
            "0VwrVHM_VXTQsjAzue8-jjIPslHqwpgz_lbA8Fj6Xp0"
        );
        let overflow = "1".repeat(80);
        assert_eq!(canonical_blob_id(&overflow), overflow);
    }

    /// Regression test for a real bug found via the live gRPC integration test
    /// (`tests/sui_client_live.rs`): `extracts_nested_walrus_json_fields` above
    /// hand-builds its fixture with `end_epoch` as a JSON *string*, which never
    /// exercises `prost_json`. The real gRPC `Object.json` field carries Move
    /// integers as `google.protobuf.Value::NumberValue` (always `f64`) — e.g.
    /// devstack returned `end_epoch: 6.0`. Naively re-stringifying an f64 with
    /// `serde_json::Number::to_string` yields `"6.0"`, which `str::parse::<u64>`
    /// rejects, so `find_json_u64` silently returned `None` and `list_owned_blobs`
    /// errored with "Walrus Blob JSON omitted end_epoch" for every real blob.
    #[test]
    fn prost_json_normalizes_whole_number_values_for_u64_parsing() {
        use prost_types::value::Kind;
        use std::collections::BTreeMap;

        let mut storage_fields = BTreeMap::new();
        storage_fields.insert(
            "end_epoch".to_string(),
            prost_types::Value {
                kind: Some(Kind::NumberValue(6.0)),
            },
        );
        let mut fields = BTreeMap::new();
        fields.insert(
            "blob_id".to_string(),
            prost_types::Value {
                kind: Some(Kind::StringValue("abc".into())),
            },
        );
        fields.insert(
            "storage".to_string(),
            prost_types::Value {
                kind: Some(Kind::StructValue(prost_types::Struct {
                    fields: storage_fields.into_iter().collect(),
                })),
            },
        );
        let root = prost_types::Value {
            kind: Some(Kind::StructValue(prost_types::Struct {
                fields: fields.into_iter().collect(),
            })),
        };

        let json = prost_json(&root);
        assert_eq!(find_json_scalar(&json, "blob_id").as_deref(), Some("abc"));
        assert_eq!(find_json_u64(&json, "end_epoch"), Some(6));
    }

    /// Regression for the saturating-cast variant of the same bug: a whole
    /// f64 at or beyond 2^63 cast with `as i64` SATURATES to `i64::MAX`
    /// instead of overflowing/panicking, which would fabricate a
    /// valid-looking u64 out of a bogus or corrupted field. Such a value
    /// must fall through to float formatting so `find_json_u64` fails
    /// loudly (`None`) rather than returning a made-up number.
    #[test]
    fn prost_json_rejects_imprecise_whole_numbers_as_fast_path_ints() {
        use prost_types::value::Kind;

        let huge = prost_types::Value {
            kind: Some(Kind::NumberValue(9_223_372_036_854_775_808.0)), // 2^63
        };
        let json = prost_json(&huge);
        assert!(json.as_f64().is_some(), "must fall through to float form");
        assert!(json.as_i64().is_none());

        let mut fields = std::collections::BTreeMap::new();
        fields.insert(
            "end_epoch".to_string(),
            prost_types::Value {
                kind: Some(Kind::NumberValue(9_223_372_036_854_775_808.0)),
            },
        );
        let root = prost_types::Value {
            kind: Some(Kind::StructValue(prost_types::Struct {
                fields: fields.into_iter().collect(),
            })),
        };
        let json = prost_json(&root);
        assert_eq!(find_json_u64(&json, "end_epoch"), None);
    }

    #[test]
    fn expires_at_from_epoch_computes_wall_clock_time() {
        let schedule = WalrusEpochSchedule {
            epoch_duration_ms: 86_400_000, // 1 day
            first_epoch_start_ms: 1_700_000_000_000,
        };
        let end_epoch = WalrusEpoch(10);
        let expires_at = expires_at_from_epoch(end_epoch, &schedule);
        let expected_ms = 1_700_000_000_000_i64 + 10 * 86_400_000_i64;
        assert_eq!(expires_at.timestamp_millis(), expected_ms);
    }

    #[test]
    fn parse_epoch_schedule_extracts_duration_and_start() {
        // Shape per @mysten/walrus SDK's BCS-decoded StakingInnerV1 type
        // (dist/client.d.mts): epoch_duration/first_epoch_start are
        // top-level string (u64-as-string) fields, sibling to `epoch`.
        // This exact raw-JSON shape (whether wrapped in a `value` field
        // like the system-state object is) is NOT independently verified
        // against a live fetch — if a real run shows a different shape,
        // fix parse_epoch_schedule, not this test's expectation of what
        // the fix should produce.
        let raw = serde_json::json!({
            "n_shards": 1000,
            "epoch_duration": "86400000",
            "first_epoch_start": "1700000000000",
            "epoch": 457,
        });
        let schedule = parse_epoch_schedule(&raw).expect("fields present");
        assert_eq!(schedule.epoch_duration_ms, 86_400_000);
        assert_eq!(schedule.first_epoch_start_ms, 1_700_000_000_000);
    }
}
