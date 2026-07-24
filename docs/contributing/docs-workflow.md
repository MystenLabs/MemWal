---
title: "Docs Workflow"
description: >-
  Guidelines for contributing to Walrus Memory documentation, including source of truth,
  working rules for URL changes, and pre-ship verification steps.
keywords:
  - Walrus Memory
  - MemWal
  - documentation
  - contributing
  - docs workflow
goal:
  description: Understand the documentation contribution workflow and apply the working rules before shipping doc changes.
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
  - "How do I contribute to Walrus Memory documentation?"
  - "What is the source of truth for MemWal docs?"
  - "What should I check before shipping documentation changes?"
answer: >-
  Walrus Memory documentation lives in the docs/ directory and should be updated alongside
  README changes. Before shipping, run pnpm dev:docs and pnpm build:docs, and click through
  nav and sidebar links to verify correctness.
---

Walrus Memory is still in beta, so documentation is an active part of product hardening.
If you see unclear guidance, outdated flows, or missing examples, contributions are welcome.

## Source of Truth

The docs source of truth is the markdown content under `docs/` in this repository.

## Working Rules

- update the docs site and README together when entry points change
- keep old stub pages temporarily when URL changes would otherwise break links
- prefer linking readers into the new IA rather than expanding legacy sections forever

## Before Shipping

- run `pnpm dev:docs`
- run `pnpm build:docs`
- click through nav and sidebar links
