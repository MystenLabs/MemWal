# @mysten-incubation/memwal

Privacy-first AI memory SDK for storing encrypted memories on Walrus and retrieving them with semantic search.

> MemWal is currently in beta and actively evolving. While fully usable today, we continue to refine the developer experience and operational guidance. We welcome feedback from early builders as we continue to improve the product.

## Documentation

For full documentation, visit [docs.memwal.ai](https://docs.memwal.ai).

## Install

```bash
pnpm add @mysten-incubation/memwal
```

Peer dependencies (install as needed):

```bash
pnpm add @mysten/sui @mysten/seal @mysten/walrus ai zod
```

## Quick Start

```ts
import { MemWal } from "@mysten-incubation/memwal";

const memwal = MemWal.create({
  key: "your-delegate-key-hex",
  accountId: "your-memwal-account-id",
  serverUrl: "https://your-relayer-url.com",
  namespace: "demo",
});

await memwal.remember("User prefers dark mode and uses TypeScript.");
const memories = await memwal.recall("What are the user's preferences?");
await memwal.restore("demo");
```

If you are self-hosting the relayer and do not have an account ID yet, see [Self-Hosting](../../docs/relayer/self-hosting.md) for the account creation and delegate key setup flow.

## Exports

| Entry | Description |
|---|---|
| `@mysten-incubation/memwal` | Default client (`MemWal`). The relayer handles embedding, encryption, Walrus upload/download, retrieval, and restore. |
| `@mysten-incubation/memwal/manual` | Manual client flow (`MemWalManual`). You handle embedding calls and local SEAL operations. The relayer still handles upload relay, registration, search, and restore. |
| `@mysten-incubation/memwal/ai` | Vercel AI SDK integration - wraps `MemWal` as middleware for use with `streamText`, `generateText`, etc. |

## How It Works

1. **Scope** - Each memory operation runs inside an `owner + namespace` boundary
2. **Store** - The relayer embeds, encrypts, uploads to Walrus, and stores vector metadata in PostgreSQL
3. **Recall** - The relayer searches by owner plus namespace, resolves matching blobs, and returns plaintext results
4. **Restore** - The relayer can incrementally rebuild missing indexed entries for one namespace

## License

Apache 2.0 — see [LICENSE](../../LICENSE)
