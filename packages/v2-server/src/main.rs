mod auth;
mod crypto;
mod db;
mod routes;
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
    tracing::info!("Starting MemWal V2 Server on port {}", config.port);
    tracing::info!("  Sui RPC: {}", config.sui_rpc_url);
    tracing::info!("  MemWalAccount: {}", config.memwal_account_id.as_deref().unwrap_or("(from client header)"));

    // Initialize database
    let db = VectorDb::new(&config.db_path, config.vector_dimensions)
        .expect("Failed to initialize database");

    // Shared application state
    let state = Arc::new(AppState {
        db,
        config: config.clone(),
        http_client: reqwest::Client::new(),
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

    tracing::info!("🚀 MemWal V2 Server listening on {}", addr);
    tracing::info!("   Health: http://localhost:{}/health", config.port);
    tracing::info!("   API:    http://localhost:{}/api/{{remember,recall,embed,analyze}}", config.port);

    axum::serve(listener, app)
        .await
        .expect("Server failed");
}
