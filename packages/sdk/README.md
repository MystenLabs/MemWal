# @cmdoss/memwal

Privacy-first AI memory SDK. Stores encrypted memories on Walrus (decentralized storage) and
retrieves them via semantic search.

> MemWal is currently in beta. It works today, but rough edges and operational guidance may still
> evolve. Feedback and contributions are welcome while we harden the protocol and developer
> experience.

## Install

```bash
pnpm add @cmdoss/memwal
```

Peer dependencies (install as needed):

```bash
pnpm add @mysten/sui @mysten/seal @mysten/walrus ai zod
```

## Quick Start

```ts
import { MemWal } from "@cmdoss/memwal";

const memwal = MemWal.create({
  key: "your-delegate-key-hex",
  serverUrl: "https://your-memwal-server.com",
  namespace: "demo",
});

await memwal.remember("User prefers dark mode and uses TypeScript.");
const memories = await memwal.recall("What are the user's preferences?");
await memwal.restore("demo");
```

## Exports

| Entry | Description |
|---|---|
| `@cmdoss/memwal` | Default client (`MemWal`). The relayer handles embedding, encryption, Walrus upload/download, retrieval, and restore. |
| `@cmdoss/memwal/manual` | Manual client flow (`MemWalManual`). You handle embedding calls and local SEAL operations. The relayer still handles upload relay, registration, search, and restore. |
| `@cmdoss/memwal/ai` | Vercel AI SDK integration - wraps `MemWal` as middleware for use with `streamText`, `generateText`, etc. |

## How It Works

1. **Scope** - Each memory operation runs inside an `owner + namespace` boundary
2. **Store** - The relayer embeds, encrypts, uploads to Walrus, and stores vector metadata in PostgreSQL
3. **Recall** - The relayer searches by owner plus namespace, resolves matching blobs, and returns plaintext results
4. **Restore** - The relayer can incrementally rebuild missing indexed entries for one namespace

## License

MIT
