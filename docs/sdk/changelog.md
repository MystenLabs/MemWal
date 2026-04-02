---
title: "Changelog"
description: "Release history for the MemWal TypeScript SDK."
---

Track what's new, changed, and fixed in `@mysten-incubation/memwal`.

For the latest version, see the [npm package page](https://www.npmjs.com/package/@mysten-incubation/memwal).

## 0.0.1

### Initial Release

- `MemWal` default client — relayer-handled embedding, SEAL encryption, Walrus upload, vector search
- `MemWalManual` manual client — client-side embedding and SEAL operations
- `withMemWal` Vercel AI SDK middleware — automatic memory recall and save
- Account management utilities — `createAccount`, `addDelegateKey`, `removeDelegateKey`, `generateDelegateKey`
- Ed25519 delegate key authentication
- Namespace-scoped memory isolation
