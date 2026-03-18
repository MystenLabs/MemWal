# MemWal

Privacy-first AI memory SDK and protocol stack for storing encrypted memories on Walrus and
retrieving them with semantic search.

> MemWal is currently in beta. It is usable today, but the protocol, SDK, and operational
> surfaces may still evolve as we harden the system. The docs site is the primary source of
> truth for the supported integration path and current architecture, and contributions are very
> welcome as we improve the stack.

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
  key: "your-delegate-key-hex", // Ed25519 delegate key — get it from app.memwal.com
  serverUrl: "https://your-memwal-server.com",
});

// Store a memory
await memwal.remember("User prefers dark mode and uses TypeScript.");

// Retrieve relevant memories
const memories = await memwal.recall("What are the user's preferences?");
```

## Documentation

- Docs source of truth: `docs/`
- Docs site entry points:
  - [For Developers](docs/getting-started/for-developers.md)
  - [SDK Overview](docs/sdk/overview.md)
  - [Relayer Overview](docs/relayer/overview.md)
  - [SDK API Reference](docs/reference/sdk-api.md)

## Contributing

We want to be explicit about this while MemWal is in beta: feedback, bug reports, docs fixes,
examples, and implementation contributions are all welcome.

If you spot rough edges or missing guidance, please open an issue or send a PR.

## Run Docs Locally

From the repository root:

```bash
pnpm install
pnpm dev:docs
```

For broader local setup guidance, see:

- [Run the Repo Locally](docs/contributing/run-repo-locally.md)

## Exports

| Entry | Description |
|---|---|
| `@cmdoss/memwal` | Default client (`MemWal`). The relayer handles embedding, SEAL encryption, Walrus upload/download, and decryption. |
| `@cmdoss/memwal/manual` | Manual mode (`MemWalManual`). You handle embedding calls and local SEAL operations. The relayer still handles upload relay, registration, search, and restore. |
| `@cmdoss/memwal/ai` | Vercel AI SDK integration — wraps `MemWal` as middleware for use with `streamText`, `generateText`, etc. |

## How It Works

1. **Send** — Text is sent to the relayer
2. **Store** — Server embeds → encrypts with SEAL → uploads to Walrus; vector stored with pgvector
3. **Recall** — Query is embedded, similar memories fetched, decrypted by the relayer flow, and returned as plaintext

## License

Apache 2.0
