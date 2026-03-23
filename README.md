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
  key: "your-delegate-key-hex",
  serverUrl: "https://your-memwal-server.com",
  namespace: "demo",
});

await memwal.remember("User prefers dark mode and uses TypeScript.");
const memories = await memwal.recall("What are the user's preferences?");
await memwal.restore("demo");
```

## Documentation

- Docs source of truth: `docs/`
- Docs site entry points:
  - [Overview](docs/about/what-is-memwal.md)
  - [Build Your First Integration](docs/getting-started/for-developers.md)
  - [SDK Overview](docs/sdk/overview.md)
  - [Relayer Overview](docs/relayer/overview.md)
  - [SDK API Reference](docs/reference/sdk-api.md)

## Contributing

We want to be explicit about this while MemWal is in beta: feedback, bug reports, docs fixes,
examples, and implementation contributions are all welcome.

If you spot rough edges or missing guidance, please open an issue or send a PR.

## Run the Repo Locally

From the repository root:

```bash
pnpm install
```

Then start the surface you need, for example:

```bash
pnpm dev:app
pnpm dev:noter
pnpm dev:chatbot
pnpm dev:researcher
```

For broader local setup guidance, see:

- [Run the Repo Locally](docs/contributing/run-repo-locally.md)

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

Apache 2.0
