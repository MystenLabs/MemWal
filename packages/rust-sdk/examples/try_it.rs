//! Manual smoke test: run against a relayer you already have up (local or staging).
//!
//! cargo run --example try_it -- <32-byte-hex-key> <account_id> <server_url> <namespace>
use memwal_client::MemWalClient;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let key_hex = args.get(1).expect("arg1: 64-hex-char delegate key");
    let account_id = args.get(2).expect("arg2: account id");
    let server_url = args.get(3).expect("arg3: server url, e.g. http://localhost:3001");
    let namespace = args.get(4).map(String::as_str).unwrap_or("try-it");

    let key_bytes = hex::decode(key_hex).expect("key must be hex");
    let key: [u8; 32] = key_bytes.try_into().expect("key must be 32 bytes");

    let client = MemWalClient::new(&key, account_id, server_url, namespace);

    println!("[*] check_compatibility...");
    match client.check_compatibility().await {
        Ok(()) => println!("    OK"),
        Err(e) => println!("    FAILED: {e}"),
    }

    println!("[*] remember...");
    match client.remember("The sky is blue on a clear day.", None).await {
        Ok(r) => println!("    accepted: {:?}", r),
        Err(e) => println!("    FAILED: {e}"),
    }
}
