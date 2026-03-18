# System Overview

MemWal currently has these main components:

1. an application or dashboard
2. the TypeScript SDK
3. the Rust relayer backend
4. a TypeScript sidecar for SEAL and Walrus operations
5. PostgreSQL with pgvector
6. Walrus blob storage
7. the MemWal contract on Sui
8. the indexer for account sync

## System Diagram

```mermaid
%%{init: {
  "themeVariables": { "fontSize": "24px" },
  "flowchart": {
    "nodeSpacing": 70,
    "rankSpacing": 90,
    "padding": 30
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

- applications call the SDK with a delegate key
- the SDK signs each request
- the relayer verifies the delegate key against onchain account state
- the relayer stores and searches vectors by owner plus namespace
- the sidecar handles SEAL and Walrus-specific operations used by the backend
- Walrus stores encrypted payloads
- Sui anchors ownership and delegate authorization
- the indexer keeps account data synced into PostgreSQL for faster lookup

## High-Level Flow Diagram

```mermaid
%%{init: {
  "themeVariables": {
    "fontSize": "36px",
    "actorFontSize": "32px",
    "messageFontSize": "30px",
    "noteFontSize": "28px"
  },
  "sequence": {
    "width": 300,
    "height": 120,
    "messageMargin": 40,
    "actorMargin": 80
  }
}}%%
sequenceDiagram
    participant App as App
    participant SDK as SDK
    participant Relayer as Relayer
    participant Sidecar as Sidecar
    participant DB as PostgreSQL
    participant Walrus as Walrus
    participant Sui as Sui

    App->>SDK: Call MemWal API
    SDK->>Relayer: Signed request with delegate key
    Relayer->>Sui: Verify owner and account access
    Relayer->>DB: Store or search vectors
    Relayer->>Sidecar: SEAL / Walrus ops
    Sidecar->>Walrus: Upload/download blobs
    Sidecar-->>Relayer: Blob data / ID
    Relayer-->>SDK: API response
    SDK-->>App: Memory results
```

## Two Main Operating Modes

### Default SDK Mode

`MemWal` sends signed requests to the relayer and lets the backend handle most of the workflow.

### Full Client-Side Manual Mode

`MemWalManual` lets the client handle SEAL encryption, Walrus downloads, and embedding calls
directly while still using the relayer for registration and search.

## New Restore Shape

Restore is part of the architecture, not just an ops note. The relayer can:

1. discover blobs by owner and namespace from on-chain metadata
2. compare them against local vector state
3. restore only missing entries
4. re-embed and re-index incrementally

That makes the system more resilient when local vector state is incomplete.
