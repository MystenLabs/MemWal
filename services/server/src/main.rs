mod auth;
mod compatibility;
mod engine;
mod jobs;
mod mcp_proxy;
mod observability;
mod rate_limit;
mod routes;
mod services;
mod slack;
mod storage;
mod types;

use axum::http::{header, HeaderValue, Method};
use axum::{
    extract::DefaultBodyLimit,
    middleware,
    routing::{get, post},
    Router,
};
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};

use apalis::prelude::*;
use apalis_sql::postgres::PostgresStorage;

use engine::{MemoryEngine, PlaintextEngine, WalrusSealEngine};
use jobs::{
    execute_bulk_remember, execute_wallet_job, BulkRememberJob, MetaTransferJob, RememberJob,
    WalletJobStorage,
};
use services::{CompositeRanker, Embedder, Extractor, LlmExtractor, OpenAiEmbedder, Ranker};
use storage::db::VectorDb;
use types::{
    AppState, Config, KeyPool, DEFAULT_BLOB_CACHE_MAX_BYTES, DEFAULT_BLOB_CACHE_TTL_SECS,
    DEFAULT_EMBEDDING_CACHE_TTL_SECS,
};

const STALE_REMEMBER_JOB_AFTER: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const APALIS_MONITOR_RESTART_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

#[tokio::main]
async fn main() {
    // Load .env file (optional, won't error if missing)
    dotenvy::dotenv().ok();

    observability::init_tracing();

    // Load config
    let config = Config::from_env();
    tracing::info!("starting memwal server on port {}", config.port);
    tracing::info!("  Sui RPC: {}", config.sui_rpc_url);
    tracing::info!("  package id: {}", config.package_id);
    tracing::info!("  registry id: {}", config.registry_id);
    tracing::info!(
        "  memwal account: {}",
        config
            .memwal_account_id
            .as_deref()
            .unwrap_or("(from client header)")
    );
    tracing::info!(
        "  rate limit: burst={}/min, sustained={}/hr, per-key={}/min, quota={}MB/user",
        config.rate_limit.max_requests_per_minute,
        config.rate_limit.max_requests_per_hour,
        config.rate_limit.max_requests_per_delegate_key,
        config.rate_limit.max_storage_bytes / 1_048_576
    );
    tracing::info!(
        "  sponsor rate limit: {}/min, {}/hr per IP+sender",
        config.sponsor_rate_limit.per_minute,
        config.sponsor_rate_limit.per_hour,
    );
    if config.rate_limit.bench_bypass_enabled {
        // Storage quota is unaffected — this only skips the request-rate
        // buckets. The warning is split across lines so each one is grep-able
        // and renders clearly in stacked log output.
        tracing::warn!("⚠️  RATE_LIMIT_DISABLED=1 — request-rate limiter BYPASSED.");
        tracing::warn!("⚠️  Benchmark-only escape hatch. UNSAFE outside localhost benches.");
        tracing::warn!("⚠️  Unset RATE_LIMIT_DISABLED to restore protection.");
    }

    // ENG-1784: build the Slack alerter EARLY (right after config) so the
    // sidecar heartbeat + the per-dependency health probes can all clone
    // the same handle. Only enabled when SLACK_WEBHOOK_URL is set; None
    // disables every alert path without disturbing any other code path.
    // The server commit + env label are baked in so each alert's footer
    // identifies which deployment fired it.
    let slack: Option<Arc<crate::slack::SlackClient>> =
        config.slack_webhook_url.as_ref().map(|url| {
            let commit = std::env::var("GIT_SHA")
                .or_else(|_| std::env::var("GITHUB_SHA"))
                .or_else(|_| std::env::var("RAILWAY_GIT_COMMIT_SHA"))
                .ok()
                .map(|v| v.chars().take(7).collect::<String>());
            tracing::info!(
                "  Slack alerter: enabled (env={}, commit={})",
                config.env_label,
                commit.as_deref().unwrap_or("-"),
            );
            Arc::new(crate::slack::SlackClient::new(
                url.clone(),
                config.env_label.clone(),
                commit,
            ))
        });
    if slack.is_none() {
        tracing::info!("  Slack alerter: disabled (set SLACK_WEBHOOK_URL to enable)");
    }

    // Start TS sidecar HTTP server (SEAL + Walrus operations)
    let sidecar_url = config.sidecar_url.clone();
    tracing::info!("  sidecar: starting at {}", sidecar_url);
    // Use SIDECAR_SCRIPTS_DIR if set (Docker), otherwise derive from CARGO_MANIFEST_DIR (local dev)
    let scripts_dir = std::env::var("SIDECAR_SCRIPTS_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts"));
    let mcp_relayer_url = std::env::var("MEMWAL_RELAYER_URL")
        .unwrap_or_else(|_| format!("http://127.0.0.1:{}", config.port));
    let mut sidecar_child = tokio::process::Command::new("npx")
        .args(["tsx", "sidecar-server.ts"])
        .current_dir(&scripts_dir)
        .env("MEMWAL_RELAYER_URL", mcp_relayer_url)
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .expect("Failed to start TS sidecar. Is Node.js installed?");

    // Wait for sidecar to be ready (health check with retry)
    // LOW-9: Set 30s timeout on HTTP client to prevent hanging LLM/Walrus requests
    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("Failed to build HTTP client");
    let health_url = format!("{}/health", sidecar_url);
    let mut ready = false;
    for attempt in 1..=30 {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        match http_client.get(&health_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                tracing::info!("  sidecar: ready (attempt {})", attempt);
                ready = true;
                break;
            }
            _ => {
                if attempt % 5 == 0 {
                    tracing::debug!("  sidecar: waiting... (attempt {})", attempt);
                }
            }
        }
    }
    if !ready {
        sidecar_child.kill().await.ok();
        panic!("TS sidecar failed to start after 15s. Check scripts/sidecar-server.ts");
    }

    // Keep a cheap heartbeat in the Rust logs so operators can distinguish
    // Enoki/Walrus failures from the sidecar process becoming unavailable.
    //
    // ENG-1784: also fire `InfraFailureKind::SidecarDown` to Slack when
    // consecutive failures cross the configured threshold (default 3 ≈
    // 90s sustained outage). The Slack client itself dedups per variant
    // for 5 minutes so a real outage produces ~1 page per window, not
    // one per failed probe.
    let sidecar_watch_client = http_client.clone();
    let sidecar_watch_url = health_url.clone();
    let sidecar_fail_threshold = config.health_check_fail_threshold;
    let sidecar_interval_secs = config.health_check_interval_secs;
    let slack_handle = slack.clone();
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(sidecar_interval_secs));
        let mut consecutive_failures = 0u32;
        loop {
            interval.tick().await;
            match sidecar_watch_client
                .get(&sidecar_watch_url)
                .timeout(std::time::Duration::from_secs(2))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    if consecutive_failures > 0 {
                        tracing::info!(
                            "  sidecar: health recovered after {} failed check(s)",
                            consecutive_failures
                        );
                    }
                    consecutive_failures = 0;
                }
                Ok(resp) => {
                    consecutive_failures += 1;
                    tracing::error!(
                        "  sidecar: health check failed status={} consecutive_failures={}",
                        resp.status(),
                        consecutive_failures
                    );
                    if consecutive_failures == sidecar_fail_threshold {
                        crate::jobs::spawn_slack_infra_alert(
                            slack_handle.as_ref(),
                            crate::slack::InfraFailureKind::SidecarDown {
                                consecutive_failures,
                            },
                        );
                    }
                }
                Err(e) => {
                    consecutive_failures += 1;
                    tracing::error!(
                        "  sidecar: health check error consecutive_failures={} error={}",
                        consecutive_failures,
                        e
                    );
                    if consecutive_failures == sidecar_fail_threshold {
                        crate::jobs::spawn_slack_infra_alert(
                            slack_handle.as_ref(),
                            crate::slack::InfraFailureKind::SidecarDown {
                                consecutive_failures,
                            },
                        );
                    }
                }
            }
        }
    });

    // Initialize database (PostgreSQL + pgvector).
    // `Arc` so the MemoryEngine impl shares the same pool as the handlers.
    let db = Arc::new(
        VectorDb::new(&config.database_url)
            .await
            .expect("Failed to connect to PostgreSQL"),
    );

    // Setup Apalis job queue — auto-creates `apalis_jobs` table if not present
    // Uses the same DATABASE_URL as the main DB; no extra infrastructure needed.
    let apalis_pool = sqlx::PgPool::connect(&config.database_url)
        .await
        .expect("Failed to connect to PostgreSQL for Apalis");
    // setup() is defined only on PostgresStorage<()> — creates schema tables.
    PostgresStorage::<()>::setup(&apalis_pool)
        .await
        .expect("Apalis postgres migration failed");
    let job_storage: PostgresStorage<MetaTransferJob> = PostgresStorage::new(apalis_pool.clone());
    let remember_job_storage: PostgresStorage<RememberJob> =
        PostgresStorage::new(apalis_pool.clone());
    // ENG-1408: BulkRememberJob storage
    let bulk_job_storage: PostgresStorage<BulkRememberJob> =
        PostgresStorage::new(apalis_pool.clone());

    // Single Apalis queue for all WalletJob signing operations. Workers select
    // a key from the configured pool when they execute an upload job, so
    // retries can rotate away from a wallet whose sponsored tx expired.
    const WALLET_QUEUE_NAME: &str = "wallet_jobs";
    let wallet_storage: WalletJobStorage = PostgresStorage::new_with_config(
        apalis_pool.clone(),
        apalis_sql::Config::new(WALLET_QUEUE_NAME),
    );
    tracing::info!(
        "  Apalis: job queue ready (table=apalis_jobs, queue={})",
        WALLET_QUEUE_NAME
    );

    reqwest::Url::parse(&config.walrus_publisher_url)
        .expect("Failed to initialize Walrus publisher (invalid URL?)");
    for aggregator_url in &config.walrus_aggregator_urls {
        reqwest::Url::parse(aggregator_url)
            .expect("Failed to initialize Walrus aggregator (invalid URL?)");
    }
    tracing::info!("  Walrus publisher: {}", config.walrus_publisher_url);
    tracing::info!("  Walrus aggregator: {}", config.walrus_aggregator_url);
    if config.walrus_aggregator_urls.len() > 1 {
        tracing::info!(
            "  Walrus aggregator race: {} candidates, race_after={}ms",
            config.walrus_aggregator_urls.len(),
            config.walrus_aggregator_race_after_ms
        );
    }
    if config.walrus_skip_consistency_check {
        tracing::warn!(
            "  Walrus reads: WALRUS_SKIP_CONSISTENCY_CHECK=true for trusted Walrus Memory cold reads"
        );
    }
    // Log upload key status
    let pool_size = config.sui_private_keys.len();
    if pool_size > 0 {
        tracing::info!(
            "  Walrus upload: {} key(s) configured; using round-robin wallet jobs",
            pool_size,
        );
    } else {
        tracing::warn!("  Walrus upload: no Sui private keys configured, uploads will fail");
        // ENG-1784: page on-call once at boot — without a key pool every
        // remember job will fail, but the per-job classifier currently
        // returns the same Permanent error per request and dedup
        // collapses them. Surfacing it explicitly at startup is cheaper
        // than waiting for the first user complaint.
        crate::jobs::spawn_slack_infra_alert(
            slack.as_ref(),
            crate::slack::InfraFailureKind::NoSuiKeysConfigured,
        );
    }

    // Build wallet key holder.
    // `Arc` so the MemoryEngine impl's store_blob draws from the same pool.
    // clone so handlers + the engine share one holder.
    let key_pool = Arc::new(KeyPool::new(config.sui_private_keys.clone()));

    // Initialize Redis for rate limiting
    let redis = rate_limit::create_redis_client(&config.rate_limit.redis_url)
        .await
        .expect("Failed to connect to Redis for rate limiting");
    tracing::info!("  Redis: connected at {}", config.rate_limit.redis_url);

    // ENG-1405: Redis Walrus blob ciphertext cache skips Walrus fetch on warm recall.
    let blob_cache_ttl_secs = std::env::var("BLOB_CACHE_TTL_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_BLOB_CACHE_TTL_SECS);
    let blob_cache_max_bytes = std::env::var("BLOB_CACHE_MAX_BYTES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(DEFAULT_BLOB_CACHE_MAX_BYTES);
    let embedding_cache_ttl_secs = std::env::var("EMBEDDING_CACHE_TTL_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_EMBEDDING_CACHE_TTL_SECS);
    tracing::info!(
        "  blob cache: redis ttl={}s max={} bytes (BLOB_CACHE_TTL_SECS={}, BLOB_CACHE_MAX_BYTES={}); embedding cache: redis ttl={}s (EMBEDDING_CACHE_TTL_SECS={})",
        blob_cache_ttl_secs,
        blob_cache_max_bytes,
        blob_cache_ttl_secs,
        blob_cache_max_bytes,
        embedding_cache_ttl_secs,
        embedding_cache_ttl_secs
    );
    let blob_cache_ttl = std::time::Duration::from_secs(blob_cache_ttl_secs);
    let embedding_cache_ttl = std::time::Duration::from_secs(embedding_cache_ttl_secs);

    if blob_cache_ttl.is_zero() {
        tracing::warn!(
            "  blob cache: BLOB_CACHE_TTL_SECS=0 disables cache hits and forces Walrus revalidation"
        );
    }
    if blob_cache_max_bytes == 0 {
        tracing::warn!("  blob cache: BLOB_CACHE_MAX_BYTES=0 disables blob cache reads and writes");
    }
    if embedding_cache_ttl.is_zero() {
        tracing::warn!(
            "  embedding cache: EMBEDDING_CACHE_TTL_SECS=0 disables recall query embedding cache hits"
        );
    }

    // Wrap the immutable config so the MemoryEngine + handlers share it.
    let config = Arc::new(config);

    // Select the persistence engine. Production = WalrusSealEngine (SEAL
    // encrypt happens in the handler/client; the engine uploads the
    // ciphertext to Walrus and indexes the row, with the Redis blob
    // cache + reactive cleanup on the read path). Benchmark =
    // PlaintextEngine (plaintext straight to Postgres, no SEAL/Walrus).
    // BENCHMARK_MODE is off by default and IS NOT FOR PRODUCTION USE.
    let engine: Arc<dyn MemoryEngine> = if config.benchmark_mode {
        tracing::warn!("⚠️  BENCHMARK_MODE=true — using PlaintextEngine.");
        tracing::warn!("⚠️  Memories will be stored UNENCRYPTED in Postgres.");
        tracing::warn!("⚠️  This is a benchmark-only mode. UNSAFE for production.");
        Arc::new(PlaintextEngine::new(Arc::clone(&db)))
    } else {
        tracing::info!("  storage: WalrusSealEngine (production)");
        Arc::new(WalrusSealEngine::new(
            Arc::clone(&db),
            http_client.clone(),
            Arc::clone(&key_pool),
            Arc::clone(&config),
            redis.clone(),
            blob_cache_ttl,
            blob_cache_max_bytes,
        ))
    };

    // Service-layer capabilities — shared (Arc<dyn …>) so alternative
    // implementations can be swapped at startup. Both wrap the same
    // http_client + config; behaviour is identical to the inline
    // generate_embedding / extract_facts_llm they replace.
    let embedder: Arc<dyn Embedder> = Arc::new(OpenAiEmbedder::new(
        http_client.clone(),
        Arc::clone(&config),
    ));
    let extractor: Arc<dyn Extractor> =
        Arc::new(LlmExtractor::new(http_client.clone(), Arc::clone(&config)));
    // CompositeRanker is stateless — one shared instance is fine.
    let ranker: Arc<dyn Ranker> = Arc::new(CompositeRanker);

    // Shared application state. http_client + slack are cloned (rather
    // than moved) so the ENG-1784 health probes spawned below can hold
    // their own handles; Arc + reqwest::Client are both cheap to clone.
    let state = Arc::new(AppState {
        db: db.clone(),
        config: Arc::clone(&config),
        http_client: http_client.clone(),
        key_pool,
        engine,
        embedder,
        extractor,
        ranker,
        redis: redis.clone(),
        fallback_rate_limit: tokio::sync::Mutex::new(crate::rate_limit::InMemoryFallback::default()),
        remember_job_storage: remember_job_storage.clone(),
        wallet_storage: wallet_storage.clone(),
        bulk_job_storage: bulk_job_storage.clone(),
        blob_cache_ttl,
        blob_cache_max_bytes,
        embedding_cache_ttl,
        slack: slack.clone(),
    });

    // Worker 1: MetaTransferJob (legacy — backward compat with existing DB rows)
    {
        let worker_state = state.clone();
        let storage = job_storage.clone();
        tokio::spawn(async move {
            loop {
                let worker = WorkerBuilder::new("meta-transfer")
                    .data(worker_state.clone())
                    .backend(storage.clone())
                    .build_fn(jobs::execute_meta_transfer);

                #[allow(deprecated)]
                if let Err(e) = Monitor::new().register_with_count(2, worker).run().await {
                    tracing::error!("Apalis monitor exited: {}", e);
                }
                tokio::time::sleep(APALIS_MONITOR_RESTART_DELAY).await;
            }
        });
        tracing::info!("  Apalis: worker 'meta-transfer' spawned (concurrency=2)");
    }

    // Worker 2: RememberJob (legacy full pipeline)
    {
        let worker_state = state.clone();
        let storage = remember_job_storage.clone();
        tokio::spawn(async move {
            loop {
                let worker = WorkerBuilder::new("remember")
                    .data(worker_state.clone())
                    .backend(storage.clone())
                    .build_fn(jobs::execute_remember);

                #[allow(deprecated)]
                if let Err(e) = Monitor::new().register_with_count(3, worker).run().await {
                    tracing::error!("Apalis remember monitor exited: {}", e);
                }
                tokio::time::sleep(APALIS_MONITOR_RESTART_DELAY).await;
            }
        });
        tracing::info!("  Apalis: worker 'remember' spawned (concurrency=3)");
    }

    // Worker 3: BulkRememberJob (ENG-1408)
    {
        let worker_state = state.clone();
        let storage = bulk_job_storage.clone();
        tokio::spawn(async move {
            loop {
                let worker = WorkerBuilder::new("bulk-remember")
                    .data(worker_state.clone())
                    .backend(storage.clone())
                    .build_fn(execute_bulk_remember);

                #[allow(deprecated)]
                if let Err(e) = Monitor::new().register_with_count(2, worker).run().await {
                    tracing::error!("Apalis bulk-remember monitor exited: {}", e);
                }
                tokio::time::sleep(APALIS_MONITOR_RESTART_DELAY).await;
            }
        });
        tracing::info!("  Apalis: worker 'bulk-remember' spawned (concurrency=2)");
    }

    // Worker 4: WalletJob — single worker, single queue.
    //
    // Concurrency = WALLET_JOB_CONCURRENCY (default 8). Multiple jobs can be
    // dispatched simultaneously against the same wallet; transient Sui/RPC
    // conflicts are classified by `WalletJobError` and retried by Apalis.
    let wallet_concurrency: usize = std::env::var("WALLET_JOB_CONCURRENCY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8);
    {
        let worker_state = state.clone();
        let storage = wallet_storage.clone();
        tokio::spawn(async move {
            loop {
                let worker = WorkerBuilder::new("wallet_jobs")
                    .data(worker_state.clone())
                    .backend(storage.clone())
                    .build_fn(execute_wallet_job);

                #[allow(deprecated)]
                if let Err(e) = Monitor::new()
                    .register_with_count(wallet_concurrency, worker)
                    .run()
                    .await
                {
                    tracing::error!("Apalis wallet worker exited: {}", e);
                }
                tokio::time::sleep(APALIS_MONITOR_RESTART_DELAY).await;
            }
        });
        tracing::info!(
            "  Apalis: worker 'wallet_jobs' spawned (concurrency={})",
            wallet_concurrency
        );
    }

    // Spawn background task for cache eviction
    let evict_state = state.clone();
    tokio::spawn(async move {
        // Run every hour
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            interval.tick().await;
            if let Err(e) = evict_state.db.evict_expired_delegate_keys().await {
                tracing::error!("Background eviction failed: {}", e);
            }
        }
    });

    // Spawn background task for orphaned async remember jobs
    let stale_job_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            if let Err(e) = stale_job_state
                .db
                .fail_stale_remember_jobs(STALE_REMEMBER_JOB_AFTER)
                .await
            {
                tracing::error!("Stale remember job sweep failed: {}", e);
            }
        }
    });

    // ENG-1784: infra-health probes — three lightweight pollers that
    // detect when a hard dependency is down and the whole relayer can't
    // make progress. Each probe runs at `health_check_interval_secs`,
    // counts consecutive failures, and fires the matching
    // `InfraFailureKind` exactly when the count crosses
    // `health_check_fail_threshold`. Slack-side dedup collapses repeats
    // for `DEDUP_WINDOW` so the channel sees one page per real incident.
    // All probes are no-ops if `SLACK_WEBHOOK_URL` is unset — logs still
    // surface the state.

    // Probe 1: Postgres reachability + pool saturation
    {
        let probe_state = state.clone();
        let probe_slack = slack.clone();
        let interval_secs = config.health_check_interval_secs;
        let fail_threshold = config.health_check_fail_threshold;
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
            let mut consecutive_failures = 0u32;
            loop {
                interval.tick().await;
                // `SELECT 1` is the standard cheap reachability probe — if
                // it can't even acquire a connection or run the query, the
                // pool is wedged.
                let probe = sqlx::query_scalar::<_, i32>("SELECT 1")
                    .fetch_one(probe_state.db.pool())
                    .await;
                match probe {
                    Ok(_) => {
                        if consecutive_failures > 0 {
                            tracing::info!(
                                "  postgres probe: recovered after {} failed checks",
                                consecutive_failures
                            );
                        }
                        consecutive_failures = 0;
                    }
                    Err(e) => {
                        consecutive_failures += 1;
                        tracing::error!(
                            "  postgres probe: failed (consecutive={}): {}",
                            consecutive_failures,
                            e
                        );
                        if consecutive_failures == fail_threshold {
                            crate::jobs::spawn_slack_infra_alert(
                                probe_slack.as_ref(),
                                crate::slack::InfraFailureKind::PostgresDown {
                                    reason: e.to_string(),
                                },
                            );
                        }
                    }
                }
            }
        });
    }

    // Probe 2: Redis reachability via PING
    {
        let probe_slack = slack.clone();
        let mut probe_redis = state.redis.clone();
        let interval_secs = config.health_check_interval_secs;
        let fail_threshold = config.health_check_fail_threshold;
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
            let mut consecutive_failures = 0u32;
            loop {
                interval.tick().await;
                let ping: redis::RedisResult<String> = redis::cmd("PING")
                    .query_async(&mut probe_redis)
                    .await;
                match ping {
                    Ok(_) => {
                        if consecutive_failures > 0 {
                            tracing::info!(
                                "  redis probe: recovered after {} failed checks",
                                consecutive_failures
                            );
                        }
                        consecutive_failures = 0;
                    }
                    Err(e) => {
                        consecutive_failures += 1;
                        tracing::error!(
                            "  redis probe: PING failed (consecutive={}): {}",
                            consecutive_failures,
                            e
                        );
                        if consecutive_failures == fail_threshold {
                            crate::jobs::spawn_slack_infra_alert(
                                probe_slack.as_ref(),
                                crate::slack::InfraFailureKind::RedisDown {
                                    consecutive_failures,
                                },
                            );
                        }
                    }
                }
            }
        });
    }

    // Probe 4: Apalis backlog stuck-queue detection.
    //
    // Counts Pending jobs whose `run_at` is at least
    // `apalis_backlog_stuck_secs` in the past — i.e. jobs that were
    // ready to run more than ~5 min ago but no worker has claimed them.
    // Above `apalis_backlog_threshold` AND that condition sustained for
    // `health_check_fail_threshold` consecutive samples → queue is
    // wedged (workers dead, deadlocked, or under-provisioned).
    //
    // Schema reminder: apalis-sql writes to schema-qualified
    // `apalis.jobs` (NOT a flat `apalis_jobs`). Status values are
    // capitalized strings: 'Pending', 'Running', 'Done', 'Failed'.
    {
        let probe_state = state.clone();
        let probe_slack = slack.clone();
        let interval_secs = config.health_check_interval_secs;
        let fail_threshold = config.health_check_fail_threshold;
        let backlog_threshold = config.apalis_backlog_threshold;
        let stuck_secs = config.apalis_backlog_stuck_secs;
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
            let mut consecutive_over_threshold = 0u32;
            // Cast to i32 once — `make_interval(...)` only accepts i32.
            // 5-min default (300s) is comfortably within i32 range.
            let stuck_secs_i32: i32 = stuck_secs.try_into().unwrap_or(i32::MAX);
            loop {
                interval.tick().await;
                let probe = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*)::bigint FROM apalis.jobs \
                     WHERE status = 'Pending' \
                       AND done_at IS NULL \
                       AND run_at < now() - make_interval(secs => $1)",
                )
                .bind(stuck_secs_i32)
                .fetch_one(probe_state.db.pool())
                .await;
                match probe {
                    Ok(backlog) if backlog >= backlog_threshold => {
                        consecutive_over_threshold += 1;
                        tracing::warn!(
                            "  apalis probe: backlog={} threshold={} consecutive_over={}",
                            backlog,
                            backlog_threshold,
                            consecutive_over_threshold
                        );
                        if consecutive_over_threshold == fail_threshold {
                            crate::jobs::spawn_slack_infra_alert(
                                probe_slack.as_ref(),
                                crate::slack::InfraFailureKind::ApalisQueueStuck {
                                    backlog,
                                    stuck_for_secs: stuck_secs,
                                    consecutive_samples: consecutive_over_threshold,
                                },
                            );
                        }
                    }
                    Ok(_) => {
                        if consecutive_over_threshold > 0 {
                            tracing::info!(
                                "  apalis probe: backlog drained after {} over-threshold samples",
                                consecutive_over_threshold
                            );
                        }
                        consecutive_over_threshold = 0;
                    }
                    Err(e) => {
                        // Query failure is its own signal — but Postgres
                        // outages already page via the postgres probe,
                        // so we just log here to avoid double-alerting.
                        tracing::error!("  apalis probe: query failed: {}", e);
                    }
                }
            }
        });
    }

    // Probe 3: Sui RPC reachability via JSON-RPC. We send the cheapest
    // valid method (`sui_getLatestCheckpointSequenceNumber`, no params)
    // because a bare HEAD/GET will 405 against a JSON-RPC endpoint.
    {
        let probe_slack = slack.clone();
        let probe_client = http_client.clone();
        let probe_rpc_url = config.sui_rpc_url.clone();
        let interval_secs = config.health_check_interval_secs;
        let fail_threshold = config.health_check_fail_threshold;
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
            let mut consecutive_failures = 0u32;
            let body = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "sui_getLatestCheckpointSequenceNumber",
                "params": []
            });
            loop {
                interval.tick().await;
                let resp = probe_client
                    .post(&probe_rpc_url)
                    .json(&body)
                    .timeout(std::time::Duration::from_secs(5))
                    .send()
                    .await;
                let healthy = match resp {
                    Ok(r) if r.status().is_success() => true,
                    Ok(_) | Err(_) => false,
                };
                if healthy {
                    if consecutive_failures > 0 {
                        tracing::info!(
                            "  sui_rpc probe: recovered after {} failed checks",
                            consecutive_failures
                        );
                    }
                    consecutive_failures = 0;
                } else {
                    consecutive_failures += 1;
                    tracing::error!(
                        "  sui_rpc probe: failed (consecutive={})",
                        consecutive_failures,
                    );
                    if consecutive_failures == fail_threshold {
                        crate::jobs::spawn_slack_infra_alert(
                            probe_slack.as_ref(),
                            crate::slack::InfraFailureKind::SuiRpcDown {
                                consecutive_failures,
                            },
                        );
                    }
                }
            }
        });
    }

    // Build routes
    // Protected routes (require Ed25519 signature + onchain verification)
    // HIGH-13 / ENG-1407 / ENG-1408: 2 MiB covers the largest realistic JSON
    // body — single remember at 1 MiB plaintext + framing, and bulk remember
    // batches up to ~1.5 MB. Blocks abusive uploads before auth + rate-limit
    // middleware see them. Must equal auth::PROTECTED_BODY_LIMIT_BYTES — these
    // caps are enforced independently and a mismatch silently rejects valid
    // requests.
    let protected_routes = Router::new()
        .route("/api/remember", post(routes::remember))
        .route(
            "/api/remember/{job_id}",
            axum::routing::get(routes::remember_status),
        )
        .route(
            "/api/remember/bulk/status",
            post(routes::remember_bulk_status),
        )
        .route("/api/recall", post(routes::recall))
        .route("/api/remember/manual", post(routes::remember_manual))
        .route("/api/recall/manual", post(routes::recall_manual))
        // ENG-1408: Bulk remember — higher body limit (20 items × max 64 KiB each ≈ 1.5 MB)
        .route(
            "/api/remember/bulk",
            post(routes::remember_bulk).layer(DefaultBodyLimit::max(2 * 1024 * 1024)),
        )
        .route("/api/analyze", post(routes::analyze))
        .route("/api/ask", post(routes::ask))
        .route("/api/restore", post(routes::restore))
        // ENG-1747: admin/harness endpoints — namespace delete + stats.
        // Mode-blind; owner-scoped via AuthInfo.
        .route("/api/forget", post(routes::forget))
        .route("/api/stats", post(routes::stats))
        // Router::layer runs middleware bottom-to-top (last added runs first).
        // Keep auth outer so AuthInfo is in request extensions before rate limiting reads it.
        .layer(middleware::from_fn_with_state(
            state.clone(),
            rate_limit::rate_limit_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::verify_signature,
        ))
        .layer(DefaultBodyLimit::max(auth::PROTECTED_BODY_LIMIT_BYTES));

    // Sponsor routes — body limits + IP rate limit middleware
    let sponsor_routes = Router::new()
        .route(
            "/sponsor",
            post(routes::sponsor_proxy).layer(DefaultBodyLimit::max(10 * 1024)),
        )
        .route(
            "/sponsor/execute",
            post(routes::sponsor_execute_proxy).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            rate_limit::sponsor_rate_limit_middleware,
        ));

    // MCP proxy routes — reverse-proxy to the Node sidecar's `/mcp/*` routes.
    // No signed-request auth here: MCP clients ship a single Bearer at SSE
    // open and the sidecar parses it as the Ed25519 delegate key. Body limit
    // is generous on the POST route (JSON-RPC envelopes can carry analyze
    // text up to a few hundred KiB) and irrelevant on the GET SSE route.
    let mcp_routes = Router::new()
        .route("/api/mcp/sse", get(mcp_proxy::sse_proxy))
        .route(
            "/api/mcp/messages",
            post(mcp_proxy::messages_proxy).layer(DefaultBodyLimit::max(2 * 1024 * 1024)),
        )
        // Streamable HTTP transport (MCP 2025-06). Single URL that
        // handles GET (open SSE), POST (JSON-RPC with optional SSE
        // upgrade), and DELETE (close session). Lets users add the
        // server via `claude mcp add --transport http memwal <URL>`
        // without any package install.
        .route(
            "/api/mcp",
            get(mcp_proxy::streamable_proxy)
                .post(mcp_proxy::streamable_proxy)
                .delete(mcp_proxy::streamable_proxy)
                .options(mcp_proxy::streamable_proxy)
                .layer(DefaultBodyLimit::max(2 * 1024 * 1024)),
        );

    // Public routes
    // HIGH-13: /health and /config accept no body — cap at 16 KiB to reject
    // oversized unauthenticated requests before they reach any handler.
    // ENG-1697: /config exposes non-secret deployment parameters (packageId,
    // network, sui_rpc_url) so the SDK can build SEAL SessionKey without
    // the user adding packageId to MemWalConfig.
    let public_routes = Router::new()
        .route(
            "/health",
            get(routes::health).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/version",
            get(routes::version).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/config",
            get(routes::get_config).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/metrics",
            get(observability::metrics).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .merge(sponsor_routes)
        .merge(mcp_routes);

    // CORS — restrict to configured origins.
    // Safe default is deny-all (no Access-Control-Allow-Origin header returned),
    // which blocks browser cross-origin requests. Set ALLOWED_ORIGINS to allow
    // specific origins (e.g. "http://localhost:3000,https://memwal.ai").
    let cors = {
        let origins: Vec<HeaderValue> = config
            .allowed_origins
            .split(',')
            .filter_map(|s| {
                let s = s.trim();
                if s.is_empty() {
                    return None;
                }
                s.parse::<HeaderValue>().ok()
            })
            .collect();

        if origins.is_empty() {
            tracing::warn!("ALLOWED_ORIGINS not set — CORS is deny-all (browsers blocked). Set ALLOWED_ORIGINS for frontend access.");
            CorsLayer::new() // deny-all: no Allow-Origin header emitted
        } else {
            tracing::info!("  CORS origins: {}", config.allowed_origins);
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(origins))
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_headers([
                    header::CONTENT_TYPE,
                    header::AUTHORIZATION,
                    // SDK auth headers (required for Ed25519 signed requests)
                    "x-public-key".parse::<header::HeaderName>().unwrap(),
                    "x-signature".parse::<header::HeaderName>().unwrap(),
                    "x-timestamp".parse::<header::HeaderName>().unwrap(),
                    "x-nonce".parse::<header::HeaderName>().unwrap(),
                    "x-account-id".parse::<header::HeaderName>().unwrap(),
                    "x-delegate-key".parse::<header::HeaderName>().unwrap(),
                    "x-request-id".parse::<header::HeaderName>().unwrap(),
                    "x-correlation-id".parse::<header::HeaderName>().unwrap(),
                    // ENG-1697: SessionKey envelope replacing x-delegate-key
                    "x-seal-session".parse::<header::HeaderName>().unwrap(),
                    // MCP headers — caller's Walrus Memory account id + optional default namespace.
                    "x-memwal-account-id".parse::<header::HeaderName>().unwrap(),
                    "x-memwal-namespace".parse::<header::HeaderName>().unwrap(),
                ])
        }
    };

    let app = Router::new()
        .merge(protected_routes)
        .merge(public_routes)
        .with_state(state)
        .layer(cors)
        .layer(middleware::from_fn(
            observability::request_context_middleware,
        ));

    // Start server
    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind address");

    tracing::info!("memwal server listening on {}", addr);
    tracing::info!("  health: http://localhost:{}/health", config.port);
    tracing::info!("  metrics: http://localhost:{}/metrics", config.port);
    tracing::info!(
        "  api:    http://localhost:{}/api/{{remember,recall,analyze}}",
        config.port
    );

    // Graceful shutdown: kill sidecar when server stops
    let shutdown = async {
        tokio::signal::ctrl_c().await.ok();
        tracing::info!("shutting down...");
    };

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
    .expect("Server failed");

    // Cleanup sidecar after shutdown
    sidecar_child.kill().await.ok();
    tracing::info!("sidecar stopped");
}
