//! End-to-end smoke test against a live relayer.
//!
//! ```bash
//! export WALRUS_MEMORY_PRIVATE_KEY=<64-hex ed25519 delegate key>
//! export WALRUS_MEMORY_ACCOUNT_ID=0x<...>
//! export WALRUS_MEMORY_ENV=prod   # prod | staging | dev | local (optional, default: prod)
//! export WALRUS_MEMORY_SERVER_URL=...   # optional explicit override, wins over WALRUS_MEMORY_ENV
//! export WALRUS_MEMORY_NAMESPACE=demo   # optional
//! cargo run --example quick_start
//! ```
//!
//! Env presets: `prod` → relayer.memory.walrus.xyz, `staging` →
//! relayer-staging.memory.walrus.xyz, `dev` → relayer.dev.memwal.ai (legacy
//! pre-WALM-86 domain), `local` → http://127.0.0.1:8000. A delegate key only
//! works against the relayer it was registered on — pick the matching env
//! rather than relying on the default.

use std::env;

use walrus_memory::{Env, RecallParams, WaitOptions, WalrusMemory};

fn parse_env(raw: &str) -> Option<Env> {
    match raw.to_ascii_lowercase().as_str() {
        "prod" => Some(Env::Prod),
        "staging" => Some(Env::Staging),
        "dev" => Some(Env::Dev),
        "local" => Some(Env::Local),
        _ => None,
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let key = env::var("WALRUS_MEMORY_PRIVATE_KEY").expect("set WALRUS_MEMORY_PRIVATE_KEY");
    let account_id = env::var("WALRUS_MEMORY_ACCOUNT_ID").expect("set WALRUS_MEMORY_ACCOUNT_ID");
    let namespace = env::var("WALRUS_MEMORY_NAMESPACE").unwrap_or_else(|_| "demo".to_string());

    let mut builder = WalrusMemory::builder(key, account_id).namespace(namespace);
    builder = match env::var("WALRUS_MEMORY_SERVER_URL") {
        Ok(url) => builder.server_url(url),
        Err(_) => {
            let env_name = env::var("WALRUS_MEMORY_ENV").unwrap_or_else(|_| "prod".to_string());
            let preset = parse_env(&env_name).unwrap_or_else(|| {
                panic!("unknown WALRUS_MEMORY_ENV {env_name:?} (expected prod|staging|dev|local)")
            });
            println!(
                "no WALRUS_MEMORY_SERVER_URL set — using WALRUS_MEMORY_ENV={env_name} ({})",
                preset.server_url()
            );
            builder.env(preset)
        }
    };
    let client = builder.build()?;

    println!("delegate public key: {}", client.public_key_hex());
    println!("relayer: {}", client.server_url());

    let health = client.health().await?;
    println!("relayer health: {}", health.status);

    println!("\ncompatibility check …");
    match client.compatibility().await {
        Ok(()) => println!("  OK"),
        Err(e) => println!("  {e}"),
    }

    println!("\nremember + wait …");
    let stored = client
        .remember_and_wait(
            "I live in Hanoi and prefer dark mode and TypeScript.",
            None,
            WaitOptions::default(),
        )
        .await?;
    println!("  stored blob {} (owner {})", stored.blob_id, stored.owner);

    println!("\nrecall …");
    let hits = client
        .recall(RecallParams::new("What are the user's preferences?").limit(5))
        .await?;
    println!("  {} result(s):", hits.total);
    for m in &hits.results {
        println!("    relevance {:.3}  {}", 1.0 - m.distance, m.text);
    }

    println!("\nask …");
    let answer = client
        .ask("Where does the user live?", Some(5), None)
        .await?;
    println!("  {}", answer.answer);

    Ok(())
}
