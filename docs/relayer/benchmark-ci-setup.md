# Benchmark CI Setup

This document records how to configure the relayer benchmark workflows.

The benchmark smoke workflow now verifies the Rust relayer and MemWal publisher
builds. The old TypeScript latency benchmark scripts were removed with the
legacy runtime.

## Workflows

- `.github/workflows/benchmark-smoke.yml`
  - Runs on pull requests and pushes that touch the relayer, publisher, benchmark workflow, or this setup doc.
  - Runs `cargo check`.
  - Runs `cargo check` for `infra/memwal-publisher`.
  - Does not need secrets and does not call Sui, Walrus, SEAL, or OpenAI.

The former `.github/workflows/benchmark-live.yml` workflow was removed because
it depended on the deleted TypeScript benchmark runner.

## Railway Relayer URLs

Railway project: `MemWal`

Railway service: `relayer`

| Target | Railway environment | Public relayer URL | Sui network |
| --- | --- | --- | --- |
| dev | `dev` | `https://relayer.dev.memwal.ai` | `testnet` |
| staging | `staging` | `https://relayer.staging.memwal.ai` | `testnet` |

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

For each environment, set this Variable:

| Variable | dev | staging |
| --- | --- | --- |
| `BENCH_SERVER_URL` | `https://relayer.dev.memwal.ai` | `https://relayer.staging.memwal.ai` |

For each environment, set these Secrets:

| Secret | dev/staging value |
| --- | --- |
| `BENCH_ACCOUNT_ID` | testnet account ID from the table above |
| `BENCH_DELEGATE_KEY` | testnet private key, stored only as a secret |

## Manual Run

Use the Python quality benchmark harness under `services/server/benchmarks`
for current manual benchmark runs.
