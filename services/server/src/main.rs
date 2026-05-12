mod auth;
mod db;
mod jobs;
mod rate_limit;
mod routes;
mod seal;
mod sui;
mod types;
mod walrus;

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
use tower_http::trace::TraceLayer;

use apalis::prelude::*;
use apalis_sql::postgres::PostgresStorage;

use db::VectorDb;
use jobs::{
    execute_bulk_remember, execute_wallet_job, BulkRememberJob, MetaTransferJob, RememberJob,
    WalletJobStorage,
};
use types::{
    AppState, Config, KeyPool, DEFAULT_BLOB_CACHE_TTL_SECS, DEFAULT_EMBEDDING_CACHE_TTL_SECS,
};

const STALE_REMEMBER_JOB_AFTER: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const APALIS_MONITOR_RESTART_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

#[tokio::main]
async fn main() {
    // Load .env file (optional, won't error if missing)
    dotenvy::dotenv().ok();

    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "memwal_server=info,tower_http=info".into()),
        )
        .init();

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

    // Start TS sidecar HTTP server (SEAL + Walrus operations)
    let sidecar_url = config.sidecar_url.clone();
    tracing::info!("  sidecar: starting at {}", sidecar_url);
    // Use SIDECAR_SCRIPTS_DIR if set (Docker), otherwise derive from CARGO_MANIFEST_DIR (local dev)
    let scripts_dir = std::env::var("SIDECAR_SCRIPTS_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts"));
    let mut sidecar_child = tokio::process::Command::new("npx")
        .args(["tsx", "sidecar-server.ts"])
        .current_dir(&scripts_dir)
        .stdout(std::process::Stdio::null())
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

    // Initialize database (PostgreSQL + pgvector)
    let db = VectorDb::new(&config.database_url)
        .await
        .expect("Failed to connect to PostgreSQL");

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

    // Single Apalis queue for all WalletJob signing operations.
    //
    // Was previously a Vec of per-wallet queues to avoid Sui coin-object
    // equivocation locks. Per Will Bradley (Mysten, 2026-05-12 Slack callout):
    // Sui no longer permanently locks coin objects on equivocation, so a single
    // wallet + concurrent workers + retry handling is sufficient. Multi-wallet
    // is only justified for raw throughput, which is not a bottleneck for
    // background Walrus uploads.
    const WALLET_QUEUE_NAME: &str = "wallet_jobs";
    let wallet_storage: WalletJobStorage = PostgresStorage::new_with_config(
        apalis_pool.clone(),
        apalis_sql::Config::new(WALLET_QUEUE_NAME),
    );
    let pool_size = config.sui_private_keys.len();
    if pool_size > 1 {
        tracing::warn!(
            "  SERVER_SUI_PRIVATE_KEYS has {} entries; only the first is used. \
             Multi-wallet routing was retired — see plans/simplify-walrus-wallet-queues/.",
            pool_size,
        );
    }
    tracing::info!("  Apalis: job queue ready (table=apalis_jobs, queue={})", WALLET_QUEUE_NAME);

    // Initialize Walrus client (SDK wraps Publisher + Aggregator HTTP APIs)
    let walrus_client =
        walrus_rs::WalrusClient::new(&config.walrus_aggregator_url, &config.walrus_publisher_url)
            .expect("Failed to initialize Walrus client (invalid URL?)");
    tracing::info!("  Walrus publisher: {}", config.walrus_publisher_url);
    tracing::info!("  Walrus aggregator: {}", config.walrus_aggregator_url);
    // Log upload key pool status
    let pool_size = config.sui_private_keys.len();
    if pool_size > 0 {
        tracing::info!(
            "  Walrus upload: {} key(s) in pool (parallel uploads up to {}x)",
            pool_size,
            pool_size
        );
    } else {
        tracing::warn!("  Walrus upload: no Sui private keys configured, uploads will fail");
    }

    // Build key pool for parallel Walrus uploads
    let key_pool = KeyPool::new(config.sui_private_keys.clone());

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
    let embedding_cache_ttl_secs = std::env::var("EMBEDDING_CACHE_TTL_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_EMBEDDING_CACHE_TTL_SECS);
    tracing::info!(
        "  blob cache: redis ttl={}s (BLOB_CACHE_TTL_SECS={}); embedding cache: redis ttl={}s (EMBEDDING_CACHE_TTL_SECS={})",
        blob_cache_ttl_secs,
        blob_cache_ttl_secs,
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
    if embedding_cache_ttl.is_zero() {
        tracing::warn!(
            "  embedding cache: EMBEDDING_CACHE_TTL_SECS=0 disables recall query embedding cache hits"
        );
    }

    // Shared application state
    let state = Arc::new(AppState {
        db,
        config: config.clone(),
        http_client,
        walrus_client,
        key_pool,
        redis,
        fallback_rate_limit: tokio::sync::Mutex::new(crate::rate_limit::InMemoryFallback::default()),
        remember_job_storage: remember_job_storage.clone(),
        wallet_storage: wallet_storage.clone(),
        bulk_job_storage: bulk_job_storage.clone(),
        blob_cache_ttl,
        embedding_cache_ttl,
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
    // dispatched simultaneously; the sidecar's per-signer mutex serializes
    // them at the signing boundary (see sidecar-server.ts → signerUploadQueues
    // for rationale: Enoki sponsor race + SDK gas-coin contention, NOT
    // equivocation locking — that one is solved). Apalis-level retry
    // (Transient vs Permanent classified in `WalletJobError`) handles
    // transient RPC / Sui errors.
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
            "/config",
            get(routes::get_config).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .merge(sponsor_routes);

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
                    // ENG-1697: SessionKey envelope replacing x-delegate-key
                    "x-seal-session".parse::<header::HeaderName>().unwrap(),
                ])
        }
    };

    let app = Router::new()
        .merge(protected_routes)
        .merge(public_routes)
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    // Start server
    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind address");

    tracing::info!("memwal server listening on {}", addr);
    tracing::info!("  health: http://localhost:{}/health", config.port);
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
