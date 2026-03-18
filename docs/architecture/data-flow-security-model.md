# Data Flow Security Model

## Onchain

- account ownership
- delegate-key authorization
- policy-linked account model

## Offchain

- vector metadata in PostgreSQL
- blob storage in Walrus
- request verification and orchestration in the relayer
- embeddings and analysis workflow coordination in the relayer stack

## Encryption Boundary

- plaintext enters through the SDK + relayer workflow
- encrypted memory payloads are stored as blobs
- retrieval resolves matching blobs back into usable context for the caller

## Operational Note

The current docs describe the production beta model as implemented now, while leaving room for
future hardening such as TEE-focused deployment guidance.

That means this page should be read as a description of the current supported flow, not as a claim
that every future deployment will use exactly the same trust and runtime boundaries.
