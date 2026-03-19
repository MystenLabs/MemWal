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

MemWal is in beta. It works today, but the protocol, SDK, and relayer flow may still change as the
system hardens. Feedback and contributions are welcome.

## What You Get

- **SDK**: `MemWal`, `MemWalManual`, and `withMemWal`
- **Relayer**: signed API for memory workflows
- **Contract**: owner and delegate-key model on Sui
- **Indexer**: account sync into PostgreSQL
- **Walrus + SEAL**: encrypted blob storage plus access workflow

## Start Here

- New to MemWal: [Getting Started](/getting-started/for-developers)
- Need the mental model: [Explain MemWal](/concepts/explaining-memwal)
- Integrating the SDK: [SDK Overview](/sdk/overview)
- Running the backend: [Relayer Overview](/relayer/overview)
- Looking for APIs: [SDK API Reference](/reference/sdk-api)

## Core Ideas

- **Namespace**: isolate memory by app, tenant, or environment
- **Owner + Namespace**: the main storage and retrieval boundary
- **Default Path**: use `MemWal` with a relayer first
- **Manual Path**: use `MemWalManual` when the client must handle embeddings and local SEAL work
- **Restore**: rebuild missing indexed entries for one namespace
