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

    // Initialize database
    let db = VectorDb::new(&config.db_path, config.vector_dimensions)
        .expect("Failed to initialize database");

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
        http_client: reqwest::Client::new(),
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

    axum::serve(listener, app)
        .await
        .expect("Server failed");
}
