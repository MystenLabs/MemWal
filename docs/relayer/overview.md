# Relayer Overview

The relayer is the backend service that turns signed SDK calls into memory operations.

## What It Does

- verifies delegate-key access against the onchain account model
- resolves owner and account context
- stores and searches vectors by owner plus namespace
- coordinates SEAL and Walrus operations through a sidecar
- powers `remember`, `recall`, `analyze`, `ask`, and `restore`

## Current Trust Boundary

The beta relayer is an active execution surface. It is not just a thin proxy.

In the default SDK path, the relayer currently participates in:

- embedding generation
- encryption and decryption orchestration
- Walrus upload and download orchestration
- fact extraction for `analyze`
- restore and re-index flows

That trust boundary should be documented plainly.

## Namespace-Aware Behavior

Namespace runs through the relayer's main storage and retrieval paths. The backend:

- stores vector entries by owner plus namespace
- writes namespace metadata to Walrus uploads
- uses namespace during restore discovery and re-indexing

## Restore Behavior

The current restore route is incremental:

1. query blobs for owner and namespace
2. compare them to local DB state
3. download and decrypt only missing blobs
4. re-embed and insert only the missing entries

## Public Routes

- `GET /health`

## Protected Routes

- `POST /api/remember`
- `POST /api/recall`
- `POST /api/remember/manual`
- `POST /api/recall/manual`
- `POST /api/analyze`
- `POST /api/ask`
- `POST /api/restore`
