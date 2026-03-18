# Usage

## Default Client: `MemWal`

Use `MemWal` when you want the relayer to handle the main workflow.

### `remember(text, namespace?)`

Stores text as memory through the relayer workflow.
If `namespace` is omitted, the SDK uses the config namespace.

### `recall(query, limit?, namespace?)`

Searches for similar memories and returns decrypted plaintext results for the owner and namespace.

### `analyze(text, namespace?)`

Sends longer text to the relayer, which extracts memorable facts and stores them as memories.

### `restore(namespace, limit?)`

Triggers incremental restore for a namespace. The relayer discovers blobs by owner and namespace,
compares them against local state, and re-indexes only missing entries.

### `health()`

Checks whether the relayer is reachable.

### `getPublicKeyHex()`

Returns the public key derived from the current delegate key.

## Manual Client: `MemWalManual`

Use `MemWalManual` when the client should control embedding calls and local SEAL operations,
while still relying on the relayer for registration, search, restore, and upload relay.

### `rememberManual(text, namespace?)`

Embeds and encrypts locally, then sends encrypted payload plus vector to the relayer for upload relay and registration.

### `recallManual(query, limit?, namespace?)`

Embeds locally, searches through the relayer, downloads blobs from Walrus, and decrypts them locally.

### `restore(namespace, limit?)`

Calls the same relayer restore endpoint for a namespace.

## AI Middleware: `withMemWal`

Use `withMemWal` when your app already uses the AI SDK and you want:

- memory recall before generation
- memory context injected into the prompt
- optional auto-save via `analyze()` after generation

## Important Beta Caveat

The source tree still contains some lower-level helper methods on `MemWal`. The clearest
supported beta paths in this repo are:

- `MemWal` for relayer-backed memory operations
- `MemWalManual` for full client-side manual flow
- `withMemWal` for AI middleware
