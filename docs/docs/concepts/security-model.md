# Security Model

## Authentication

- the SDK signs requests with an Ed25519 delegate key
- the relayer verifies that key against the onchain MemWal account model
- request verification uses a signed `{timestamp}.{method}.{path}.{body_sha256}` message

## Storage Boundary

- plaintext enters through the SDK and relayer workflow
- encrypted payloads are stored on Walrus
- searchable vector metadata is stored in PostgreSQL

## What To Communicate Clearly

- who owns the account model
- what the delegate key can do
- what the relayer handles today
- which parts are protocol-level versus operator-level
