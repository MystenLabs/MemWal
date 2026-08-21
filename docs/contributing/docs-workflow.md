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

## Importing Code from the Workspace

Mintlify cannot import code at build time, so snippets in `docs/` start as copies and drift the moment the source changes. When a snippet reproduces a declaration that lives in `packages/`, `apps/`, `services/`, `scripts/`, or `contract/`, import it instead of copying it:

````markdown
{/* memwal:import packages/sdk/src/types.ts#RememberResult */}
```ts
```
{/* /memwal:import */}
````

Run `pnpm docs:sync` and the fence fills in with the real declaration, doc comments included. You commit the result, so Mintlify renders it with no build step and it reads correctly on GitHub. CI runs `pnpm docs:sync:check`, which fails when a page no longer matches its source, so whoever changes the code fixes the page in the same pull request.

Two selectors are available:

| **Selector** | **Extracts** |
| --- | --- |
| `path#SymbolName` | The named top-level declaration and its doc comment. Needs nothing in the source file. |
| `path#region:name` | The span between `// #region docs:name` and its `#endregion`, for a slice that is not one declaration. |

The markers are MDX comments, not HTML comments. Both Mintlify and the Walrus Docusaurus site that republishes these pages parse `.md` as MDX, where `<!-- -->` is a parse error rather than a comment. `pnpm docs:sync` rejects the HTML form with an explanation instead of letting it reach a build.

Both anchor to a name rather than to a line number. Refactoring invalidates a line number and nothing catches it; a renamed or deleted symbol instead fails the check rather than quietly importing the wrong code.

Keep writing snippets by hand when you compose an example rather than copy one. A snippet that shows two clients cooperating, or a call sequence you wrote to teach a concept, exists nowhere in the source, so there is nothing to import. `check-docs-code-sync.mjs` still covers those, validating package names, entry points, and MCP config blocks against the workspace.

## Before Shipping

- run `pnpm dev:docs`
- run `pnpm build:docs`
- run `pnpm docs:sync:check`
- click through nav and sidebar links
