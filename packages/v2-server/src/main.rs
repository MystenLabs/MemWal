mod auth;
mod db;
mod routes;
mod seal;
mod sui;
mod types;
mod walrus;

use axum::{middleware, routing::{get, post}, Router};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use db::VectorDb;
use types::{AppState, Config};

#[tokio::main]
async fn main() {
    // Load .env file (optional, won't error if missing)
    dotenvy::dotenv().ok();

    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "memwal_v2_server=debug,tower_http=debug".into()),
        )
        .init();

    // Load config
    let config = Config::from_env();
    tracing::info!("starting memwal v2 server on port {}", config.port);
    tracing::info!("  Sui RPC: {}", config.sui_rpc_url);
    tracing::info!("  package id: {}", config.package_id);
    tracing::info!("  registry id: {}", config.registry_id);
    tracing::info!("  memwal account: {}", config.memwal_account_id.as_deref().unwrap_or("(from client header)"));

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
    let http_client = reqwest::Client::new();
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
    if config.sui_private_key.is_some() {
        tracing::info!("  Walrus upload: relay mode (SERVER_SUI_PRIVATE_KEY configured)");
    } else {
        tracing::warn!("  Walrus upload: SERVER_SUI_PRIVATE_KEY not set, uploads will fail");
    }

    // Shared application state
    let state = Arc::new(AppState {
        db,
        config: config.clone(),
        http_client,
        walrus_client,
    });

    // Build routes
    // Protected routes (require Ed25519 signature + onchain verification)
    let protected_routes = Router::new()
        .route("/api/remember", post(routes::remember))
        .route("/api/recall", post(routes::recall))
        .route("/api/embed", post(routes::embed))
        .route("/api/analyze", post(routes::analyze))
        .route("/api/ask", post(routes::ask))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::verify_signature,
        ));

    // Public routes
    let public_routes = Router::new()
        .route("/health", get(routes::health));

    let app = Router::new()
        .merge(protected_routes)
        .merge(public_routes)
        .with_state(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    // Start server
    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind address");

    tracing::info!("memwal v2 server listening on {}", addr);
    tracing::info!("  health: http://localhost:{}/health", config.port);
    tracing::info!("  api:    http://localhost:{}/api/{{remember,recall,embed,analyze}}", config.port);

    // Graceful shutdown: kill sidecar when server stops
    let shutdown = async {
        tokio::signal::ctrl_c().await.ok();
        tracing::info!("shutting down...");
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
        .expect("Server failed");

    // Cleanup sidecar after shutdown
    sidecar_child.kill().await.ok();
    tracing::info!("sidecar stopped");
}
