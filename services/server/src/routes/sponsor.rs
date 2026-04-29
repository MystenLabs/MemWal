//! Enoki sponsor proxies — straight HTTP passthroughs to the TS sidecar.
//! These do not touch memory storage; they exist solely so the FE can hit
//! one origin (the Rust server) and have the server forward to the sidecar's
//! `/sponsor` and `/sponsor/execute` endpoints.

use axum::{
    body::{Body, Bytes},
    extract::State,
    response::Response,
};
use std::sync::Arc;

use crate::types::{AppError, AppState};

/// POST /sponsor — proxy to sidecar POST /sponsor
pub async fn sponsor_proxy(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> Result<Response<Body>, AppError> {
    let url = format!("{}/sponsor", state.config.sidecar_url);
    let resp = state.http_client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body.to_vec())
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Sponsor proxy failed: {}", e)))?;

    let status = axum::http::StatusCode::from_u16(resp.status().as_u16())
        .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    let resp_body = resp.bytes().await
        .map_err(|e| AppError::Internal(format!("Sponsor proxy read failed: {}", e)))?;

    Ok(Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(Body::from(resp_body))
        .unwrap())
}

/// POST /sponsor/execute — proxy to sidecar POST /sponsor/execute
pub async fn sponsor_execute_proxy(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> Result<Response<Body>, AppError> {
    let url = format!("{}/sponsor/execute", state.config.sidecar_url);
    let resp = state.http_client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body.to_vec())
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Sponsor execute proxy failed: {}", e)))?;

    let status = axum::http::StatusCode::from_u16(resp.status().as_u16())
        .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    let resp_body = resp.bytes().await
        .map_err(|e| AppError::Internal(format!("Sponsor execute proxy read failed: {}", e)))?;

    Ok(Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(Body::from(resp_body))
        .unwrap())
}
