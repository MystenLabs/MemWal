---
title: "Run Docs Locally"
description: >-
  Instructions for running the Walrus Memory Mintlify documentation site locally
  using Node 20 and pnpm, including build commands for verification.
keywords:
  - Walrus Memory
  - MemWal
  - docs
  - Mintlify
  - local development
goal:
  description: Run the Walrus Memory documentation site locally and build it for verification.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 50
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - "How do I run the Walrus Memory docs locally?"
  - "What Node version does Mintlify require for MemWal docs?"
  - "How do I build the MemWal documentation site?"
answer: >-
  Run pnpm install and pnpm dev:docs from the repository root to start the Mintlify docs site
  locally. Use Node 20 LTS because Mintlify fails on Node 25+. Build with pnpm build:docs
  to verify the output.
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
