---
title: Docs Workflow
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
  description: Follow the docs contribution workflow (branch, edit, verify frontmatter, and open a PR) without breaking build or frontmatter validation rules.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 100
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

Walrus Memory evolves quickly, so documentation is an active part of product hardening.
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
- run `pnpm check:docs`
- click through nav and sidebar links

## Conventions check

`pnpm check:docs` runs `scripts/check-docs-conventions.mjs` over the pages your branch changed. The same script runs in CI on every pull request. It enforces three things that reviewers otherwise have to catch by hand:

1. **Linked terms.** `scripts/docs-conventions.json` lists concepts that have a canonical page or spec. A page that mentions one has to link it at least once. Add an entry to that file when a new canonical page lands. The script checks every internal target against `docs/docs.json` on each run, so a renamed route fails the check before a reader finds the broken link.
2. **Consistent procedures.** A page that uses `<Steps>` cannot also write a procedure as a bolded numbered list, and a `## Troubleshooting` section has to match the format the sibling pages in its directory already use.
3. **UI verification.** When a change touches a click-through procedure, the pull request body needs a `UI verification:` line naming who ran the flow and against which environment. "Nobody has run it yet" is a valid answer. The point is that a reviewer reads it in the description instead of asking.

Run the script on specific pages with `node scripts/check-docs-conventions.mjs docs/mcp/overview.md`, or across the whole site with `--all`.
