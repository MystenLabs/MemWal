---
title: "Docs Workflow"
---

Walrus Memory is still in beta, so documentation is an active part of product hardening.
If you see unclear guidance, outdated flows, or missing examples, contributions are welcome.

## Source of Truth

The docs source of truth is the markdown content under `docs/` in this repository.

## Working Rules

- update the docs site and README together when entry points change
- keep old stub pages temporarily when URL changes would otherwise break links
- prefer linking readers into the new IA rather than expanding legacy sections forever

## Style

All documentation must follow the [Sui Documentation Style Guide](https://docs.sui.io/style-guide).
The most important rules are:

- Language: US English, second person ("you"), present tense, active voice.
- Page titles: Title case. Headings: Sentence case.
- Latin abbreviations: Do not use `e.g.`, `i.e.`, or `etc.` — write "for example", "that is", or rephrase.
- Word choices: Use "might" (not "may"), "through" (not "via"), "because" (not causal "since").
- Punctuation: Oxford commas are mandatory. No exclamation marks.
- Sentence starters: Do not begin sentences with "Note" or "Please note".
- Code blocks: Use triple backticks with a language identifier, and introduce them with descriptive text.
- Links: Use relative paths for internal links.

Treat the style guide as a required step, not a suggestion. Before writing or editing any file
under `docs/`, apply every rule above; after editing, self-check the changed prose against the same
list and fix violations before finishing. Documentation that does not comply is not complete.

## Before Shipping

- run `pnpm dev:docs`
- run `pnpm build:docs`
- click through nav and sidebar links
