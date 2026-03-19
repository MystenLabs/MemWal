---
title: "Relayer Overview"
---

The relayer turns signed SDK calls into memory operations.

## What It Does

- verifies delegate-key access
- resolves owner and account context
- stores and searches vectors by `owner + namespace`
- coordinates SEAL and Walrus operations through the sidecar
- runs `remember`, `recall`, `analyze`, `ask`, and `restore`
- uses env-driven network config for RPC, Walrus, and SEAL sidecar behavior

## Trust Boundary

In the default SDK path, the relayer sees plaintext data because it handles encryption and embedding on your behalf. This is a deliberate trade-off for developer experience — it means Web2 developers don't need to manage cryptographic operations.

The relayer currently handles:

- embedding generation
- encryption and decryption orchestration
- Walrus upload and download orchestration
- fact extraction for `analyze`
- restore and re-index flows

If you need to minimize this trust, you can [self-host](/relayer/self-hosting) the relayer or use the [manual client flow](/sdk/usage) to handle encryption and embedding entirely on the client side. See [Trust & Security Model](/fundamentals/architecture/data-flow-security-model) for the full breakdown.

## Network and Sidecar Config

- the relayer now defaults to `mainnet` network settings
- `SUI_NETWORK` drives the default RPC URL and Walrus service endpoints
- `SEAL_KEY_SERVERS` tells the sidecar which SEAL key server objects to use
- self-hosted deployments can override Walrus package and upload relay defaults through env vars

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
