---
title: "Purpose"
description: >-
  Why the Walrus Memory indexer exists, how it eliminates expensive onchain RPC calls
  by syncing account data to PostgreSQL, and the auth resolution priority flow.
keywords:
  - Walrus Memory
  - MemWal
  - indexer
  - purpose
  - auth resolution
  - PostgreSQL
goal:
  description: Explain why the indexer exists, trace the auth resolution priority chain the relayer uses to look up delegate key ownership, and predict what happens if the indexer falls behind.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 300
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - "Why does Walrus Memory need an indexer?"
  - "How does the MemWal relayer resolve delegate key ownership?"
  - "How do I configure and run the MemWal indexer?"
answer: >-
  The indexer listens to Sui events and records which owner has an account.
  Delegate-key authentication does not scan AccountRegistry. A cold key needs
  x-account-id or MEMWAL_ACCOUNT_ID. A key already cached resolves without either.
---

The indexer keeps the backend in sync with onchain state so the relayer can resolve accounts quickly.

## Why It Exists

Delegate-key authentication does not walk `AccountRegistry`. A cold key is verified against the signed `x-account-id`, or against `MEMWAL_ACCOUNT_ID` when that env is set. The indexer is what fills the `accounts` table the existence check and owner-token lookup read.

## How It Works

The indexer is a standalone Rust service (`services/indexer`) that:

1. Connects to the same PostgreSQL database as the relayer
2. Polls Sui blockchain events using `suix_queryEvents`
3. Filters for `AccountCreated` events from the Walrus Memory package
4. Inserts `account_id → owner` mappings into the `accounts` table
5. Stores its event cursor in `indexer_state` so it can resume after restarts

## Auth Resolution Flow

When the relayer receives a signed request, it resolves the delegate key's account in this order:

1. **PostgreSQL cache** (`delegate_key_cache`) — populated after a successful resolution
2. **Signed `x-account-id`**, or **`MEMWAL_ACCOUNT_ID`** when the header is absent — one account object, not a registry walk
3. Otherwise **`401`**. A cold key with no account id is not looked up onchain

After a successful resolution, the mapping is cached in `delegate_key_cache`. The indexed `accounts` table is not part of this chain.

## Configuration

The indexer reads these environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `MEMWAL_PACKAGE_ID` | Yes | — | Walrus Memory contract package ID to filter events |
| `SUI_RPC_URL` | No | Mainnet fullnode | Sui RPC endpoint |
| `POLL_INTERVAL_SECS` | No | `5` | Seconds between event poll cycles |

## Running

```bash
cd services/indexer
cargo run
```

The indexer is recommended for production but optional for development — the relayer can fall back to onchain resolution without it.
