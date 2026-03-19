# Overview

MemWal is a beta protocol and SDK stack for private, user-owned AI memory.

## In One View

- apps integrate through a TypeScript SDK
- requests are signed with an Ed25519 delegate key
- a relayer runs the memory workflow
- encrypted payloads live on Walrus
- ownership and delegate authorization live on Sui

## What Problem It Solves

MemWal is for apps that need memory without turning one operator-owned database into the entire
ownership, storage, and access model.

## What MemWal Splits Apart

- **Ownership**: Sui account model
- **Storage**: encrypted Walrus blobs
- **Search**: PostgreSQL + pgvector
- **Access**: SDK + relayer

## What You Get

- SDK surfaces: `MemWal`, `MemWalManual`, `withMemWal`
- relayer-backed memory workflows
- onchain account and delegate-key model
- indexer support for fast owner/account lookup

## Read Next

- [Product Status](/about/product-status)
- [Core Components](/about/core-components)
- [Build Your First Integration](/getting-started/for-developers)
