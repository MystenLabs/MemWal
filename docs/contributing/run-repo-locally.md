---
title: "Run the Repo Locally"
---

This monorepo contains:

- TypeScript applications under `apps/`
- the SDK under `packages/sdk`
- Rust backend services under `services/`
- Mintlify docs under `docs/`

## Common Local Entry Points

From the repository root:

```bash
pnpm install
pnpm dev:docs
pnpm dev:app
pnpm dev:noter
pnpm dev:chatbot
pnpm dev:researcher
```

Backend services are run from their respective Rust service directories.

## Service Dependencies

For relayer-oriented local work you will typically need:

- PostgreSQL
- Sui RPC access
- Walrus endpoints
- embedding provider credentials

## Relayer Setup

If you want to run the backend locally, start with the Relayer docs:

- [Self-Hosting](/relayer/self-hosting)
