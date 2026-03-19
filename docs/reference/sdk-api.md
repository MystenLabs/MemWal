# SDK API Reference

See also:

- [Configuration](/reference/configuration)
- [Relayer API](/reference/relayer-api)

## `MemWal.create(config)`

```ts
MemWal.create(config: MemWalConfig): MemWal
```

Config:

| Property | Type | Notes |
| --- | --- | --- |
| `key` | `string` | Ed25519 private key in hex |
| `serverUrl?` | `string` | Relayer URL |
| `namespace?` | `string` | Default namespace, fallback is `"default"` |

For the full config surface, see [Configuration](/reference/configuration).

## `MemWal`

### `remember(text, namespace?)`

- Store one memory through the relayer
- Returns: `id`, `blob_id`, `owner`

### `recall(query, limit?, namespace?)`

- Search one owner-and-namespace boundary
- Returns plaintext matches

### `analyze(text, namespace?)`

- Extract memorable facts from text
- Stores each fact as memory

### `restore(namespace, limit?)`

- Rebuild missing indexed entries for one namespace
- Use when local vector state is incomplete

### `health()`

- Check relayer health

### `getPublicKeyHex()`

- Return the public key for the current delegate key

### Lower-Level `MemWal` Methods

- `rememberManual({ blobId, vector, namespace? })`
- `recallManual({ vector, limit?, namespace? })`
- `embed(text)`

These exist on the current SDK surface, but the main beta path is still `remember`, `recall`,
`analyze`, and `restore`.

## `MemWalManual`

Import:

```ts
import { MemWalManual } from "@cmdoss/memwal/manual";
```

Main methods:

- `rememberManual(text, namespace?)`
- `recallManual(query, limit?, namespace?)`
- `restore(namespace, limit?)`
- `isWalletMode`

Use this client when the app must handle embedding calls and local SEAL operations.

## `withMemWal`

Import:

```ts
import { withMemWal } from "@cmdoss/memwal/ai";
```

Use it to add:

- recall before generation
- memory context injection
- optional auto-save after generation

See [Configuration](/reference/configuration) for middleware options.
