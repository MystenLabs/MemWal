---
title: "Overview"
---

The relayer is the backend that turns SDK calls into memory operations. Using a delegate key signed by the client, it handles the critical workflows — embedding, encryption, storage, and search — on behalf of the user.

## What It Does

- **authenticates requests** by verifying Ed25519 signatures against onchain delegate keys, then resolving the owner and account context
- **generates embeddings** for text so it can be stored and searched semantically
- **encrypts and decrypts** data through the SEAL sidecar, bound to the owner's address
- **uploads and downloads** encrypted blobs to Walrus, with the server wallet covering storage costs
- **stores and searches vectors** in PostgreSQL (pgvector), scoped by Memory Space
- **orchestrates higher-level flows** like `analyze` (LLM-based fact extraction) and `ask` (memory-augmented Q&A)
- **restores Memory Spaces** by querying onchain blobs, decrypting, re-embedding, and re-indexing anything missing from the local DB

## Single-Instance Design

Each relayer deployment is tied to a single MemWal package ID (`MEMWAL_PACKAGE_ID`). The package ID is used for SEAL encryption key derivation and Walrus blob metadata, but is not used to partition data in the vector database — queries are scoped by `owner + namespace` only.

<Note>
The current relayer does not support multi-tenancy across multiple package IDs. If you deploy a separate MemWal contract, you need to run a separate relayer instance with its own database.
</Note>

## Trust Boundary

In the default SDK path, the relayer sees plaintext data because it handles encryption and embedding on your behalf. This is a deliberate trade-off for developer experience — it means Web2 developers don't need to manage cryptographic operations.

If you need to minimize this trust, you can [self-host](/relayer/self-hosting) the relayer or use the [manual client flow](/sdk/usage) to handle encryption and embedding entirely on the client side. See [Trust & Security Model](/fundamentals/architecture/data-flow-security-model) for the full breakdown.
