---
layout: home

hero:
  name: MemWal
  text: Privacy-Preserving AI Memory
  tagline: Beta protocol for private, user-owned AI memory on Sui and Walrus
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/for-developers
    - theme: alt
      text: Learn the Concepts
      link: /concepts/explaining-memwal
    - theme: alt
      text: View on GitHub
      link: https://github.com/CommandOSSLabs/personal-data-wallet
---

## Beta Notice

MemWal is currently released as a **beta**. The docs focus on the supported path for
integrating the SDK, using the relayer, and understanding the protocol design as it
exists in this repository today.

We want to emphasize that this means the system works and is ready to evaluate, but it may
still have bugs, rough edges, or evolving operational guidance. Feedback and contributions are
very welcome while we harden the protocol and developer experience.

## What MemWal Includes

- **SDK**: Delegate-key clients for relayer-backed memory and full client-side manual flow
- **Relayer Backend**: Signed API that verifies access, enforces namespace boundaries, and runs memory workflows
- **Smart Contract**: Onchain account and delegate-key model on Sui
- **Indexer**: Event listener that syncs onchain account data into PostgreSQL for fast lookup
- **Walrus + SEAL**: Encrypted blob storage and access control for memory payloads, including restore discovery by metadata

## Start Here

- New to MemWal: [Getting Started](/getting-started/for-developers)
- Need the mental model: [Explain MemWal](/concepts/explaining-memwal)
- Integrating the SDK: [SDK Overview](/sdk/overview)
- Running the backend: [Relayer Overview](/relayer/overview)
- Looking for APIs: [SDK API Reference](/reference/sdk-api)

## Features

- **Encrypted Storage**: Memory payloads are stored as encrypted blobs on Walrus
- **Semantic Recall**: Query memories by meaning instead of exact keywords
- **Namespaces**: Isolate memory by product or context instead of one flat pool
- **Incremental Restore**: Re-index missing namespace entries from Walrus metadata and blob state
- **Delegate Keys**: Lightweight keys for app access without exposing the owner's wallet
- **Protocol Components**: SDK, relayer, smart contract, and indexer work together as one stack
