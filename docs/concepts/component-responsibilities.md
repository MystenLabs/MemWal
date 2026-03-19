---
title: "Component Responsibilities"
---

## SDK

- signs requests with a delegate key
- carries the default namespace
- exposes `MemWal`, `MemWalManual`, and `withMemWal`

## Relayer

- verifies delegate access
- resolves owner and account context
- runs `remember`, `recall`, `analyze`, `ask`, and `restore`
- stores and searches vectors by `owner + namespace`

## Sidecar

- performs backend SEAL operations
- uploads blobs to Walrus
- discovers blobs and metadata for restore flows

## Contract

- defines ownership and delegate authorization onchain

## Indexer

- listens for account events
- syncs account data into PostgreSQL

## Storage

- Walrus stores encrypted blobs
- PostgreSQL stores searchable vector metadata and caches
