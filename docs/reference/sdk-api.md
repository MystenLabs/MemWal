# SDK API Reference

## `MemWal.create(config)`

```ts
MemWal.create(config: MemWalConfig): MemWal
```

### `MemWalConfig`

| Property | Type | Description |
| --- | --- | --- |
| `key` | `string` | Ed25519 private key in hex |
| `serverUrl?` | `string` | Relayer URL, defaults to `http://localhost:8000` |
| `namespace?` | `string` | Default namespace, defaults to `"default"` |

## Default Client Methods

### `remember(text, namespace?)`

Store text as memory through the relayer workflow.

### `recall(query, limit?, namespace?)`

Search for similar memories and return plaintext results.

### `analyze(text, namespace?)`

Extract memorable facts from text and store them as memories.

### `restore(namespace, limit?)`

Incrementally restore missing entries for a namespace.

### `health()`

Check relayer health.

### `getPublicKeyHex()`

Return the derived public key as hex.

## Manual Client

Import:

```ts
import { MemWalManual } from "@cmdoss/memwal/manual";
```

High-level methods:

- `rememberManual(text, namespace?)`
- `recallManual(query, limit?, namespace?)`
- `restore(namespace, limit?)`

Use this client when embedding calls and local SEAL handling should happen client-side, while the
relayer still handles registration, search, restore, and upload relay.

## AI Integration

Use `withMemWal` from `@cmdoss/memwal/ai` to wrap an AI SDK model with recall-before-generation
and optional auto-save behavior.

## Beta Caveat

The source tree still contains some lower-level helper APIs beyond the main flows above.
For external docs, the primary supported surfaces in this repo are:

- `MemWal`
- `MemWalManual`
- `withMemWal`
