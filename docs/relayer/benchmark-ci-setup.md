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
  - Runs manually via `workflow_dispatch`.
  - Also runs weekly on Monday at 09:00 UTC.
  - Uses one GitHub Environment per target: `benchmark-dev`,
    `benchmark-staging`, or `benchmark-production`.
  - Runs `bench-recall-latency.ts`.
  - Uploads `benchmark-results/recall.json` as a GitHub Actions artifact.
  - Writes the benchmark markdown table into the Actions job summary.

## Railway Relayer URLs

Railway project: `MemWal`

Railway service: `relayer`

| Target | Railway environment | Public relayer URL | Sui network |
| --- | --- | --- | --- |
| dev | `dev` | `https://relayer.dev.memwal.ai` | `testnet` |
| staging | `staging` | `https://relayer.staging.memwal.ai` | `testnet` |
| production | `production` | `https://relayer.memwal.ai` | `mainnet` |

Note: Railway has no environment named `mainnet`; mainnet is represented by
the Railway environment named `production`.

## Benchmark Test Accounts

Do not commit private keys. Store private keys only in GitHub Environment
Secrets or another secret manager.

| Target | `BENCH_ACCOUNT_ID` | Public key |
| --- | --- | --- |
| dev/staging | `0x7fce97b1f4a72fff7b9457617234ddc251416a76382c44be7bc7652c84d06a1b` | `c36f131232950d7cc9f97846e368106c7a4b30864f560c2e518e3e7ea8c823f7` |
| production | `0x57eb9feddfd98f98a5719e2a194431b63d24950acd138c52366bf02370ac6287` | `1477a32677be9ba81f86b96583beda4b0eec2dc953080961cefd9cbece41c448` |

## GitHub Environment Setup

Create these GitHub Environments:

- `benchmark-dev`
- `benchmark-staging`
- `benchmark-production`

For each environment, set this Variable:

| Variable | dev | staging | production |
| --- | --- | --- | --- |
| `BENCH_SERVER_URL` | `https://relayer.dev.memwal.ai` | `https://relayer.staging.memwal.ai` | `https://relayer.memwal.ai` |

For each environment, set these Secrets:

| Secret | dev/staging value | production value |
| --- | --- | --- |
| `BENCH_ACCOUNT_ID` | testnet account ID from the table above | production account ID from the table above |
| `BENCH_DELEGATE_KEY` | testnet private key, stored only as a secret | production private key, stored only as a secret |

## Manual Run

Recall against staging:

```bash
cd services/server/scripts

./node_modules/.bin/tsx bench-recall-latency.ts \
  --server-url https://relayer.staging.memwal.ai \
  --account-id "$BENCH_ACCOUNT_ID" \
  --delegate-key "$BENCH_DELEGATE_KEY" \
  --namespace default \
  --query "test query"
```
