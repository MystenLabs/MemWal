//! Integration tests against a mock relayer (no network / credentials needed).

use memwal::{Error, RecallManualOptions, RecallParams, RememberManualOptions, WalrusMemory};
use serde_json::json;
use wiremock::matchers::{header_exists, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// 32 bytes of 0x01 — a valid Ed25519 seed, not a real credential.
const SEED: &str = "0101010101010101010101010101010101010101010101010101010101010101";
const ACCOUNT: &str = "0xabc";

fn client(uri: String) -> WalrusMemory {
    WalrusMemory::builder(SEED, ACCOUNT)
        .server_url(uri)
        .namespace("demo")
        .build()
        .expect("client builds")
}

/// Start a mock relayer with `/config` mounted, needed by any endpoint that
/// requests a SEAL session (`build_seal_session` fetches it for any
/// non-mainnet server URL, which every wiremock URI is).
async fn mock_relayer() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/config"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "packageId": "0xtest::memwal" })),
        )
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn remember_sends_signed_headers_and_parses_accepted() {
    let server = mock_relayer().await;
    Mock::given(method("POST"))
        .and(path("/api/remember"))
        .and(header_exists("x-public-key"))
        .and(header_exists("x-signature"))
        .and(header_exists("x-timestamp"))
        .and(header_exists("x-nonce"))
        .and(header_exists("x-account-id"))
        .and(header_exists("x-seal-session"))
        .respond_with(
            ResponseTemplate::new(202)
                .set_body_json(json!({"job_id": "job-1", "status": "running"})),
        )
        .mount(&server)
        .await;

    let res = client(server.uri()).remember("hello", None).await.unwrap();
    assert_eq!(res.job_id, "job-1");
    assert_eq!(res.status, "running");
}

#[tokio::test]
async fn recall_parses_and_applies_client_side_max_distance() {
    let server = mock_relayer().await;
    Mock::given(method("POST"))
        .and(path("/api/recall"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [
                {"blob_id": "a", "text": "near", "distance": 0.1},
                {"blob_id": "b", "text": "mid",  "distance": 0.5},
                {"blob_id": "c", "text": "far",  "distance": 0.9}
            ],
            "total": 3
        })))
        .mount(&server)
        .await;

    let c = client(server.uri());
    let all = c.recall(RecallParams::new("q")).await.unwrap();
    assert_eq!(all.total, 3);
    assert_eq!(all.results.len(), 3);

    let filtered = c
        .recall(RecallParams::new("q").max_distance(0.6))
        .await
        .unwrap();
    assert_eq!(filtered.total, 2);
    assert!(filtered.results.iter().all(|m| m.distance < 0.6));
}

#[tokio::test]
async fn get_remember_status_404_becomes_not_found() {
    let server = mock_relayer().await;
    Mock::given(method("GET"))
        .and(path("/api/remember/missing"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": "no such job"})))
        .mount(&server)
        .await;

    let st = client(server.uri())
        .get_remember_status("missing")
        .await
        .unwrap();
    assert_eq!(st.status, "not_found");
    assert_eq!(st.job_id, "missing");
}

#[tokio::test]
async fn health_is_unsigned_and_parses() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "ok", "version": "0.1.0", "apiVersion": "1.0.0"
        })))
        .mount(&server)
        .await;

    let h = client(server.uri()).health().await.unwrap();
    assert_eq!(h.status, "ok");
    assert_eq!(h.version, "0.1.0");
    assert_eq!(
        h.extra.get("apiVersion").and_then(|v| v.as_str()),
        Some("1.0.0")
    );
}

#[tokio::test]
async fn compatibility_accepts_1_x_api_version() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/version"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "relayerVersion": "0.1.0",
            "apiVersion": "1.2.0",
            "minSupportedSdk": {"typescript": "0.1.0", "python": "0.1.0", "mcp": "0.1.0"}
        })))
        .mount(&server)
        .await;

    client(server.uri()).compatibility().await.unwrap();
}

#[tokio::test]
async fn compatibility_rejects_incompatible_api_version() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/version"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "relayerVersion": "0.1.0",
            "apiVersion": "2.0.0",
            "minSupportedSdk": {"typescript": "0.1.0", "python": "0.1.0", "mcp": "0.1.0"}
        })))
        .mount(&server)
        .await;

    let err = client(server.uri()).compatibility().await.unwrap_err();
    assert!(matches!(err, Error::Compatibility(_)), "got {err:?}");
}

#[tokio::test]
async fn server_error_maps_to_error_server() {
    let server = mock_relayer().await;
    Mock::given(method("POST"))
        .and(path("/api/ask"))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({"error": "boom"})))
        .mount(&server)
        .await;

    let err = client(server.uri())
        .ask("why?", None, None)
        .await
        .unwrap_err();
    match err {
        Error::Server {
            status, message, ..
        } => {
            assert_eq!(status, 500);
            assert_eq!(message, "boom");
        }
        other => panic!("expected Error::Server, got {other:?}"),
    }
}

#[tokio::test]
async fn unauthorized_maps_to_auth_rejected() {
    let server = mock_relayer().await;
    Mock::given(method("POST"))
        .and(path("/api/recall"))
        .respond_with(ResponseTemplate::new(401).set_body_string(""))
        .mount(&server)
        .await;

    let err = client(server.uri())
        .recall(RecallParams::new("q"))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::AuthRejected { .. }), "got {err:?}");
}

#[tokio::test]
async fn recall_manual_parses_hits() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/recall/manual"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [{"blob_id": "a", "distance": 0.2, "importance": 0.5}],
            "total": 1
        })))
        .mount(&server)
        .await;

    let res = client(server.uri())
        .recall_manual(RecallManualOptions::new(vec![0.1, 0.2, 0.3]))
        .await
        .unwrap();
    assert_eq!(res.total, 1);
    assert_eq!(res.results[0].blob_id, "a");
}

#[tokio::test]
async fn remember_manual_parses_result_and_sends_no_seal_session() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/remember/manual"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "blob_id": "blob-1", "owner": "0xowner", "namespace": "demo"
        })))
        .mount(&server)
        .await;

    let res = client(server.uri())
        .remember_manual(RememberManualOptions::new("blob-1", vec![0.1, 0.2]))
        .await
        .unwrap();
    assert_eq!(res.blob_id, "blob-1");
    assert_eq!(res.owner, "0xowner");
}

#[test]
fn invalid_key_fails_to_build() {
    let err = WalrusMemory::builder("not-hex", ACCOUNT)
        .build()
        .unwrap_err();
    assert!(matches!(err, Error::InvalidKey(_)), "got {err:?}");
}

#[test]
fn rejects_non_http_server_url() {
    let err = WalrusMemory::builder(SEED, ACCOUNT)
        .server_url("ftp://example.com")
        .build()
        .unwrap_err();
    assert!(matches!(err, Error::InvalidUrl(_)), "got {err:?}");
}
