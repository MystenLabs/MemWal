# Installation

## Default SDK

Install the relayer-backed SDK:

```bash
pnpm add @cmdoss/memwal
```

This is the recommended beta entry point for most teams.

## Optional Packages

Only add these when you need the related surface:

```bash
pnpm add ai
```

- `ai` is needed for `@cmdoss/memwal/ai`

For the full client-side manual flow, also install:

```bash
pnpm add @mysten/sui @mysten/seal @mysten/walrus
```

Those packages are for `@cmdoss/memwal/manual`, where the client handles SEAL and Walrus directly.

## Minimum Configuration

The default SDK needs:

- `key`: an Ed25519 delegate private key in hex
- `serverUrl`: the relayer URL, unless you use the local default
- `namespace`: recommended, defaults to `"default"`

```ts
import { MemWal } from "@cmdoss/memwal";

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  serverUrl: process.env.MEMWAL_SERVER_URL,
  namespace: process.env.MEMWAL_NAMESPACE ?? "demo",
});
```

## Local Default

If `serverUrl` is omitted, the SDK defaults to `http://localhost:8000`.

## Package Surfaces

- `@cmdoss/memwal`: default relayer-backed client
- `@cmdoss/memwal/manual`: full client-side manual flow
- `@cmdoss/memwal/ai`: AI SDK middleware integration

## Recommended Install Order

1. install `@cmdoss/memwal`
2. configure delegate key, relayer URL, and namespace
3. validate `health()`, `remember()`, and `recall()`
4. add manual mode or AI middleware only if your use case needs them
