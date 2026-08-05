//! Live integration test: Task 6 empirical-limits probe, Step 2 —
//! `BatchGetObjects` provider cap. `#[ignore]`-gated, same pattern as
//! `sui_client_live.rs`.
//!
//! Confirms (or corrects) spec §8's "1-3 calls per batch" claim by sending
//! `SuiClient::batch_get_objects` a single `BatchGetObjectsRequest` at
//! increasing sizes {50, 200, 500, 1000} — one raw gRPC call per size, no
//! client-side chunking (the production code path chunks at
//! `RPC_OBJECT_BATCH=100` in `routes/security_delete.rs`; this test
//! measures what the *provider itself* accepts in one call, independent of
//! that chunk size, so a future change to `RPC_OBJECT_BATCH` has real
//! numbers to lean on).
//!
//! Setup: `source tests/security-delete-loadtest-e2e/.env.stack`, export
//! `TEST_BLOB_OWNER` to an address owning close to 1000 real Walrus `Blob`
//! objects (the empirical-limits probe's n900 cohort, seeded via
//! `pnpm tsx src/limits.probe.ts seed` — see that file and
//! `docs-eng/reports/security-delete-benchmarks.md`), then run:
//! `cargo test --test security_delete_limits_live -- --ignored --nocapture`.
//! Read-only: run this BEFORE the n900 cohort's `execute` phase consumes
//! its owned-object set.

use memwal_server::sui::{SuiApi, SuiClient};
use std::time::{Duration, Instant};

#[tokio::test]
#[ignore]
async fn batch_get_objects_cap_probe() {
    let url = std::env::var("SUI_GRPC_URL").expect("SUI_GRPC_URL must be set (source .env.stack)");
    let walrus_package = std::env::var("WALRUS_PACKAGE_ID").expect("WALRUS_PACKAGE_ID must be set");
    let walrus_system =
        std::env::var("WALRUS_SYSTEM_OBJECT_ID").expect("WALRUS_SYSTEM_OBJECT_ID must be set");
    let walrus_staking_pool =
        std::env::var("WALRUS_STAKING_POOL_ID").expect("WALRUS_STAKING_POOL_ID must be set");
    let owner = std::env::var("TEST_BLOB_OWNER")
        .expect("TEST_BLOB_OWNER must be set to an address owning ~1000 real Walrus Blob objects");
    let client = SuiClient::new(&url, 3_000, Duration::from_secs(10))
        .unwrap()
        .with_walrus_config(walrus_package, walrus_system, walrus_staking_pool);

    // Collect the full owned set across pages, recording each page's size —
    // the observed page cap is itself a Task 6 measurement (spec §8 assumed
    // "~500/page" for type-filtered owned-object scans; the client requests
    // page_size=1000).
    let mut ids: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let (page, next) = client.list_owned_blobs(&owner, cursor).await.unwrap();
        println!(
            "[cap-probe] list_owned_blobs page: {} object(s), has_next={}",
            page.len(),
            next.is_some()
        );
        ids.extend(page.into_iter().map(|b| b.object_id));
        match next {
            Some(token) => cursor = Some(token),
            None => break,
        }
    }
    println!(
        "[cap-probe] total owned Blob objects for {owner}: {}",
        ids.len()
    );
    assert!(
        ids.len() >= 900,
        "expected the n900 cohort's owner to hold >=900 owned Blob objects before its execute phase, got {} \
         (a just-seeded cohort's read index may lag a few seconds — retry)",
        ids.len()
    );

    for size in [50usize, 200, 500, 1000] {
        let slice_len = size.min(ids.len());
        let slice = &ids[..slice_len];
        let started = Instant::now();
        let result = client.batch_get_objects(slice).await;
        let elapsed = started.elapsed();
        match result {
            Ok(objects) => {
                let resolved = objects.iter().filter(|o| o.is_some()).count();
                println!(
                    "[cap-probe] size={size} (actual {slice_len}) -> OK in {elapsed:?}, {resolved}/{slice_len} resolved"
                );
                assert_eq!(
                    objects.len(),
                    slice_len,
                    "BatchGetObjects returned a different count than requested at size={size}"
                );
            }
            Err(error) => panic!(
                "[cap-probe] size={size} (actual {slice_len}) -> ERROR in {elapsed:?}: {error}"
            ),
        }
    }
}
