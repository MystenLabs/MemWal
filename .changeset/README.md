# Changesets

This project uses [Changesets](https://github.com/changesets/changesets) to manage versioning and changelogs for `@mysten-incubation/memwal`.

## How to add a changeset

When you make a change that should be released:

```bash
pnpm changeset
```

This will prompt you to:
1. Select which packages have changed (`@mysten-incubation/memwal`)
2. Choose the semver bump type (major / minor / patch)
3. Write a summary of the change

A markdown file will be created in this directory describing the change.

## Release flow

1. Changesets bot creates a **"Version Packages"** PR on `main`
2. That PR bumps versions and updates `CHANGELOG.md`
3. When you **merge** the PR, GitHub Actions automatically **publishes to npm**
