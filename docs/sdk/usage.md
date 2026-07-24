---
title: "Usage"
description: >-
  Detailed usage guide for all three Walrus Memory clients: MemWal, MemWalManual, and withMemWal. Covers namespace rules and when to use each entry point.
keywords:
  - Walrus Memory
  - MemWal
  - usage
  - namespace
  - MemWalManual
  - withMemWal
goal:
  description: Understand when to use each Walrus Memory client and how to configure namespaces properly.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 300
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - When should I use MemWal vs MemWalManual vs withMemWal?
  - How do namespaces work in Walrus Memory?
  - What are the namespace rules for the Walrus Memory SDK?
answer: >-
  Walrus Memory exposes three entry points: MemWal (recommended default with relayer-handled operations), MemWalManual (client-managed embeddings and SEAL), and withMemWal (Vercel AI SDK middleware). Namespaces can be set per client or per call, and fall back to "default" if omitted.
---

Walrus Memory exposes three entry points:

| Entry point | Import | When to use |
| --- | --- | --- |
| `MemWal` | `@mysten-incubation/memwal` | **Recommended default** — relayer handles embeddings, SEAL, and storage |
| `MemWalManual` | `@mysten-incubation/memwal/manual` | You need client-managed embeddings and local SEAL operations |
| `withMemWal` | `@mysten-incubation/memwal/ai` | You already use the Vercel AI SDK and want memory as middleware |

## Namespace Rules

- Set a default namespace in `create(...)` when one app or agent uses one boundary
- Pass `namespace` per call when one client needs multiple boundaries
- If omitted, namespace falls back to client config, then to `"default"`

Good namespace examples: `todo`, `personal`, `password`, `project-x`. Avoid keeping everything in `"default"` after early testing.
