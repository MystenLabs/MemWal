# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Documentation

Documentation lives under `docs/` and is published with Mintlify (configured in `docs/docs.json`).
Content pages are Markdown/MDX. See `docs/contributing/docs-workflow.md` for the contribution
workflow, and build locally with `pnpm dev:docs` / `pnpm build:docs` from the repository root
(use Node 20 LTS — Mintlify fails on Node 25+).

### Style

All documentation must follow the Sui Documentation Style Guide.

**Enforcement:** Before creating or editing any `.md` or `.mdx` file under `docs/`, load the
`sui-documentation-style-guide` skill and follow the full skill — it is the source of truth for
style, not any summary. After editing, re-check every changed file against the full skill and fix
violations before committing. Run `pnpm build:docs` from the repository root to confirm the site
still builds. Documentation that does not comply is not complete.
