---
title: "Overview"
---

MemWal exposes three SDK surfaces.

## `@mysten-incubation/memwal`

Use this first.

- relayer-backed
- best path for most teams
- main methods: `remember`, `recall`, `analyze`, `restore`, `health`

```ts
import { MemWal } from "@mysten-incubation/memwal";
```

## `@mysten-incubation/memwal/manual`

Use this when the client must handle embeddings and local SEAL operations.

- relayer still handles upload relay, registration, search, and restore

```ts
import { MemWalManual } from "@mysten-incubation/memwal/manual";
```

## `@mysten-incubation/memwal/ai`

Use this when you already use the AI SDK.

```ts
import { withMemWal } from "@mysten-incubation/memwal/ai";
```

## Namespace

Both clients support a default namespace. If you omit it, it falls back to `"default"`.

## Recommended Path

1. Start with `MemWal`
2. Set a namespace explicitly
3. Validate `remember`, `recall`, `analyze`, and `restore`
4. Move to `MemWalManual` only if you need client-managed embeddings and local SEAL work
