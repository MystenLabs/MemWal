# Isolated dev burst benchmark

Use this branch for a stable Testnet benchmark target. Do not point staging or production at it.

## Railway target

- Project: `7c541ac5-535d-4240-9bad-4ad9804c2dd7`
- Environment: dev (`37d3838c-bcde-4119-853f-b955fba79037`)
- Relayer service: `24c01e69-1dd0-4147-932b-552c6a222be8`
- Endpoint: https://relayer.dev.memwal.ai
- Branch: `harry/dev-isolated-burst-20260930`
- Baseline code: `79f241ec5e8f93b3e7a219877d36208979c51621`

Pin Railway source.commitSha to the reviewed commit on this branch before a run. Do not update that pin while any benchmark job is unresolved. A pin prevents ordinary branch pushes from changing the selected source revision; it does not prevent another operator from manually deploying. Check /version throughout the run and record deployment IDs from Railway.

Dev previously tracked `feat/sept-2026-dashboard`, with checkSuites=false and rootDirectory=services/server/. Restore these source settings and remove the benchmark pin when releasing dev back to the team. Do not restore or copy secret values from this document.

## Isolation and limitations

Preflight found different DATABASE_URL and REDIS_URL values between dev and staging. Uploader-key lists also differ; this alone does not prove that all wallet addresses are disjoint. Both environments use the shared public Testnet Walrus upload relay, so upstream contention remains possible. Dev has WALLET_JOB_CONCURRENCY=5 versus staging's 17. Report these differences: a dev result is not a controlled capacity comparison with Henry's staging run.

The dev endpoint may still receive existing dev clients. Record background traffic and isolate every test using an authorized owner and a unique namespace. Never claim this environment is exclusively used unless traffic observations confirm it.

## Run procedure

1. Record deployment ID, full commit SHA, network, wallet count, concurrency and background load. Use `python3 guard.py FULL_SHA` to verify the public endpoint. Repeat while polling jobs and after the run.
2. Check request-rate eligibility using the existing test identity. Do not silently disable global limits or deploy a stale exemption. If the 100-request workload would be rejected, report that before sending it and prepare any owner-scoped exemption separately against this branch.
3. Release 100 individually signed POST /api/remember requests from one barrier. Use unique markers and record payload bytes, account layout, send spread, request IDs, job IDs and responses. This is 100 requests, not necessarily 100 users.
4. Poll bulk status every 5 seconds until terminal states or a declared deadline. Do not resubmit accepted writes on timeout. Measure successful recall separately and report its polling resolution.
5. Correlate logs/DB by owner, namespace and job ID. Record acceptance, Seal preparation, wallet/lock wait, upload checkpoints, metadata/finalize and recall. Missing stage timing is unavailable, not zero.
6. Record failed and unresolved jobs, and latency distributions with their denominators. A successful 202 is not completed storage. A sidecar 503 is not proof of an upstream 429.
7. If the deployed SHA changes, stop issuing new writes, continue collecting existing job outcomes, and label the run as confounded. Do not roll back a teammate's deployment automatically.

No automatic cleanup or retries of failed paid writes. Keep credentials out of logs and artifacts. No production modifications.
