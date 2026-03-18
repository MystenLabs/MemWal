# What Is MemWal?

MemWal is a **beta protocol and SDK stack for private, user-owned AI memory** on Sui and Walrus.
It gives developers a practical way to add long-term memory to applications while keeping
ownership, access, and storage as separate concerns instead of collapsing everything into a
single centralized memory database.

In the current stack:

- applications talk to MemWal through a TypeScript SDK
- requests are authenticated with an Ed25519 delegate key
- a relayer verifies access and runs the memory workflow
- memory payloads are stored as encrypted blobs on Walrus
- account ownership and delegate authorization live on Sui

## What Problem It Solves

AI products increasingly need a memory layer that can:

- remember user preferences and facts across sessions
- retrieve relevant memories by meaning, not exact keyword match
- let users keep a clear ownership model for their memory account
- give developers an API that is simple enough to ship with today

Most memory systems solve this by storing everything in one operator-controlled database. MemWal
takes a different approach:

- memory payloads live in Walrus as encrypted blobs
- vector metadata and search live in PostgreSQL with pgvector
- ownership and delegate access live on Sui
- the relayer provides a practical API for embedding, retrieval, and analysis flows

## Who It Is For

- teams building AI-native apps that need persistent user memory
- agent frameworks that need a memory layer with clear ownership boundaries
- developers who want an SDK-first integration path before self-hosting infrastructure

## What You Get

At the product level, MemWal gives you:

- a developer SDK with `remember`, `recall`, `embed`, `analyze`, and AI middleware integration
- a relayer backend that verifies signed requests and runs the memory workflow
- an onchain account model for ownership and delegate keys
- an indexer that keeps account lookup fast for the backend

## What This Documentation Covers

These docs are opinionated toward the supported beta path:

1. understand the protocol and trust model
2. integrate the SDK with a relayer
3. use the public relayer first
4. self-host the relayer when you need more operational control

## Read Next

- [Product Status](/about/product-status)
- [Core Components](/about/core-components)
- [For Developers](/getting-started/for-developers)
