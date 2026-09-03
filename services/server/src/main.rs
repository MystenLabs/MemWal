mod alerts;
mod auth;
mod client_ip;
mod compatibility;
mod engine;
mod jobs;
mod jobs_security_delete;
mod mcp_proxy;
mod oauth;
mod observability;
mod owner_token_auth;
mod rate_limit;
mod routes;
mod security_delete_auth;
mod security_delete_error;
mod services;
mod storage;
mod sui;
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
use sqlx::postgres::PgPoolOptions;

use alerts::AlertManager;
use engine::{MemoryEngine, PlaintextEngine, WalrusSealEngine};
use jobs::{
    execute_bulk_remember, execute_wallet_job, BulkRememberJob, MetaTransferJob, RememberJob,
    WalletJobStorage,
};
use services::{CompositeRanker, Embedder, Extractor, LlmExtractor, OpenAiEmbedder, Ranker};
use storage::db::VectorDb;
use storage::legacy_db::LegacyDb;
use storage::postgres_url::direct_postgres_url;
use types::{
    AppState, Config, KeyPool, DEFAULT_BLOB_CACHE_MAX_BYTES, DEFAULT_BLOB_CACHE_TTL_SECS,
    DEFAULT_EMBEDDING_CACHE_TTL_SECS,
};

const STALE_REMEMBER_JOB_AFTER: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const APALIS_MONITOR_RESTART_DELAY: std::time::Duration = std::time::Duration::from_secs(2);
const DEFAULT_APALIS_STARTUP_TIMEOUT_SECS: u64 = 45;

fn security_delete_cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::any())
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
}

/// CORS layer for the main relayer routes, scoped to the configured origins.
/// `allow_headers` are the request headers a browser may send on a signed
/// request; `expose_headers` lists the response headers a cross-origin client
/// may read — Fetch hides everything else, so `x-auth-error` must be exposed
/// for the browser SDK to read the machine-readable auth-failure reason (e.g.
/// clock-drift vs. bad signature). Only that header is exposed.
fn relayer_cors(origins: Vec<HeaderValue>) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
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
            // SessionKey envelope replacing x-delegate-key
            "x-seal-session".parse::<header::HeaderName>().unwrap(),
            // MCP headers — caller's Walrus Memory account id + optional default namespace.
            "x-memwal-account-id".parse::<header::HeaderName>().unwrap(),
            "x-memwal-namespace".parse::<header::HeaderName>().unwrap(),
            // Admin dashboard auth (browser fetches from a different subdomain,
            // so this custom header must be preflight-allowed)
            "x-admin-api-key".parse::<header::HeaderName>().unwrap(),
        ])
        .expose_headers(["x-auth-error".parse::<header::HeaderName>().unwrap()])
}

#[cfg(test)]
mod cors_tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn security_delete_cors_is_public_and_route_scoped() {
        let restricted_cors =
            CorsLayer::new().allow_origin(AllowOrigin::list(["https://app.memwal.test"
                .parse()
                .unwrap()]));
        let app = Router::new()
            .route("/restricted", get(|| async {}))
            .layer(restricted_cors)
            .merge(
                Router::new()
                    .route("/security-delete", post(|| async {}))
                    .layer(security_delete_cors()),
            );

        let public_preflight = Request::builder()
            .method(Method::OPTIONS)
            .uri("/security-delete")
            .header(header::ORIGIN, "https://third-party.example")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
            .header(
                header::ACCESS_CONTROL_REQUEST_HEADERS,
                "authorization,content-type",
            )
            .body(Body::empty())
            .unwrap();
        let public_response = app.clone().oneshot(public_preflight).await.unwrap();

        assert_eq!(
            public_response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "*"
        );
        let allowed_methods = public_response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_METHODS)
            .unwrap()
            .to_str()
            .unwrap();
        for method in ["GET", "POST", "DELETE", "OPTIONS"] {
            assert!(allowed_methods.split(',').any(|allowed| allowed == method));
        }
        let allowed_headers = public_response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
            .unwrap()
            .to_str()
            .unwrap();
        for name in ["authorization", "content-type"] {
            assert!(allowed_headers
                .split(',')
                .any(|allowed| allowed.eq_ignore_ascii_case(name)));
        }

        let restricted_preflight = Request::builder()
            .method(Method::OPTIONS)
            .uri("/restricted")
            .header(header::ORIGIN, "https://third-party.example")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
            .body(Body::empty())
            .unwrap();
        let restricted_response = app.oneshot(restricted_preflight).await.unwrap();

        assert_eq!(
            restricted_response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            None
        );
    }

    #[tokio::test]
    async fn relayer_cors_exposes_only_x_auth_error() {
        // Browsers can only read response headers listed in
        // Access-Control-Expose-Headers. The clock-drift reason (x-auth-error)
        // must be exposed so the browser SDK can distinguish drift from a bad
        // signature; nothing else should cross origins.
        let origin = "https://app.memwal.test";
        let app = Router::new()
            .route("/api/remember", post(|| async {}))
            .layer(relayer_cors(vec![origin.parse().unwrap()]));

        // Access-Control-Expose-Headers is emitted on the actual cross-origin
        // response, not on the OPTIONS preflight — so drive a real request.
        let request = Request::builder()
            .method(Method::POST)
            .uri("/api/remember")
            .header(header::ORIGIN, origin)
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();

        let exposed = response
            .headers()
            .get(header::ACCESS_CONTROL_EXPOSE_HEADERS)
            .expect("relayer CORS must set Access-Control-Expose-Headers")
            .to_str()
            .unwrap();
        let names: Vec<&str> = exposed
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        assert!(
            names.iter().any(|n| n.eq_ignore_ascii_case("x-auth-error")),
            "x-auth-error must be exposed, got: {exposed}"
        );
        assert_eq!(
            names.len(),
            1,
            "only x-auth-error should be exposed, got: {exposed}"
        );
    }
}

fn parse_env_u64(name: &str, fallback: u64, min: u64, max: u64) -> u64 {
    let Ok(raw) = std::env::var(name) else {
        return fallback;
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return fallback;
    }
    let Ok(parsed) = raw.parse::<u64>() else {
        tracing::warn!("ignoring invalid {}={}; using {}", name, raw, fallback);
        return fallback;
    };
    if parsed < min {
        tracing::warn!("ignoring too-small {}={}; using {}", name, parsed, fallback);
        return fallback;
    }
    if parsed > max {
        tracing::warn!("clamping {}={} to {}", name, parsed, max);
        return max;
    }
    parsed
}

fn parse_env_u32(name: &str, fallback: u32, min: u32, max: u32) -> u32 {
    parse_env_u64(name, fallback as u64, min as u64, max as u64) as u32
}

/// Background task that periodically monitors wallet balances and alerts Slack
/// when balances fall below configured thresholds. Fetches uploader pool balances
/// from the sidecar and sponsor wallet balance from the RPC.
#[tracing::instrument(name = "balance_monitor", skip_all)]
async fn balance_monitor_task(state: Arc<AppState>, interval_secs: u64) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        interval.tick().await;

        // Fetch uploader pool balance from sidecar
        let sidecar_url = &state.config.sidecar_url;
        let wallet_metrics_url = format!("{}/internal/wallet-balances", sidecar_url);

        let mut sidecar_request = state.http_client.get(&wallet_metrics_url);
        if let Some(secret) = state.config.sidecar_secret.as_deref() {
            sidecar_request = sidecar_request.header("authorization", format!("Bearer {}", secret));
        }

        match sidecar_request.send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<serde_json::Value>().await {
                    Ok(data) => {
                        if let Some(wallets) =
                            data.get("perWallet").and_then(|value| value.as_array())
                        {
                            for wallet in wallets {
                                let Some(address) =
                                    wallet.get("address").and_then(|value| value.as_str())
                                else {
                                    tracing::warn!(
                                        "balance_monitor: wallet metrics entry missing address"
                                    );
                                    continue;
                                };
                                let wallet_index = wallet
                                    .get("walletIndex")
                                    .and_then(|value| value.as_u64())
                                    .and_then(|value| usize::try_from(value).ok());
                                if wallet_index.is_none() {
                                    tracing::warn!(
                                        address,
                                        "balance_monitor: wallet metrics entry has invalid walletIndex"
                                    );
                                }

                                // Durable registration withdraws both WAL and
                                // its relay-tip SUI from address balances. Coin
                                // object balances cannot prevent those writes
                                // from failing, so alert on the spendable values.
                                match wallet
                                    .get("walAddressBalanceFrost")
                                    .and_then(|value| value.as_str())
                                    .and_then(|value| value.parse::<u64>().ok())
                                {
                                    Some(wal_balance)
                                        if wal_balance
                                            < state.config.wallet_balance_low_threshold_wal =>
                                    {
                                        tracing::warn!(
                                            address,
                                            balance = wal_balance,
                                            threshold = state.config.wallet_balance_low_threshold_wal,
                                            "balance_monitor: uploader wallet WAL address balance below threshold"
                                        );
                                        let alert = alerts::WalletBalanceLowAlert {
                                            wallet_type: "uploader".to_string(),
                                            address: address.to_string(),
                                            balance: wal_balance,
                                            threshold: state.config.wallet_balance_low_threshold_wal,
                                            token: "WAL".to_string(),
                                            sui_network: state.config.sui_network.clone(),
                                            wallet_index,
                                        };
                                        if let Err(err) =
                                            state.alerts.notify_wallet_balance_low(alert).await
                                        {
                                            tracing::warn!(
                                                address,
                                                "balance_monitor: failed to send uploader WAL alert: {}",
                                                err
                                            );
                                        }
                                    }
                                    Some(wal_balance) => tracing::debug!(
                                        address,
                                        balance = wal_balance,
                                        "balance_monitor: uploader wallet WAL address balance ok"
                                    ),
                                    None => tracing::warn!(
                                        address,
                                        "balance_monitor: wallet metrics entry has invalid walAddressBalanceFrost"
                                    ),
                                }

                                match wallet
                                    .get("suiAddressBalanceMist")
                                    .and_then(|value| value.as_str())
                                    .and_then(|value| value.parse::<u64>().ok())
                                {
                                    Some(sui_balance)
                                        if sui_balance
                                            < state.config.wallet_balance_low_threshold_sui =>
                                    {
                                        tracing::warn!(
                                            address,
                                            balance = sui_balance,
                                            threshold = state.config.wallet_balance_low_threshold_sui,
                                            "balance_monitor: uploader wallet SUI address balance below threshold"
                                        );
                                        let alert = alerts::WalletBalanceLowAlert {
                                            wallet_type: "uploader".to_string(),
                                            address: address.to_string(),
                                            balance: sui_balance,
                                            threshold: state.config.wallet_balance_low_threshold_sui,
                                            token: "SUI".to_string(),
                                            sui_network: state.config.sui_network.clone(),
                                            wallet_index,
                                        };
                                        if let Err(err) =
                                            state.alerts.notify_wallet_balance_low(alert).await
                                        {
                                            tracing::warn!(
                                                address,
                                                "balance_monitor: failed to send uploader SUI alert: {}",
                                                err
                                            );
                                        }
                                    }
                                    Some(sui_balance) => tracing::debug!(
                                        address,
                                        balance = sui_balance,
                                        "balance_monitor: uploader wallet SUI address balance ok"
                                    ),
                                    None => tracing::warn!(
                                        address,
                                        "balance_monitor: wallet metrics entry has invalid suiAddressBalanceMist"
                                    ),
                                }
                            }
                        } else {
                            tracing::warn!(
                                "balance_monitor: sidecar wallet metrics missing perWallet"
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            "balance_monitor: failed to parse sidecar wallet metrics: {}",
                            e
                        );
                    }
                }
            }
            Err(e) => {
                tracing::warn!(
                    "balance_monitor: failed to fetch sidecar wallet metrics: {}",
                    e
                );
            }
            Ok(resp) => {
                tracing::warn!(
                    "balance_monitor: sidecar wallet metrics returned status {}",
                    resp.status()
                );
            }
        }

        // Fetch sponsor wallet balance if configured
        if let Some(sponsor_key) = &state.config.sponsor_private_key {
            // Derive sponsor address from the key
            match sui::tx_build::sponsor_address(sponsor_key) {
                Ok(sponsor_address) => {
                    // Use the security_delete_background_sui client for balance checking if available
                    if let Some(sui_client) = &state.security_delete_background_sui {
                        match sui_client.address_balance(&sponsor_address).await {
                            Ok(sponsor_balance) => {
                                if sponsor_balance < state.config.sponsor_balance_low_threshold_sui
                                {
                                    tracing::warn!(
                                        "balance_monitor: sponsor wallet SUI balance {} below threshold {}",
                                        sponsor_balance,
                                        state.config.sponsor_balance_low_threshold_sui
                                    );
                                    let alert = alerts::WalletBalanceLowAlert {
                                        wallet_type: "sponsor".to_string(),
                                        address: sponsor_address.clone(),
                                        balance: sponsor_balance,
                                        threshold: state.config.sponsor_balance_low_threshold_sui,
                                        token: "SUI".to_string(),
                                        sui_network: state.config.sui_network.clone(),
                                        wallet_index: None,
                                    };
                                    if let Err(err) =
                                        state.alerts.notify_wallet_balance_low(alert).await
                                    {
                                        tracing::warn!(
                                            "balance_monitor: failed to send sponsor alert: {}",
                                            err
                                        );
                                    }
                                } else {
                                    tracing::debug!(
                                        "balance_monitor: sponsor wallet SUI balance {} ok",
                                        sponsor_balance
                                    );
                                }
                            }
                            Err(e) => {
                                tracing::warn!(
                                    "balance_monitor: failed to fetch sponsor balance: {}",
                                    e
                                );
                            }
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("balance_monitor: failed to derive sponsor address: {}", e);
                }
            }
        }
    }
}

async fn init_apalis_pool(
    database_url: &str,
    startup_timeout: std::time::Duration,
) -> Result<sqlx::PgPool, String> {
    tracing::info!(
        "  Apalis: connecting to PostgreSQL (startup_timeout={}s)",
        startup_timeout.as_secs()
    );
    // Runtime query bounds for this pool (job fetch/update, not migrate).
    //
    // `set_config(..., true)` (SET LOCAL) in after_connect is a no-op:
    // after_connect runs under autocommit, so Postgres discards the GUC when
    // that statement's implicit transaction ends — runtime queries would
    // then be unbounded. Session-scoped (`false`) is the only after_connect
    // form that actually sticks.
    //
    // `lock_timeout` is intentionally omitted. A leaked session lock_timeout
    // on a transaction-mode pooler backend is what aborted sqlx migrate
    // (15s wait → panic). Migrate now uses the direct host, but we still
    // don't put lock_timeout on pooled backends. statement_timeout and
    // idle_in_transaction_session_timeout bound queries without aborting
    // lock waits; if they leak onto another pooler client they are still
    // a bound, not a migrate-killer.
    let statement_timeout = format!("{}ms", startup_timeout.as_millis().min(300_000));
    let pool_future = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(startup_timeout)
        .after_connect(move |conn, _meta| {
            let statement_timeout = statement_timeout.clone();
            Box::pin(async move {
                sqlx::query(
                    "SELECT set_config('statement_timeout', $1, false), \
                            set_config('idle_in_transaction_session_timeout', $1, false)",
                )
                .bind(statement_timeout)
                .execute(conn)
                .await?;
                Ok(())
            })
        })
        .connect(database_url);

    let pool = match tokio::time::timeout(startup_timeout, pool_future).await {
        Ok(Ok(pool)) => pool,
        Ok(Err(err)) => return Err(format!("connect to PostgreSQL for Apalis: {err}")),
        Err(_) => {
            return Err(format!(
                "timed out after {}s connecting to PostgreSQL for Apalis",
                startup_timeout.as_secs()
            ))
        }
    };
    tracing::info!("  Apalis: PostgreSQL connected");

    let schema_ready = match tokio::time::timeout(startup_timeout, apalis_schema_ready(&pool)).await
    {
        Ok(Ok(ready)) => ready,
        Ok(Err(err)) => return Err(format!("check Apalis schema readiness: {err}")),
        Err(_) => {
            return Err(format!(
                "timed out after {}s checking Apalis schema readiness",
                startup_timeout.as_secs()
            ))
        }
    };
    if schema_ready {
        tracing::info!("  Apalis: PostgreSQL schema already current");
        return Ok(pool);
    }

    tracing::info!("  Apalis: running PostgreSQL migrations");
    let migrate_url = direct_postgres_url(database_url);
    let setup_pool_future = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(startup_timeout)
        .connect(migrate_url.as_ref());
    let setup_pool = match tokio::time::timeout(startup_timeout, setup_pool_future).await {
        Ok(Ok(setup_pool)) => setup_pool,
        Ok(Err(err)) => {
            return Err(format!(
                "connect to PostgreSQL for Apalis migrations: {err}"
            ))
        }
        Err(_) => {
            return Err(format!(
                "timed out after {}s connecting to PostgreSQL for Apalis migrations",
                startup_timeout.as_secs()
            ))
        }
    };
    let setup_result = match tokio::time::timeout(
        startup_timeout,
        PostgresStorage::<()>::setup(&setup_pool),
    )
    .await
    {
        Ok(Ok(())) => {
            tracing::info!("  Apalis: PostgreSQL migrations applied");
            Ok(pool)
        }
        Ok(Err(err)) => Err(format!("run Apalis PostgreSQL migrations: {err}")),
        Err(_) => Err(format!(
            "timed out after {}s running Apalis PostgreSQL migrations",
            startup_timeout.as_secs()
        )),
    };
    // If setup already timed out because the connection is wedged, a graceful
    // close can block boot indefinitely. Keep the same outer bound as the rest
    // of this function and surface `setup_result` either way.
    if tokio::time::timeout(startup_timeout, setup_pool.close())
        .await
        .is_err()
    {
        tracing::warn!(
            timeout_secs = startup_timeout.as_secs(),
            "  Apalis: timed out closing the migration pool; continuing"
        );
    }
    setup_result
}

async fn apalis_schema_ready(pool: &sqlx::PgPool) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'apalis'
              AND table_name = 'jobs'
              AND column_name = 'priority'
        ) AND EXISTS (
            SELECT 1
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'apalis'
              AND p.proname = 'get_jobs'
        )",
    )
    .fetch_one(pool)
    .await
}

#[tokio::main]
async fn main() {
    #[cfg(all(feature = "ci-offline-onchain", debug_assertions))]
    assert_eq!(
        std::env::var("CI").as_deref(),
        Ok("true"),
        "ci-offline-onchain is restricted to CI test processes"
    );

    // Load .env file (optional, won't error if missing)
    dotenvy::dotenv().ok();

    let telemetry = observability::init_tracing();

    // Load config
    let config = Config::from_env();
    if let Err(error) = crate::types::validate_security_delete_config(&config) {
        tracing::error!("boot guard: {}", error);
        std::process::exit(1);
    }
    tracing::info!("starting memwal server on port {}", config.port);
    tracing::info!("  Sui RPC: {}", config.sui_rpc_url);
    tracing::info!("  package type-origin id: {}", config.package_id);
    tracing::info!(
        "  SEAL policy package id: {}",
        config.seal_policy_package_id
    );
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
        "  sponsor rate limit: {}/min, {}/hr per IP; {}/min, {}/hr global",
        config.sponsor_rate_limit.per_minute,
        config.sponsor_rate_limit.per_hour,
        config.sponsor_rate_limit.global_per_minute,
        config.sponsor_rate_limit.global_per_hour,
    );
    tracing::info!(
        "  accounts rate limit: {}/min, {}/hr per IP; {}/min, {}/hr global",
        config.accounts_rate_limit.per_minute,
        config.accounts_rate_limit.per_hour,
        config.accounts_rate_limit.global_per_minute,
        config.accounts_rate_limit.global_per_hour,
    );
    tracing::info!(
        "  owner-token issuance: {} (ttl={}s); rate limit {}/min, {}/hr per credential; {}/min, {}/hr per owner",
        if config.owner_token_secret.is_empty() {
            "DISABLED (OWNER_TOKEN_SECRET unset)"
        } else {
            "enabled"
        },
        config.owner_token_ttl_secs,
        config.owner_token_rate_limit.per_minute,
        config.owner_token_rate_limit.per_hour,
        config.owner_token_rate_limit.owner_per_minute,
        config.owner_token_rate_limit.owner_per_hour,
    );
    if config.owner_token_secret.is_empty() {
        tracing::warn!(
            "  owner-token: OWNER_TOKEN_SECRET is unset — POST /v1/owner-tokens will 503 and the OwnerToken extractor will reject every bearer token until it's set."
        );
    }
    if config.owner_token_service_credential.is_empty() {
        tracing::warn!(
            "  owner-token: OWNER_TOKEN_SERVICE_CREDENTIAL is unset — POST /v1/owner-tokens will 401 every caller until it's set."
        );
    }
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
    // Set 30s timeout on HTTP client to prevent hanging LLM/Walrus requests
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
    // If the sidecar remains unhealthy, exit the relayer so Railway restarts
    // the whole container and brings up a fresh sidecar process.
    let sidecar_watch_interval_secs = parse_env_u64("SIDECAR_WATCHDOG_INTERVAL_SECS", 30, 5, 300);
    let sidecar_watch_timeout_secs = parse_env_u64("SIDECAR_WATCHDOG_TIMEOUT_SECS", 2, 1, 30);
    let sidecar_watch_max_failures = parse_env_u32("SIDECAR_WATCHDOG_MAX_FAILURES", 6, 1, 100);
    tracing::info!(
        "  sidecar watchdog: interval={}s timeout={}s max_failures={}",
        sidecar_watch_interval_secs,
        sidecar_watch_timeout_secs,
        sidecar_watch_max_failures
    );
    let sidecar_watch_client = http_client.clone();
    let sidecar_watch_url = health_url.clone();
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(sidecar_watch_interval_secs));
        let mut consecutive_failures = 0u32;
        loop {
            interval.tick().await;
            match sidecar_watch_client
                .get(&sidecar_watch_url)
                .timeout(std::time::Duration::from_secs(sidecar_watch_timeout_secs))
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
                }
                Err(e) => {
                    consecutive_failures += 1;
                    tracing::error!(
                        "  sidecar: health check error consecutive_failures={} error={}",
                        consecutive_failures,
                        e
                    );
                }
            }
            if consecutive_failures >= sidecar_watch_max_failures {
                tracing::error!(
                    "  sidecar: unhealthy for {} consecutive check(s); exiting relayer for supervisor restart",
                    consecutive_failures
                );
                std::process::exit(1);
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
    let security_delete_component_enabled = config.enable_security_delete
        || config.deletion_reconciler_enabled
        || config.deletion_object_resolver_enabled;
    let legacy_db = if security_delete_component_enabled {
        Some(Arc::new(
            LegacyDb::new(
                config
                    .legacy_db_url
                    .as_deref()
                    .expect("boot guard requires LEGACY_DB_URL"),
            )
            .await
            .expect("Failed to initialize legacy security-delete database"),
        ))
    } else {
        None
    };

    let apalis_startup_timeout_secs = parse_env_u64(
        "APALIS_STARTUP_TIMEOUT_SECS",
        DEFAULT_APALIS_STARTUP_TIMEOUT_SECS,
        5,
        300,
    );
    let apalis_pool = init_apalis_pool(
        &config.database_url,
        std::time::Duration::from_secs(apalis_startup_timeout_secs),
    )
    .await
    .unwrap_or_else(|err| panic!("Failed to initialize Apalis job queue: {err}"));
    let job_storage: PostgresStorage<MetaTransferJob> = PostgresStorage::new(apalis_pool.clone());
    let remember_job_storage: PostgresStorage<RememberJob> =
        PostgresStorage::new(apalis_pool.clone());
    // BulkRememberJob storage
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
    let security_delete_nonce_store: Arc<dyn security_delete_auth::NonceStore> =
        Arc::new(security_delete_auth::RedisNonceStore::new(redis.clone()));

    // Redis Walrus blob ciphertext cache skips Walrus fetch on warm recall.
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

    let alerts = Arc::new(AlertManager::from_env(http_client.clone()));

    // General delegate-key verification and the boot-time SEAL policy check
    // share this independent gRPC client; security deletion owns a separate
    // quota-gated client below.
    let sui_grpc_client = config.sui_grpc_url.as_deref().map(|url| {
        sui_rpc::Client::new(url)
            .unwrap_or_else(|e| panic!("SUI_GRPC_URL {url} is not a valid gRPC endpoint: {e}"))
    });
    if let Some(url) = config.sui_grpc_url.as_deref() {
        tracing::info!("  Sui gRPC: {}", url);
    }

    #[cfg(not(all(feature = "ci-offline-onchain", debug_assertions)))]
    {
        let policy_client = sui_grpc_client.as_ref().unwrap_or_else(|| {
            panic!("SUI_GRPC_URL is required to validate MEMWAL_SEAL_POLICY_PACKAGE_ID")
        });
        storage::sui::verify_seal_policy_package(
            policy_client,
            &config.package_id,
            &config.seal_policy_package_id,
        )
        .await
        .unwrap_or_else(|error| panic!("invalid SEAL policy package configuration: {error}"));
        tracing::info!("  SEAL policy package lineage and ABI verified");

        // Fail closed if MEMWAL_PACKAGE_ID is an upgraded/current package rather
        // than the immutable type-origin encoded in AccountRegistry. Delegate-key
        // verification uses this id to reject foreign lookalike Move objects.
        storage::sui::verify_registry_type_origin(
            &http_client,
            &config.sui_rpc_url,
            sui_grpc_client.as_ref(),
            &config.registry_id,
            &config.package_id,
        )
        .await
        .unwrap_or_else(|error| {
            panic!(
                "MEMWAL_PACKAGE_ID must be the immutable type-origin package id for registry {}: {}",
                config.registry_id, error
            )
        });
        tracing::info!("  package type-origin invariant verified from AccountRegistry");
    }
    #[cfg(all(feature = "ci-offline-onchain", debug_assertions))]
    {
        tracing::warn!("  CI-only build: onchain startup validation is disabled");
    }

    type SecurityDeleteSui = Option<Arc<dyn sui::SuiApi>>;
    type SecurityDeleteVerifier = Arc<dyn security_delete_auth::WalletSignatureVerifier>;
    let (security_delete_sui, security_delete_background_sui, security_delete_wallet_verifier): (
        SecurityDeleteSui,
        SecurityDeleteSui,
        SecurityDeleteVerifier,
    ) = if security_delete_component_enabled {
        let client = sui::SuiClient::new(
            config
                .sui_grpc_url
                .as_deref()
                .expect("boot guard requires SUI_GRPC_URL"),
            config.sui_rpc_requests_per_window,
            config.sui_rpc_window,
        )
        .expect("failed to initialize security-delete Sui client")
        .with_rpc_limits(config.sui_rpc_attempt_timeout, config.sui_rpc_max_in_flight)
        .expect("invalid security-delete Sui RPC controls")
        .with_walrus_config(
            config.walrus_package_id.clone(),
            config.walrus_system_object_id.clone(),
            config.walrus_staking_pool_id.clone(),
        );
        (
            Some(Arc::new(client.clone())),
            Some(Arc::new(client.background())),
            Arc::new(sui::verifier::GrpcWalletSignatureVerifier::new(client)),
        )
    } else if let Some(url) = config.sui_grpc_url.as_deref() {
        // Sponsor authorization also uses this verifier. Keep zkLogin,
        // multisig verification, and sponsor balance monitoring available even
        // when security deletion itself is disabled.
        let client = sui::SuiClient::new(
            url,
            config.sui_rpc_requests_per_window,
            config.sui_rpc_window,
        )
        .expect("failed to initialize sponsor signature verifier")
        .with_rpc_limits(config.sui_rpc_attempt_timeout, config.sui_rpc_max_in_flight)
        .expect("invalid sponsor signature RPC controls");
        let background_client = Arc::new(client.background());
        (
            None,
            Some(background_client),
            Arc::new(sui::verifier::GrpcWalletSignatureVerifier::new(client)),
        )
    } else {
        (
            None,
            None,
            Arc::new(security_delete_auth::NativeWalletSignatureVerifier),
        )
    };
    let security_delete_execution_gate = Arc::new(types::SecurityDeleteExecutionGate::new(
        config.security_delete_execute_max_in_flight,
    ));

    // General-purpose Sui client for the per-memory expiry sweep.
    // Deliberately independent of `security_delete_component_enabled` —
    // unlike `security_delete_sui` above, the expiry sweep must have a
    // client whenever SUI_GRPC_URL is configured at all, so it works in
    // deployments that never enable security deletion. This builds a
    // separate SuiClient/gRPC client instance from `security_delete_sui`'s
    // even when both end up `Some`; that duplication is intentional, not a
    // bug — unifying them is out of scope for this change.
    let walrus_sui_client: Option<Arc<dyn sui::SuiApi>> =
        config.sui_grpc_url.as_deref().map(|url| {
            let client = sui::SuiClient::new(
                url,
                config.sui_rpc_requests_per_window,
                config.sui_rpc_window,
            )
            .expect("failed to initialize Walrus Sui client")
            .with_rpc_limits(config.sui_rpc_attempt_timeout, config.sui_rpc_max_in_flight)
            .expect("invalid Walrus Sui RPC controls")
            .with_walrus_config(
                config.walrus_package_id.clone(),
                config.walrus_system_object_id.clone(),
                config.walrus_staking_pool_id.clone(),
            );
            Arc::new(client) as Arc<dyn sui::SuiApi>
        });

    // Shared application state
    // Dedicated pool for per-job upload advisory locks (see AppState docs). Sized
    // to the wallet-job concurrency (+1 headroom) so every concurrent upload can
    // hold its own lock connection without touching the request-serving pool. Read
    // WALLET_JOB_CONCURRENCY here independently of the worker registration below.
    let wallet_lock_pool_size = std::env::var("WALLET_JOB_CONCURRENCY")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(8)
        .saturating_add(1)
        .max(2);
    let wallet_lock_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(wallet_lock_pool_size)
        .connect(&config.database_url)
        .await
        .expect("Failed to create wallet advisory-lock pool");

    let state = Arc::new(AppState {
        db,
        wallet_lock_pool,
        legacy_db,
        security_delete_nonce_store,
        security_delete_wallet_verifier,
        security_delete_sui,
        security_delete_background_sui,
        walrus_sui_client,
        security_delete_execution_gate,
        config: Arc::clone(&config),
        http_client,
        sui_grpc_client,
        delegate_keys_cache: crate::storage::sui::new_delegate_keys_cache(),
        key_pool,
        alerts,
        engine,
        embedder,
        extractor,
        ranker,
        redis,
        fallback_rate_limit: tokio::sync::Mutex::new(crate::rate_limit::InMemoryFallback::default()),
        registry_scan_semaphore: tokio::sync::Semaphore::new(
            crate::types::REGISTRY_SCAN_MAX_CONCURRENT,
        ),
        remember_job_storage: remember_job_storage.clone(),
        wallet_storage: wallet_storage.clone(),
        bulk_job_storage: bulk_job_storage.clone(),
        blob_cache_ttl,
        blob_cache_max_bytes,
        embedding_cache_ttl,
    });

    jobs_security_delete::spawn_reconciler(Arc::clone(&state));
    jobs_security_delete::spawn_object_resolver(Arc::clone(&state));

    tracing::info!(
        "  alerts: Slack {} via ALERT_TO_SLACK",
        if state.alerts.slack_enabled() {
            "enabled"
        } else {
            "disabled"
        }
    );

    // Sidecar upload-queue saturation monitor. The watchdog above only
    // checks that /health answers; during the 2026-06-10 congestion incident
    // it stayed green while 120 uploads queued and jobs burned their retry
    // budgets. This monitor reads the queue counters that /health already
    // exposes and alerts ops while there is still time to act (add wallets /
    // throttle the burst) — before queued requests outlive the sidecar's
    // 120s acquire timeout and start failing.
    let saturation_threshold = parse_env_u64("SIDECAR_QUEUE_SATURATION_THRESHOLD", 20, 1, 10_000);
    let saturation_consecutive = parse_env_u32("SIDECAR_QUEUE_SATURATION_CONSECUTIVE", 4, 1, 100);
    let saturation_interval_secs =
        parse_env_u64("SIDECAR_QUEUE_SATURATION_INTERVAL_SECS", 30, 5, 300);
    tracing::info!(
        "  sidecar saturation monitor: threshold={} consecutive={} interval={}s",
        saturation_threshold,
        saturation_consecutive,
        saturation_interval_secs
    );
    {
        let monitor_client = state.http_client.clone();
        let monitor_url = health_url.clone();
        let monitor_alerts = Arc::clone(&state.alerts);
        let monitor_network = config.sui_network.clone();
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(saturation_interval_secs));
            let mut consecutive_saturated = 0u32;
            loop {
                interval.tick().await;
                let body = match monitor_client
                    .get(&monitor_url)
                    .timeout(std::time::Duration::from_secs(2))
                    .send()
                    .await
                {
                    Ok(resp) if resp.status().is_success() => {
                        match resp.json::<serde_json::Value>().await {
                            Ok(v) => v,
                            Err(_) => continue,
                        }
                    }
                    // Liveness problems are the watchdog's job; only the
                    // healthy-but-saturated case belongs here.
                    _ => continue,
                };

                let queued = body["queuedWalrusUploads"].as_u64().unwrap_or(0);
                let active = body["activeWalrusUploads"].as_u64().unwrap_or(0);
                let global_capacity = body["walrusUploadLimits"]["globalCapacity"]
                    .as_u64()
                    .unwrap_or(0);

                if queued > saturation_threshold {
                    consecutive_saturated = consecutive_saturated.saturating_add(1);
                    tracing::warn!(
                        "  sidecar: upload queue saturated queued={} active={} capacity={} consecutive={}/{}",
                        queued,
                        active,
                        global_capacity,
                        consecutive_saturated,
                        saturation_consecutive,
                    );
                } else {
                    if consecutive_saturated >= saturation_consecutive {
                        tracing::info!(
                            "  sidecar: upload queue drained (queued={} <= threshold {})",
                            queued,
                            saturation_threshold,
                        );
                    }
                    consecutive_saturated = 0;
                }

                // Alert once per crossing; the AlertManager dedup window
                // handles re-alerting if the backlog persists.
                if consecutive_saturated >= saturation_consecutive {
                    let alert = crate::alerts::WalrusUploadQueueSaturatedAlert {
                        sui_network: monitor_network.clone(),
                        queued,
                        active,
                        global_capacity,
                        threshold: saturation_threshold,
                        consecutive_checks: consecutive_saturated,
                    };
                    if let Err(err) = monitor_alerts
                        .notify_walrus_upload_queue_saturated(alert)
                        .await
                    {
                        tracing::warn!("  sidecar: saturation alert delivery failed: {}", err);
                    }
                }
            }
        });
    }

    // Worker 1: deserialize legacy rows and fail them closed for reconciliation.
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

    // Worker 2: deserialize legacy rows and fail them closed before upload.
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

    // Worker 3: BulkRememberJob
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
            // MCP OAuth housekeeping — runs unconditionally since oauth state
            // is cheap to clean up even when OAuth isn't actively used.
            if let Err(e) = evict_state.db.evict_expired_oauth_state().await {
                tracing::error!("MCP OAuth session/code eviction failed: {}", e);
            }
            if let Err(e) = evict_state.db.prune_unconsumed_oauth_clients().await {
                tracing::error!("MCP OAuth client pruning failed: {}", e);
            }
            if let Err(e) = evict_state.db.sweep_expired_tombstones().await {
                tracing::error!("tombstone retention sweep failed: {}", e);
            }
        }
    });

    // Spawn background task to bound the in-memory `DelegateKeysCache`
    // (the `/agents` cache — see `storage/sui.rs`). Unlike the
    // Postgres-backed eviction above, nothing else ever removes entries from
    // this HashMap: the 30s TTL only gates whether a hit is trusted, so
    // without this sweep it grows for the lifetime of the process, one
    // entry per distinct account_object_id ever looked up. Sweeping is a
    // cheap in-memory `retain` (no I/O), so a 5-minute cadence against the
    // 10-minute `DELEGATE_KEYS_CACHE_MAX_AGE` keeps the map bounded to
    // recently-active accounts with headroom to spare.
    let delegate_cache_sweep_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
        loop {
            interval.tick().await;
            let mut cache = delegate_cache_sweep_state.delegate_keys_cache.write().await;
            let before = cache.len();
            cache.retain(|_, v| v.fetched_at.elapsed() < storage::sui::DELEGATE_KEYS_CACHE_MAX_AGE);
            let evicted = before - cache.len();
            drop(cache);
            if evicted > 0 {
                tracing::debug!(
                    "delegate_keys_cache sweep: evicted {} stale entries ({} remaining)",
                    evicted,
                    before - evicted
                );
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

            // Storage-quota reservation upkeep, on the same tick.
            //
            // Ordered after the stale-job sweep so rows it just marked failed
            // are reconciled in the same pass instead of waiting a full minute.
            // The reconcile handles terminal jobs whose release was missed; the
            // expiry sweep is the last-resort backstop for reservations with no
            // job row at all (inline paths) or whose job vanished entirely.
            if let Err(e) = stale_job_state
                .db
                .release_reservations_for_terminal_jobs()
                .await
            {
                tracing::error!("Terminal-job reservation reconcile failed: {}", e);
            }
            if let Err(e) = stale_job_state
                .db
                .sweep_expired_storage_reservations()
                .await
            {
                tracing::error!("Expired reservation sweep failed: {}", e);
            }
        }
    });

    // A blob's storage_end_epoch and the current_epoch its lease lookup
    // was observed at — both scoped to the same sidecar response, both
    // needed by the current-epoch-anchored `expires_at_from_epoch` formula
    // (the expiry sweep, below).
    struct LeaseEpochs {
        storage_end_epoch: i32,
        current_epoch: i32,
    }

    // Spawn background task for per-memory expiry refresh.
    //
    // Populates `end_epoch`/`expires_at` on `vector_entries` rows so the
    // owner-scoped memory listing API never needs a live chain read.
    // Batches by owner so each owner needs one sidecar query-blobs call
    // (with `includeStorageLease: true`) rather than one per row. The
    // epoch schedule (`epoch_duration_ms`) is fetched ONCE per tick,
    // shared across every owner in that tick's batch.
    let expiry_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
        // Rate-limited external-RPC loop: if a tick overruns 300s, catch up
        // by spacing subsequent ticks rather than firing several back-to-back
        // (the default `Burst` behavior).
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;

            // SUI_GRPC_URL isn't configured in this deployment — a
            // legitimate degraded-but-non-panicking state. Skip the whole
            // sweep body (not just the on-chain call) so a client-less
            // deployment doesn't still select + mark-scheduled rows for
            // nothing every tick, churning expiry_synced_at across the
            // table with no benefit.
            let Some(sui_client) = expiry_state.walrus_sui_client.as_ref() else {
                tracing::warn!(
                    "Expiry refresh sweep: no Sui client configured (SUI_GRPC_URL unset), skipping sweep"
                );
                continue;
            };

            // Fetch the epoch schedule ONCE per tick, BEFORE selecting or
            // marking any row as scheduled. walrus_epoch_schedule() is a
            // process-global (not owner-specific) on-chain fetch — if it
            // fails here, nothing has been selected or marked yet, so the
            // tick naturally retries in 300s. Previously this was fetched
            // per-owner AFTER rows were already marked scheduled, so a
            // failure left affected rows with NULL end_epoch/expires_at but
            // stamped expiry_synced_at, invisible to the sweep for 24h.
            let schedule = match sui_client.walrus_epoch_schedule().await {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("Expiry refresh sweep: epoch schedule lookup failed: {}", e);
                    continue;
                }
            };

            let rows = match expiry_state.db.rows_needing_expiry_refresh(100).await {
                Ok(rows) => rows,
                Err(e) => {
                    tracing::error!("Expiry refresh sweep: failed to select rows: {}", e);
                    continue;
                }
            };
            if rows.is_empty() {
                continue;
            }

            let ids: Vec<String> = rows.iter().map(|(_, id, _)| id.clone()).collect();
            if let Err(e) = expiry_state.db.mark_expiry_scheduled(&ids).await {
                tracing::error!("Expiry refresh sweep: failed to mark scheduled: {}", e);
                continue;
            }

            // Group by owner so each owner needs only one on-chain query
            // rather than one RPC per row.
            let mut by_owner: std::collections::HashMap<String, Vec<(String, String)>> =
                std::collections::HashMap::new();
            for (owner, id, blob_id) in rows {
                by_owner.entry(owner).or_default().push((id, blob_id));
            }

            for (owner, id_blob_pairs) in by_owner {
                let blob_ids: Vec<String> = id_blob_pairs
                    .iter()
                    .map(|(_, blob_id)| blob_id.clone())
                    .collect();
                let leases = match crate::storage::walrus::query_blob_storage_leases(
                    &expiry_state.http_client,
                    &expiry_state.config.sidecar_url,
                    expiry_state.config.sidecar_secret.as_deref(),
                    &owner,
                    &blob_ids,
                )
                .await
                {
                    Ok(leases) => leases,
                    Err(e) => {
                        tracing::warn!(owner = %owner, "Expiry refresh sweep: on-chain lease lookup failed: {}", e);
                        continue;
                    }
                };

                // Widen the per-blob-id map to carry each blob's
                // storage_end_epoch AND the current_epoch this owner's
                // lease lookup observed — the current-epoch-anchored
                // expires_at_from_epoch formula needs both, and
                // current_epoch is scoped to this exact lease response
                // (not the once-per-tick schedule, which only carries
                // epoch_duration_ms).
                let current_epoch = leases.current_epoch;
                let by_blob_id: std::collections::HashMap<String, LeaseEpochs> = leases
                    .blobs
                    .into_iter()
                    .map(|lease| {
                        (
                            lease.blob_id,
                            LeaseEpochs {
                                storage_end_epoch: lease.storage_end_epoch,
                                current_epoch,
                            },
                        )
                    })
                    .collect();

                let now = chrono::Utc::now();
                for (id, blob_id) in id_blob_pairs {
                    let Some(lease) = by_blob_id.get(&blob_id) else {
                        continue;
                    };
                    let expires_at = crate::sui::expires_at_from_epoch(
                        crate::sui::WalrusEpoch(lease.storage_end_epoch as u64),
                        crate::sui::WalrusEpoch(lease.current_epoch as u64),
                        &schedule,
                        now,
                    );
                    if let Err(e) = expiry_state
                        .db
                        .set_memory_expiry(&id, lease.storage_end_epoch, expires_at)
                        .await
                    {
                        tracing::error!(id = %id, "Expiry refresh sweep: failed to write back: {}", e);
                    }
                }
            }
        }
    });

    // Spawn background task for proactive wallet balance monitoring
    {
        let balance_monitor_state = state.clone();
        let balance_monitor_interval_secs = config.balance_monitor_interval_secs;
        tracing::info!(
            "  balance monitor: starting with interval={}s, wallet_threshold_wal={}, wallet_threshold_sui={}, sponsor_threshold_sui={}",
            balance_monitor_interval_secs,
            config.wallet_balance_low_threshold_wal,
            config.wallet_balance_low_threshold_sui,
            config.sponsor_balance_low_threshold_sui,
        );
        tokio::spawn(async move {
            balance_monitor_task(balance_monitor_state, balance_monitor_interval_secs).await;
        });
    }

    // Build routes
    // Protected routes (require Ed25519 signature + onchain verification)
    // 2 MiB covers the largest realistic JSON
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
        // Bulk remember — higher body limit (20 items × max 64 KiB each ≈ 1.5 MB)
        .route(
            "/api/remember/bulk",
            post(routes::remember_bulk).layer(DefaultBodyLimit::max(2 * 1024 * 1024)),
        )
        .route("/api/analyze", post(routes::analyze))
        .route("/api/embed", post(routes::embed))
        .route("/api/ask", post(routes::ask))
        .route("/api/restore", post(routes::restore))
        // admin/harness endpoints — namespace delete + stats.
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

    // Owner-scoped read API — split out of `protected_routes` so
    // these 3 GET endpoints stop spending the write path's 30/min
    // per-delegate-key budget (that budget exists to bound Walrus
    // upload/LLM/gas spend-risk; plain reads carry none of that risk and a
    // routine pagination loop could trip it under completely normal use).
    // Auth is `auth::verify_read_api_auth`: a combined dispatcher that
    // accepts either the existing Ed25519 signed-request scheme
    // (SDK/dashboard delegate-key callers, unmodified) or an owner-scoped
    // bearer token (Console, which structurally can never
    // produce an Ed25519 signature — see `owner_token_auth`'s module doc).
    // Both paths populate the same `AuthInfo` extension, so the handlers
    // themselves don't need to know which scheme authenticated the request.
    // `read_api_rate_limit_middleware` (not the shared `rate_limit_middleware`)
    // so this budget can never contend with writes.
    let read_api_routes = Router::new()
        .route(
            "/v1/owners/{owner}/namespaces",
            get(routes::list_owner_namespaces),
        )
        .route(
            "/v1/owners/{owner}/memories",
            get(routes::list_owner_memories),
        )
        .route("/v1/owners/{owner}/agents", get(routes::list_owner_agents))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            rate_limit::read_api_rate_limit_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::verify_read_api_auth,
        ))
        .layer(DefaultBodyLimit::max(auth::PROTECTED_BODY_LIMIT_BYTES));

    // Security-delete has its own server-side sponsor and does not use these
    // routes.
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

    let security_delete_auth_routes = Router::new()
        .route(
            "/api/security-delete-auth/challenge",
            post(security_delete_auth::challenge).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/api/security-delete-auth/verify",
            post(security_delete_auth::verify).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            routes::security_delete::security_delete_auth_rate_limit,
        ))
        // Last layer executes first: hide disabled deployments before rate
        // limiting or JSON extraction can reveal the route contract.
        .layer(middleware::from_fn_with_state(
            state.clone(),
            routes::security_delete::security_delete_feature_gate,
        ));

    let security_delete_bearer_routes = Router::new()
        .route(
            "/api/security-deletable-blobs",
            get(routes::security_delete::list_deletable_blobs),
        )
        .route(
            "/api/security-deletions",
            post(routes::security_delete::prepare_deletion)
                .layer(DefaultBodyLimit::max(256 * 1024)),
        )
        .route(
            "/api/security-deletions/{batch_id}/submit",
            post(routes::security_delete::submit_deletion).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/security-deletions/{batch_id}",
            get(routes::security_delete::deletion_status)
                .delete(routes::security_delete::cancel_deletion),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            routes::security_delete::security_delete_feature_gate,
        ));

    // The deletion API is intentionally consumable by public browser clients.
    // Keep its CORS policy route-scoped so the rest of the API still uses the
    // deployment's ALLOWED_ORIGINS allowlist.
    let security_delete_routes = security_delete_auth_routes
        .merge(security_delete_bearer_routes)
        .layer(security_delete_cors());

    // Owner-scoped bearer token issuance. Its own dedicated
    // router group (mirrors `security_delete_auth_routes`): it belongs in
    // neither `protected_routes` (which requires an Ed25519 signed
    // request — Console structurally can never produce one, since it
    // never holds a delegate key) nor `public_routes` (this is the
    // opposite of public — it demands the service credential). Router::layer
    // runs bottom-to-top (last-added = outermost = runs first), so:
    //   1. owner_token_ip_rate_limit_middleware (outermost) — throttles by
    //      source IP regardless of credential validity. This is the layer
    //      that actually bounds credential-guessing: the credential gate
    //      rejects a bad guess in-process with no I/O, so the per-credential
    //      limiter below it is structurally unreachable for a failing guess
    //      (and even if reached, is keyed by the guessed value itself, so a
    //      varying guess gets a fresh bucket every time). Without this IP
    //      layer, guessing the one shared service credential had no
    //      throttling anywhere (found in adversarial review, fixed here).
    //   2. service_credential_gate — rejects an uncredentialed caller before
    //      the per-credential rate limiter spends any Redis budget on it.
    //   3. owner_token_credential_rate_limit_middleware (innermost) — the
    //      legitimate-traffic budget for an authenticated Console instance.
    let owner_token_routes = Router::new()
        .route(
            "/v1/owner-tokens",
            post(routes::issue_token).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            rate_limit::owner_token_credential_rate_limit_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            routes::owner_token::service_credential_gate,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            rate_limit::owner_token_ip_rate_limit_middleware,
        ));

    // `GET /v1/owners/{owner}/_token_probe` — no router-level middleware
    // needed: `OwnerToken` is a pure `FromRequestParts` extractor, so axum
    // resolves (and rejects) it per-handler before the body ever runs.
    // See `routes::owner_token` module doc for why this route exists.
    let owner_token_probe_routes =
        Router::new().route("/v1/owners/{owner}/_token_probe", get(routes::token_probe));

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

    // Admin dashboard routes (requires ADMIN_API_KEY)
    let admin_dashboard_routes = Router::new()
        .route(
            "/api/admin/wallets",
            get(routes::admin_dashboard::get_wallets).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/admin/upload-errors",
            get(routes::admin_dashboard::get_upload_errors).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/admin/config",
            get(routes::admin_dashboard::get_admin_config).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .layer(middleware::from_fn(auth::verify_admin_key));

    // Public routes
    // /health and /config accept no body — cap at 16 KiB to reject
    // oversized unauthenticated requests before they reach any handler.
    // /config exposes non-secret deployment parameters (packageId,
    // network, sui_rpc_url) so the SDK can build SEAL SessionKey without
    // the user adding packageId to MemWalConfig.
    let mut public_routes = Router::new()
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
            "/api/accounts/{owner}/exists",
            get(routes::account_exists)
                .layer(DefaultBodyLimit::max(16 * 1024))
                // Only route in `public_routes` that hits the DB pool — see
                // `rate_limit::accounts_rate_limit_middleware` doc comment.
                .layer(middleware::from_fn_with_state(
                    state.clone(),
                    rate_limit::accounts_rate_limit_middleware,
                )),
        )
        .route(
            "/metrics",
            get(observability::metrics).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .merge(sponsor_routes)
        .merge(mcp_routes);

    // MCP OAuth 2.1 (Claude custom connectors) — mounted when configured
    // (env vars present), same tier as the routes above (no
    // auth::verify_signature; OAuth is its own auth scheme). Routes are
    // always mounted if configured; OAuth tokens simply won't resolve if
    // clients haven't registered yet.
    if config.mcp_oauth.is_some() {
        let oauth_routes = Router::new()
            .route(
                "/.well-known/oauth-protected-resource",
                get(routes::oauth::protected_resource_metadata)
                    .layer(DefaultBodyLimit::max(4 * 1024)),
            )
            .route(
                "/.well-known/oauth-protected-resource/api/mcp",
                get(routes::oauth::protected_resource_metadata)
                    .layer(DefaultBodyLimit::max(4 * 1024)),
            )
            .route(
                "/.well-known/oauth-authorization-server",
                get(routes::oauth::authorization_server_metadata)
                    .layer(DefaultBodyLimit::max(4 * 1024)),
            )
            .route(
                "/oauth/register",
                post(routes::oauth::register_client).layer(DefaultBodyLimit::max(32 * 1024)),
            )
            .route(
                "/oauth/authorize",
                get(routes::oauth::authorize).layer(DefaultBodyLimit::max(4 * 1024)),
            )
            .route(
                "/oauth/token",
                post(routes::oauth::token).layer(DefaultBodyLimit::max(16 * 1024)),
            )
            .route(
                "/oauth/revoke",
                post(routes::oauth::revoke).layer(DefaultBodyLimit::max(16 * 1024)),
            )
            .route(
                "/api/oauth/session/{session_id}",
                get(routes::oauth::session_view).layer(DefaultBodyLimit::max(4 * 1024)),
            )
            .route(
                "/api/oauth/session/{session_id}/account",
                post(routes::oauth::session_account).layer(DefaultBodyLimit::max(4 * 1024)),
            )
            .route(
                "/api/oauth/session/{session_id}/complete",
                post(routes::oauth::session_complete).layer(DefaultBodyLimit::max(4 * 1024)),
            )
            .route(
                "/api/oauth/session/{session_id}/cancel",
                post(routes::oauth::session_cancel).layer(DefaultBodyLimit::max(4 * 1024)),
            );
        public_routes = public_routes.merge(oauth_routes);
        tracing::info!("MCP OAuth routes mounted");
    }

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
            relayer_cors(origins)
        }
    };

    let app = Router::new()
        .merge(protected_routes)
        .merge(read_api_routes)
        .merge(public_routes)
        // Owner-token routes use the same deployment-wide ALLOWED_ORIGINS
        // CORS policy as protected/public routes (deny-all by default),
        // NOT the security-delete API's blanket allow-any: the service
        // credential must never reach browser JS (the mint call is
        // server-to-server, Console backend → WM), and the probe / future
        // owner-scoped read routes are only meant to be reachable from origins
        // this deployment explicitly trusts.
        .merge(owner_token_routes)
        .merge(owner_token_probe_routes)
        .merge(admin_dashboard_routes)
        .layer(cors)
        // Merge after applying the deployment-wide CORS layer so its
        // preflight handler cannot shadow the deletion API's public policy.
        .merge(security_delete_routes)
        .with_state(state)
        .layer(middleware::from_fn(
            observability::request_context_middleware,
        ));

    // Start server. Bind the IPv6 unspecified address (dual-stack: still
    // accepts IPv4 via mapped addresses) so the relayer is reachable over
    // Railway's private network, which is IPv6-only — e.g. for the
    // observability collector scraping /metrics at relayer.railway.internal.
    let addr = format!("[::]:{}", config.port);
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
    telemetry.shutdown();
}
