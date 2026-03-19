# Installation

## Default SDK

```bash
pnpm add @cmdoss/memwal
```

This is the recommended beta entry point.

## Optional Packages

Only install these if you need the related surface:

```bash
pnpm add ai
```

- `ai` is for `@cmdoss/memwal/ai`

For the manual client flow:

```bash
pnpm add @mysten/sui @mysten/seal @mysten/walrus
```

## Minimum Config

- `key`: delegate private key in hex
- `serverUrl`: relayer URL
- `namespace`: defaults to `"default"`

```ts
import { MemWal } from "@cmdoss/memwal";

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  serverUrl: process.env.MEMWAL_SERVER_URL,
  namespace: process.env.MEMWAL_NAMESPACE ?? "demo",
});
```

## Package Surfaces

- `@cmdoss/memwal`: default client
- `@cmdoss/memwal/manual`: manual client flow
- `@cmdoss/memwal/ai`: AI middleware
