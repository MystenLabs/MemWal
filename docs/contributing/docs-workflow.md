# Docs Workflow

MemWal is still in beta, so documentation is an active part of product hardening.
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
