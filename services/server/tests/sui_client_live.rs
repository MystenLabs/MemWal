//! Live integration test: `SuiClient` against a running devstack.
//!
//! `#[ignore]`-gated so plain `cargo test` never touches the network.
//! The in-crate unit tests exercise `SuiApi` through `mock::MockSuiApi`
//! (`src/sui/mod.rs`), which can't catch gRPC field-mask or Walrus `Blob`
//! JSON-parsing bugs in the real client (`src/sui/client.rs`) — this test
//! is the one place that does.
//!
//! Setup: `source tests/security-delete-loadtest-e2e/.env.stack`, export
//! `TEST_BLOB_OWNER` to an address that owns at least one real Walrus Blob
//! object (see the runbook for how to seed one), then run:
//! `cargo test --test sui_client_live -- --ignored --nocapture`.

use memwal_server::default_walrus_staking_pool_id;
use memwal_server::sui::{SuiApi, SuiClient};
use std::time::Duration;

/// Mirrors `Config::from_env`'s `WALRUS_STAKING_POOL_ID` resolution
/// (`services/server/src/types.rs`): explicit env var if set, else the
/// per-network default (only testnet/mainnet have real distinct defaults —
/// see `default_walrus_staking_pool_id`'s doc comment).
fn resolve_walrus_staking_pool_id() -> String {
    std::env::var("WALRUS_STAKING_POOL_ID")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| {
            let network = std::env::var("SUI_NETWORK")
                .unwrap_or_else(|_| "mainnet".to_string())
                .trim()
                .to_ascii_lowercase();
            default_walrus_staking_pool_id(&network).to_string()
        })
}

#[tokio::test]
#[ignore]
async fn sui_client_roundtrips_against_live_stack() {
    let url = std::env::var("SUI_GRPC_URL").expect("SUI_GRPC_URL must be set (source .env.stack)");
    let walrus_package = std::env::var("WALRUS_PACKAGE_ID").expect("WALRUS_PACKAGE_ID must be set");
    let walrus_system =
        std::env::var("WALRUS_SYSTEM_OBJECT_ID").expect("WALRUS_SYSTEM_OBJECT_ID must be set");
    let walrus_staking_pool = resolve_walrus_staking_pool_id();
    let owner = std::env::var("TEST_BLOB_OWNER")
        .expect("TEST_BLOB_OWNER must be set to an address owning >=1 real Walrus Blob");
    let client = SuiClient::new(&url, 3_000, Duration::from_secs(10))
        .unwrap()
        .with_walrus_config(walrus_package, walrus_system, walrus_staking_pool);

    // Epoch zero is valid on a fresh local network; gas price must be non-zero.
    let _epoch = client.current_epoch().await.unwrap();
    assert!(client.reference_gas_price().await.unwrap() > 0);
    // chain id is stable across two calls (cached)
    assert_eq!(
        client.chain_id().await.unwrap(),
        client.chain_id().await.unwrap()
    );

    // The seeded owner is mandatory: skipping this would miss the field-mask and
    // Walrus Blob JSON parsing that this live test exists to cover.
    let (blobs, _cursor) = client.list_owned_blobs(&owner, None).await.unwrap();
    assert!(
        !blobs.is_empty(),
        "seeded owner should have >=1 Blob object"
    );
    let ids: Vec<String> = blobs.iter().map(|b| b.object_id.clone()).collect();
    let infos = client.batch_get_objects(&ids).await.unwrap();
    assert!(infos.iter().all(|o| o.is_some()));
    assert!(infos[0].as_ref().unwrap().blob_id.is_some());
    assert!(infos[0].as_ref().unwrap().end_epoch.is_some());
}
