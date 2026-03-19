---
title: "System Overview"
---

MemWal has eight main pieces:

1. app or dashboard
2. TypeScript SDK
3. Rust relayer
4. TypeScript sidecar
5. PostgreSQL + pgvector
6. Walrus
7. Sui contract
8. indexer

## System Diagram

```mermaid
%%{init: {
  "themeVariables": { "fontSize": "24px" },
  "flowchart": {
    "nodeSpacing": 82,
    "rankSpacing": 105,
    "padding": 40
  }
}}%%
flowchart TD
    App[App or Dashboard]
    SDK[MemWal SDK]
    Relayer[Rust Relayer]
    Sidecar[TS Sidecar]
    DB[(PostgreSQL + pgvector)]
    Walrus[Walrus Blobs]
    Sui[Sui + MemWal Contract]
    Indexer[Indexer]

    App --> SDK
    SDK --> Relayer
    Relayer --> Sidecar
    Relayer --> DB
    Sidecar --> Walrus
    Sidecar --> Sui
    Sui --> Indexer
    Indexer --> DB
```

## High-Level Flow

- app calls the SDK
- SDK signs the request
- relayer verifies delegate access onchain
- relayer stores and searches vectors by `owner + namespace`
- sidecar handles backend SEAL and Walrus work
- indexer keeps account data synced into PostgreSQL

## High-Level Flow Diagram

```mermaid
%%{init: {
  "themeVariables": { "fontSize": "28px" },
  "flowchart": {
    "nodeSpacing": 82,
    "rankSpacing": 110,
    "padding": 42
  }
}}%%
flowchart TD
    App["1. App calls<br/>the SDK"]
    SDK["2. SDK signs<br/>the request"]
    Verify["3. Relayer verifies<br/>delegate access"]
    Search["4. Relayer stores<br/>or searches vectors"]
    Sidecar["5. Sidecar handles<br/>SEAL and Walrus"]
    Walrus["6. Walrus stores<br/>or returns blobs"]
    Result["7. Relayer returns<br/>results to the app"]
    Sui["Sui account<br/>model"]
    DB["PostgreSQL +<br/>pgvector"]

    App --> SDK --> Verify --> Search --> Sidecar --> Walrus --> Result
    Verify -. checks .-> Sui
    Search -. uses .-> DB
    Result --> App
```

## Operating Modes

### Default SDK

`MemWal` lets the relayer handle embedding, encryption, retrieval, and restore.

### Manual Client Flow

`MemWalManual` lets the client handle embeddings and local SEAL operations. The relayer still
handles upload relay, registration, search, and restore.

## Restore

Restore is part of the system design, not just an ops note:

1. discover blobs by owner and namespace
2. compare with local vector state
3. restore only missing entries
