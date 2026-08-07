---
title: "Benchmark CI Setup"
description: >-
  Configuration guide for the Walrus Memory relayer benchmark CI workflows, including GitHub Environment setup, Railway relayer URLs, test accounts, and manual benchmark execution.
keywords:
  - Walrus Memory
  - MemWal
  - benchmark
  - CI
  - GitHub Actions
  - performance testing
goal:
  description: Set up the relayer benchmark GitHub Actions workflow, run it locally to baseline performance, and interpret throughput and latency results.
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
  - "How do I set up benchmark CI for the Walrus Memory relayer?"
  - "What GitHub environments and secrets are needed for MemWal benchmarks?"
  - "How do I run a manual recall latency benchmark against the relayer?"
answer: >-
  The relayer benchmark CI consists of a smoke workflow (pull requests, no secrets needed) and a live workflow (pushes to dev/staging and weekly runs). Live benchmarks run against Railway-hosted relayer endpoints using GitHub Environment secrets for delegate keys and account IDs, and results are uploaded as GitHub Actions artifacts.
---

# Benchmark CI Setup

This document records how to configure the relayer benchmark workflows.

The live benchmark intentionally runs only the public relayer `/api/recall`
path. Direct sidecar and Walrus upload benchmarks are out of scope because the
hosted GitHub runner cannot reach the internal sidecar in the current Railway
deployment.

## Workflows

- `.github/workflows/benchmark-smoke.yml`
  - Runs on pull requests and pushes that touch benchmark scripts, benchmark workflows, or this setup doc.
  - Runs `cargo check`.
  - Typechecks `bench-recall-latency.ts`.
  - Runs a `--help` smoke check for the recall benchmark CLI.
  - Does not need secrets and does not call Sui, Walrus, SEAL, or OpenAI.

- `.github/workflows/benchmark-live.yml`
  - Runs automatically on pushes to `dev` and `staging`.
  - Maps push benchmarks to `benchmark-dev` and `benchmark-staging`.
  - Runs manually via `workflow_dispatch` on a selected branch/ref and target environment.
  - Also runs weekly on Monday at 09:00 UTC against the default branch environment.
  - Uses one GitHub Environment per target: `benchmark-dev` or
    `benchmark-staging`.
  - Runs `bench-recall-latency.ts` against `POST /api/remember` and `POST /api/recall`.
  - Uses the `benchmark` namespace by default to isolate benchmark writes.
  - Uploads `benchmark-results/memory-api.json` as a GitHub Actions artifact.
  - Writes the benchmark markdown table into the Actions job summary.

## Railway Relayer URLs

Railway project: `MemWal`

Railway service: `relayer`

| Target | Railway environment | Public relayer URL | Sui network |
| --- | --- | --- | --- |
| dev | `dev` | `https://relayer.dev.memwal.ai` | `testnet` |
| staging | `staging` | `https://relayer-staging.memory.walrus.xyz` | `testnet` |

## Benchmark Test Accounts

Do not commit private keys. Store private keys only in GitHub Environment
Secrets or another secret manager.

| Target | `BENCH_ACCOUNT_ID` | Public key |
| --- | --- | --- |
| dev/staging | `0x1b3293a312f27a0122d739b05a390660f650d4d314033ac67706b87244f7a429` | `1b176b0d290300ff4dceae282333d999998d5543f89e9c53dd2c59ca2955df0e` |
| production | `0x57eb9feddfd98f98a5719e2a194431b63d24950acd138c52366bf02370ac6287` | `1477a32677be9ba81f86b96583beda4b0eec2dc953080961cefd9cbece41c448` |

Rotated 2026-08-07: the previous dev/staging test account (`0x7fce97b1...`,
created 2026-05-04) was minted under a package that predates the dev/staging
contract redeploy (see `docs/contract/overview.md`'s current package/registry
IDs) and was never migrated, so `verify_delegate_key_onchain`'s type-origin
check (#398) rejected every request with a bodyless `401`. If this happens
again, mint a fresh account with `createAccount`/`addDelegateKey` from
`packages/sdk/src/account.ts` against the *current* package/registry, not the
IDs in an old copy of this doc.

## GitHub Environment Setup

Create these GitHub Environments:

- `benchmark-dev`
- `benchmark-staging`

For each environment, set this Variable:

| Variable | dev | staging |
| --- | --- | --- |
| `BENCH_SERVER_URL` | `https://relayer.dev.memwal.ai` | `https://relayer-staging.memory.walrus.xyz` |

For each environment, set these Secrets:

| Secret | dev/staging value |
| --- | --- |
| `BENCH_ACCOUNT_ID` | testnet account ID from the table above |
| `BENCH_DELEGATE_KEY` | testnet private key, stored only as a secret |

## Manual Run

Remember and recall against staging:

```bash
cd services/server/scripts

./node_modules/.bin/tsx bench-recall-latency.ts \
  --server-url https://relayer-staging.memory.walrus.xyz \
  --account-id "$BENCH_ACCOUNT_ID" \
  --delegate-key "$BENCH_DELEGATE_KEY" \
  --namespace benchmark \
  --remember-text "benchmark memory" \
  --query "benchmark memory"
```
