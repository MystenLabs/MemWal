# Relayer Overview

The relayer turns signed SDK calls into memory operations.

## What It Does

- verifies delegate-key access
- resolves owner and account context
- stores and searches vectors by `owner + namespace`
- coordinates SEAL and Walrus operations through the sidecar
- runs `remember`, `recall`, `analyze`, `ask`, and `restore`

## Current Trust Boundary

In the default SDK path, the relayer currently handles:

- embedding generation
- encryption and decryption orchestration
- Walrus upload and download orchestration
- fact extraction for `analyze`
- restore and re-index flows

## Namespace Behavior

- vector entries are stored by `owner + namespace`
- Walrus uploads carry `memwal_namespace` metadata
- restore runs one namespace at a time

Namespace is recorded onchain through Walrus blob metadata during upload. It is not a separate
MemWal contract object.

## Restore Behavior

Restore is incremental:

1. query blobs for one owner and namespace
2. compare with local DB state
3. restore only missing entries

## Routes

- `GET /health`
- `POST /api/remember`
- `POST /api/recall`
- `POST /api/remember/manual`
- `POST /api/recall/manual`
- `POST /api/analyze`
- `POST /api/ask`
- `POST /api/restore`
