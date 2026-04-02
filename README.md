# MemWal

Privacy-first AI memory layer for storing encrypted memories on Walrus and
retrieving them with semantic search.

> MemWal is currently in beta and actively evolving. While fully usable today, we continue to refine the developer experience and operational guidance. We welcome feedback from early builders as we continue to improve the product.

## For AI Agents

- **Single-file guide**: Read [`SKILL.md`](SKILL.md) for a complete integration reference (install, configure, API surface, troubleshooting)
- **LLM-friendly docs**: [`llms.txt`](https://docs.memwal.ai/llms.txt) — structured overview following the [llmstxt.org](https://llmstxt.org) standard
- **Full context**: [`llms-full.txt`](https://docs.memwal.ai/llms-full.txt) — expanded version with inlined page content

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

## Documentation

- Full docs at [docs.memwal.ai](https://docs.memwal.ai)
- Docs source of truth: `docs/`
- Docs site entry points:
  - [What is MemWal?](docs/getting-started/what-is-memwal.md)
  - [Quick Start](docs/getting-started/quick-start.md)
  - [SDK Quick Start](docs/sdk/quick-start.md)
  - [Relayer Overview](docs/relayer/overview.md)
  - [SDK API Reference](docs/sdk/api-reference.md)

## Contributing

We want to be explicit about this while MemWal is in beta: feedback, bug reports, docs fixes,
examples, and implementation contributions are all welcome.

If you spot rough edges or missing guidance, please open an issue or send a PR.

## Run the Repo Locally

From the repository root:

```bash
pnpm install
```

> **Important**: Build the SDK first — apps depend on its compiled output.

```bash
pnpm build:sdk
```

Then start the surface you need:

```bash
pnpm dev:app
pnpm dev:noter
pnpm dev:chatbot
pnpm dev:researcher
```

For the full step-by-step setup guide, see:

- [Run the Repo Locally](docs/contributing/run-repo-locally.md)

## Exports

| Entry | Description |
|---|---|
| `@mysten-incubation/memwal` | Default client (`MemWal`). The relayer handles embedding, encryption, Walrus upload/download, retrieval, and restore. |
| `@mysten-incubation/memwal/manual` | Manual client flow (`MemWalManual`). You handle embedding calls and local SEAL operations. The relayer still handles upload relay, registration, search, and restore. |
| `@mysten-incubation/memwal/ai` | Vercel AI SDK integration - wraps `MemWal` as middleware for use with `streamText`, `generateText`, etc. |

## OpenClaw / NemoClaw Plugin

[`@mysten-incubation/oc-memwal`](packages/openclaw-memory-memwal) — a memory plugin for [OpenClaw](https://openclaw.ai) agents. It gives OpenClaw persistent, encrypted memory via MemWal with automatic recall and capture hooks.

```bash
openclaw plugins install @mysten-incubation/oc-memwal
```

- [Plugin Quick Start](docs/openclaw/quick-start.md)
- [How It Works](docs/openclaw/how-it-works.md)
- [Reference](docs/openclaw/reference.md)

## How It Works

1. **Scope** - Each memory operation runs inside an `owner + namespace` boundary
2. **Store** - The relayer embeds, encrypts, uploads to Walrus, and stores vector metadata in PostgreSQL
3. **Recall** - The relayer searches by owner plus namespace, resolves matching blobs, and returns plaintext results
4. **Restore** - The relayer can incrementally rebuild missing indexed entries for one namespace

## License

Apache 2.0 — see [LICENSE](LICENSE)
