# Security Model

## Authentication

The SDK signs requests with an Ed25519 delegate key. The relayer verifies that the public key
belongs to a delegate registered for the user's MemWal account.

In the current backend, request verification is based on a message shaped like:

`{timestamp}.{method}.{path}.{body_sha256}`

## Encryption Boundary

Memory payloads are stored as encrypted blobs on Walrus. The relayer handles the workflow that
turns user text into encrypted storage and later turns matching blobs back into usable context.

## Beta Trust Assumptions

The current beta design is practical and developer-friendly, but it still requires operators and
integrators to understand the relayer trust boundary. The docs call this out clearly rather than
hiding it behind generic “private by default” language.

## What To Communicate Clearly

When describing MemWal to developers or partners, we should be explicit about:

- who owns the account model
- what the delegate key can do
- what the relayer handles today
- which parts of the design are protocol-level versus operator-level
