# SDK Overview

MemWal currently exposes three developer-facing SDK surfaces.

## 1. `@cmdoss/memwal`

This is the default, relayer-backed client and the recommended starting point.

```ts
import { MemWal } from "@cmdoss/memwal";
```

Use it when you want the backend to handle most of the workflow.

Primary methods:

- `remember(text, namespace?)`
- `recall(query, limit?, namespace?)`
- `analyze(text, namespace?)`
- `restore(namespace, limit?)`
- `health()`

## 2. `@cmdoss/memwal/manual`

This is the manual client flow.

```ts
import { MemWalManual } from "@cmdoss/memwal/manual";
```

Use it when the client should handle:

- embedding provider calls
- SEAL encryption and decryption
- Walrus downloads during recall

while still using the relayer for registration, search, restore, and upload relay during manual remember.

## 3. `@cmdoss/memwal/ai`

This wraps an AI SDK model with recall-before-generation and auto-save-after-generation behavior.

```ts
import { withMemWal } from "@cmdoss/memwal/ai";
```

## Namespace Behavior

Both SDK configs support a default namespace. If you do not provide one, it defaults to `"default"`.

## Beta Note

The clearest beta path is:

1. start with `MemWal`
2. set a namespace explicitly
3. validate `remember`, `recall`, `analyze`, and `restore`
4. move to `MemWalManual` only if your product needs client-managed embedding and local SEAL handling
