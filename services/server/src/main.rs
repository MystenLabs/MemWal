mod auth;
mod db;
mod rate_limit;
mod routes;
mod seal;
mod sui;
mod types;
mod walrus;

use axum::{extract::DefaultBodyLimit, middleware, routing::{get, post}, Router};
use std::net::SocketAddr;
use axum::http::{header, HeaderValue, Method};
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use db::VectorDb;
use types::{AppState, Config, KeyPool};

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
    tracing::info!("  memwal account: {}", config.memwal_account_id.as_deref().unwrap_or("(from client header)"));
    tracing::info!("  rate limit: burst={}/min, sustained={}/hr, per-key={}/min, quota={}MB/user",
        config.rate_limit.max_requests_per_minute,
        config.rate_limit.max_requests_per_hour,
        config.rate_limit.max_requests_per_delegate_key,
        config.rate_limit.max_storage_bytes / 1_048_576
    );
    tracing::info!("  sponsor rate limit: {}/min, {}/hr per IP+sender",
        config.sponsor_rate_limit.per_minute,
        config.sponsor_rate_limit.per_hour,
    );

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

    // Initialize Walrus client (SDK wraps Publisher + Aggregator HTTP APIs)
    let walrus_client = walrus_rs::WalrusClient::new(
        &config.walrus_aggregator_url,
        &config.walrus_publisher_url,
    )
    .expect("Failed to initialize Walrus client (invalid URL?)");
    tracing::info!("  Walrus publisher: {}", config.walrus_publisher_url);
    tracing::info!("  Walrus aggregator: {}", config.walrus_aggregator_url);
    // Log upload key pool status
    let pool_size = config.sui_private_keys.len();
    if pool_size > 0 {
        tracing::info!("  Walrus upload: {} key(s) in pool (parallel uploads up to {}x)", pool_size, pool_size);
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

    // Shared application state
    let state = Arc::new(AppState {
        db,
        config: config.clone(),
        http_client,
        walrus_client,
        key_pool,
        redis,
        fallback_rate_limit: tokio::sync::Mutex::new(crate::rate_limit::InMemoryFallback::default()),
    });

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

    // Build routes
    // Protected routes (require Ed25519 signature + onchain verification)
    // HIGH-13: 256 KiB covers the largest realistic JSON body (64 KiB plaintext
    // + base64 overhead + JSON framing) while blocking abusive uploads before
    // auth + rate-limit middleware even sees the request.
    let protected_routes = Router::new()
        .route("/api/remember", post(routes::remember))
        .route("/api/recall", post(routes::recall))
        .route("/api/remember/manual", post(routes::remember_manual))
        .route("/api/recall/manual", post(routes::recall_manual))

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
        .layer(DefaultBodyLimit::max(256 * 1024));

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
        .route("/health", get(routes::health).layer(DefaultBodyLimit::max(16 * 1024)))
        .route("/config", get(routes::get_config).layer(DefaultBodyLimit::max(16 * 1024)))
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
                if s.is_empty() { return None; }
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
    tracing::info!("  api:    http://localhost:{}/api/{{remember,recall,analyze}}", config.port);

    // Graceful shutdown: kill sidecar when server stops
    let shutdown = async {
        tokio::signal::ctrl_c().await.ok();
        tracing::info!("shutting down...");
    };

    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown)
        .await
        .expect("Server failed");

    // Cleanup sidecar after shutdown
    sidecar_child.kill().await.ok();
    tracing::info!("sidecar stopped");
}
