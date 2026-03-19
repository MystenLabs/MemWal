---
title: "SDK Overview"
---

MemWal exposes three SDK surfaces.

## `@cmdoss/memwal`

Use this first.

- relayer-backed
- best path for most teams
- main methods: `remember`, `recall`, `analyze`, `restore`, `health`

```ts
import { MemWal } from "@cmdoss/memwal";
```

## `@cmdoss/memwal/manual`

Use this when the client must handle embeddings and local SEAL operations.

- relayer still handles upload relay, registration, search, and restore

```ts
import { MemWalManual } from "@cmdoss/memwal/manual";
```

## `@cmdoss/memwal/ai`

Use this when you already use the AI SDK.

```ts
import { withMemWal } from "@cmdoss/memwal/ai";
```

## Namespace

Both clients support a default namespace. If you omit it, it falls back to `"default"`.

## Recommended Path

1. start with `MemWal`
2. set a namespace explicitly
3. validate `remember`, `recall`, `analyze`, and `restore`
4. move to `MemWalManual` only if you need client-managed embeddings and local SEAL work
