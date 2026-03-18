# Component Responsibilities

## SDK

- signs requests with an Ed25519 delegate key
- carries the default namespace for memory isolation
- exposes the default `MemWal` client, the `MemWalManual` client, and AI middleware
- does not own the user's onchain account model

## Relayer

- verifies delegate-key access
- resolves owner and account context
- stores and searches vectors by owner plus namespace
- runs `remember`, `recall`, `analyze`, `ask`, and `restore`
- starts a TypeScript sidecar for SEAL and Walrus-related operations

## Sidecar

- performs backend SEAL encrypt and decrypt calls
- uploads blobs to Walrus
- queries owner blob objects and namespace metadata from chain
- supports restore flows that need blob discovery outside the local DB

## Smart Contract

- defines ownership and delegate-key authorization onchain
- anchors the account model independently from the SDK and relayer

## Indexer

- listens for account events
- syncs onchain account data into PostgreSQL
- helps the relayer resolve ownership quickly without repeated full chain scans

## Walrus and SEAL

- Walrus stores encrypted blobs
- SEAL provides the encryption and decryption model
- Walrus metadata contributes to restore and namespace discovery

## PostgreSQL and pgvector

- stores vector entries used for semantic search
- stores owner plus namespace mappings to blob IDs
- stores cached account and delegate data
- supports incremental restore decisions by comparing local and on-chain state
