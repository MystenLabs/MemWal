---
title: "Run Docs Locally"
---

Run these commands from the repository root:

```bash
npx -p node@20 -c 'node -v'
pnpm install
pnpm dev:docs
```

This starts the Mintlify site using the docs in this repository.

Use Node 20 LTS for Mintlify local preview. Mintlify fails on Node 25+.

## Build the Docs

```bash
pnpm build:docs
```
