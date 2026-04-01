---
title: "Run the Repo Locally"
description: "Step-by-step guide to set up the MemWal monorepo for local development."
---

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| **Node.js** | ≥ 20 | `node -v` |
| **pnpm** | ≥ 9.12 | `pnpm -v` |
| **Rust** | latest stable (only for backend services) | `rustc --version` |

<Tip>
If you only work on TypeScript apps or docs, you don't need Rust.
</Tip>

## Step 1 — Clone and Install

```bash
git clone https://github.com/CommandOSSLabs/MemWal.git
cd MemWal
pnpm install
```

## Step 2 — Build the SDK First

<Warning>
The apps depend on the SDK's compiled output. If you skip this step, apps will fail to start with import errors.
</Warning>

```bash
pnpm build:sdk
```

This compiles `packages/sdk` → `packages/sdk/dist/`. The apps import from `@mysten-incubation/memwal`, which resolves to this compiled output via the workspace.

## Step 3 — Run What You Need

Run individual surfaces from the repository root:

```bash
# Docs site (Mintlify)
pnpm dev:docs

# Demo apps (pick one)
pnpm dev:app          # Playground dashboard
pnpm dev:noter        # Note-taking app
pnpm dev:chatbot      # AI chatbot
pnpm dev:researcher   # Research assistant

# SDK in watch mode (recompiles on changes)
pnpm dev:sdk
```

## Step 4 — Backend Services (Optional)

The TypeScript apps talk to a managed relayer by default. You only need to run backend services if you're working on the relayer or indexer.

### Relayer (`services/server`)

Requires:
- PostgreSQL with `pgvector` extension
- Sui RPC access
- Walrus endpoints
- Embedding provider credentials (OpenAI-compatible)

Quick start:

```bash
# Start PostgreSQL with pgvector
docker compose -f services/server/docker-compose.yml up -d postgres

# Configure environment
cp services/server/.env.example services/server/.env
# Edit .env with your credentials

# Install sidecar dependencies
cd services/server/scripts && npm ci && cd ..

# Run the relayer
cargo run
```

For the full relayer setup guide, see [Self-Hosting](/relayer/self-hosting).

### Indexer (`services/indexer`)

```bash
cd services/indexer
cargo run
```

The indexer polls Sui events and syncs account data into PostgreSQL.

## Monorepo Structure

```
MemWal/
├── packages/
│   ├── sdk/                     # @mysten-incubation/memwal — TypeScript SDK
│   └── openclaw-memory-memwal/  # @mysten-incubation/oc-memwal — OpenClaw plugin
├── apps/
│   ├── app/         # Playground dashboard
│   ├── chatbot/     # AI chatbot demo
│   ├── noter/       # Note-taking demo
│   └── researcher/  # Research assistant demo
├── services/
│   ├── server/      # Rust relayer (Axum)
│   ├── indexer/     # Rust Sui event indexer
│   └── contract/    # Move smart contract
├── docs/            # Mintlify documentation site
└── SKILL.md         # Agent-first integration guide
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `Cannot find module '@mysten-incubation/memwal'` | SDK not built | Run `pnpm build:sdk` first |
| `ERR_MODULE_NOT_FOUND` in apps | Stale SDK build | Run `pnpm build:sdk` again |
| `pnpm install` fails | Wrong pnpm version | Use pnpm ≥ 9.12: `corepack enable && corepack prepare pnpm@9.12.3 --activate` |
| Docs site won't start | Missing Mintlify | Run `pnpm install` from the root |
| Relayer crashes on boot | Missing pgvector | Install the `pgvector` PostgreSQL extension |
| Sidecar timeout | Missing sidecar deps | Run `cd services/server/scripts && npm ci` |

## See Also

- [Run Docs Locally](/contributing/run-docs-locally) — just the docs site
- [Self-Hosting](/relayer/self-hosting) — full relayer deployment
- [Environment Variables](/reference/environment-variables) — relayer configuration
