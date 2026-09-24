---
title: PR descriptions for public changelog
description: >-
  How MemWal PR descriptions should look so Walrus Memory release tracking on
  docs.wal.app/changelog stays uniform with Walrus Sites.
keywords:
  - Walrus Memory
  - changelog
  - pull request
  - docs.wal.app
  - Walrus Sites
goal:
  description: Write MemWal PR bodies that match the Walrus Sites external changelog style.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 80
      label: Needs more content depth
questions:
  - "How should MemWal PR descriptions be structured for the public changelog?"
  - "How do Walrus Sites and Walrus Memory keep changelog wording uniform?"
answer: >-
  User facing MemWal PRs should open with a short impact summary, then area
  prefixed bullets (mcp, sdk, python-sdk, relayer, docs, ci, app), matching the
  Walrus Sites style used on docs.wal.app/changelog.
---

# PR descriptions for public changelog

Walrus Memory release notes are tracked for the community on
[docs.wal.app/changelog](https://docs.wal.app/changelog) next to Walrus and
Walrus Sites. To keep that feed uniform, **user facing** MemWal PR descriptions
should follow the same shape Walrus Sites uses for release notes.

## Pattern (Walrus Sites style)

1. **Summary** — one short paragraph of user or developer impact (why anyone
   outside the repo should care).
2. **Changes** — bullets with an **area prefix**, then the concrete change.
3. Optional **operator / breaking** note when install or config must change.

### Example

```markdown
## Summary (external facing)

Optional `maxDistance` on recall drops weak hits, and recall lines now show
both score and distance so clients can tune similarity without guessing.

## Changes

- mcp: add optional `maxDistance` on `memwal_recall` (cosine cutoff, must be >= 0)
- sdk: surface `distance` alongside `score` on recall results
- docs: document the cutoff in the recall reference
```

### Areas to prefix

`mcp:` · `sdk:` · `python-sdk:` · `relayer:` · `docs:` · `ci:` · `app:`

## When opening a PR

When opening or drafting a MemWal PR:

1. Fill `.github/pull_request_template.md`.
2. Write the Summary so it can be pasted into the public changelog with light edits.
3. Mark Changelog: no release note needed, or release note needed with an Area.
4. Do not bury the only user facing sentence under internal review chatter.

Internal only work (refactors with no user impact, CI only, chore) can set
Summary to `N/A` and check **No release note needed**.

## Related

- Template: `.github/pull_request_template.md`
- Public feed: https://docs.wal.app/changelog
