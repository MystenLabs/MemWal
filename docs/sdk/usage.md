---
title: "Usage"
description: "Detailed usage for all three MemWal clients — MemWal, MemWalManual, and withMemWal."
---

MemWal exposes three entry points:

| Entry point | Import | When to use |
| --- | --- | --- |
| `MemWal` | `@mysten/memwal` | **Recommended default** — relayer handles embeddings, SEAL, and storage |
| `MemWalManual` | `@mysten/memwal/manual` | You need client-managed embeddings and local SEAL operations |
| `withMemWal` | `@mysten/memwal/ai` | You already use the Vercel AI SDK and want memory as middleware |

## Namespace Rules

- Set a default namespace in `create(...)` when one app or tenant uses one boundary
- Pass `namespace` per call when one client needs multiple boundaries
- If omitted, namespace falls back to client config, then to `"default"`

Good namespace examples: `todo`, `personal`, `password`, `project-x`. Avoid keeping everything in `"default"` after early testing.
