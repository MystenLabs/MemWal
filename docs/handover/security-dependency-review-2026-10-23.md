# October runtime and dependency security update

This update extends PR #1284 beyond the Node runtime pins. It patches the identified October Node, Python certificate, Next.js, MCP, and Rust TLS issues, and records the remaining dependency findings for review. No production deployment or credential rotation was performed.

## Changes and validation

- Node images use 22.23.4 with verified multi-platform digests. Node 22 CI jobs read `.nvmrc`; the Node 24 test/release jobs retain their patched 24.22.1 pins. This also changes the mainnet app build runtime in `deploy-app-walrus.yml`.
- All three Next apps use 16.4.1. The workspace resolves sharp 0.35.5, patched ProseMirror, Auth.js beta.32, React Router, and compatible HTTP/parser/tooling patches. The unused dashboard VitePress dependency was removed. Mintlify was updated within its existing v4 release line; strict documentation validation passes.
- Both MCP dependency graphs use SDK 1.32.1. Hosted tool validation is capped at 10,000 elements and HTTP bodies at 2 MiB, matching the Rust proxy cap. Legacy SSE body parsing runs after authentication and session ownership checks. Regression tests drive the actual HTTP routes and the configured SDK server.
- The client's handwritten SSE path also refuses redirects and endpoints on another origin. Tests confirm that SSE and Streamable HTTP do not forward custom headers or tool bodies through a cross-origin redirect.
- Python SDK 0.2.0 intentionally requires Python 3.11+ and raises the certifi/AnyIO minimums. CI uses patched interpreters and a checksum-verified pip bootstrap. The benchmark has a hash-locked dependency file and offline unit-test/audit CI coverage. Existing virtual environments require recreation/update; repository changes do not update the user's installed interpreters or pip.
- Rust locks update rustls 0.23.46, rustls-webpki 0.103.16, webpki-roots 1.0.10, rust-openssl 0.10.80, h2 0.4.16, anyhow 1.0.103, and event-listener 5.4.2 where applicable. The Sui framework revision is unchanged. Relayer/indexer `cargo check --locked --all-targets` passes.

Local validation includes SDK 299 tests, MCP client 323 tests, sidecar 457 tests, Python SDK 254 unit tests, benchmark 42 tests, chatbot 83 tests, researcher 154 tests, noter 57 tests, dashboard 145 tests, the pip-bootstrap integrity test, and the relayer compatibility test. All five web app builds and the strict docs build validation pass. The PR description records any additional CI or container results.

The production Chatbot Docker image builds successfully on Linux arm64. Its runtime reports Node v22.23.4, Next 16.4.1, and native sharp 0.35.5. With dummy credentials and an unreachable local test database, container smoke tests serve auth providers and the favicon; a malformed Bearer request returns a redirect (307), not a server error. No real account, wallet, provider, or production data is used.

## Audit results and remaining findings

At the October 23 follow-up scan, the root pnpm audit reports **0 critical and 1 high** finding, down from 11 critical and 171 high report occurrences before the update and seven high findings after the first pass. These counts cover lockfile dependencies, including optional/platform/build-only packages; they are not counts of demonstrated production exploits. No advisory suppression was added. Four obsolete nested pnpm/npm locks were removed after confirming Docker/CI install from the root pnpm lock and the sidecar npm lock; stale alternative graphs must not suggest that those old packages are still the deployment inputs. The sidecar's independent npm production audit has no high/critical finding; it retains one low-severity esbuild development-server finding. The fresh Python SDK and benchmark environments have no known pip-audit findings at this scan.

The follow-up closes six of the seven previous high advisories by upgrading their actual parents:

| Dependency / advisory | Resolution |
| --- | --- |
| valibot 0.36.0, [GHSA-vqpr-j7v3-hqw9](https://github.com/advisories/GHSA-vqpr-j7v3-hqw9) | Remove Noter's unused deprecated `@mysten/zklogin` dependency. Its wallet helper now imports the generic registry/types from `@wallet-standard/core`, removing the other Sui 1.x branch without changing the Sui signing feature. No Valibot 0.36 or Sui 1.x entry remains in the authoritative workspace lock. A registry/connect/sign regression covers the helper. |
| undici 5.29.0, [GHSA-vrm6-8vpv-qv8q](https://github.com/advisories/GHSA-vrm6-8vpv-qv8q), [GHSA-v9p9-hfj2-hcw8](https://github.com/advisories/GHSA-v9p9-hfj2-hcw8), [GHSA-vxpw-j846-p89q](https://github.com/advisories/GHSA-vxpw-j846-p89q) | Upgrade both apps' Blob SDK to 2.8.2 and require Undici 6.27.0+ for that release line. Preserve public upload access and explicitly preserve random suffixes. A test sends the actual upload route through the real Blob SDK to a loopback API fixture and checks the binary body and namespace. |
| @fastify/busboy 2.1.1, [GHSA-x8mw-p69m-v3mx](https://github.com/advisories/GHSA-x8mw-p69m-v3mx) | Removed with the Blob SDK's old Undici 5 graph. |
| drizzle-orm 0.34.1, [GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9) | Upgrade Chatbot/Researcher to ORM 0.45.4 and Kit 0.31.11. Both apps test the patched PostgreSQL delimiter escaping. Keep existing schemas/migrations; validate migrations and DB-backed flows with their Playwright jobs. |

The one remaining high finding is **braces 3.0.3**, [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). It is retained by Changesets, glob/file-watching, shadcn, and documentation build tooling. The advisory has no patched release at this scan. No public API accepting brace patterns was identified. Track upstream, keep build inputs trusted, and do not introduce an API evaluating untrusted glob patterns. Do not invent a fixed version or suppress the advisory to make the audit green.

The Cargo OSV scan still reports 16 advisory records across 13 package/version entries. Some records are unmaintained-package notices or alias duplicates. Remaining code findings include protobuf 2.x recursion, RSA timing behavior, OpenTelemetry SDK, quick-xml, and lru in inherited dependency graphs. They require feature/call-site review and coordinated parent/API migrations; this PR does not claim the Rust graph is advisory-free.

## Manual release preparation

- MCP package and all plugin/marketplace version fields are manually bumped to **0.0.16**; both MCP changelogs describe the transport security changes and final-origin URL requirement. The pending changeset was removed to avoid a second bump on `main`.
- Python SDK remains **0.2.0** in `pyproject.toml`, `memwal.__version__`, and both changelogs. The Python 3.11 support floor is an intentional compatibility change. These two new versions are not published at this check.
- TypeScript SDK stays **0.1.9**, and OpenClaw stays **0.0.7**. Their executable code, dependency constraints, and public API are unchanged by this update.
- `verify-manual-sdk-release.mjs` now reads each canonical manifest instead of hard-coding obsolete release numbers. It requires all mirrors and the newest package/docs changelog sections to agree, and is covered by mismatch regressions in CI.
- The launcher override intentionally remains at published MCP **0.0.15** while 0.0.16 is unpublished. `check-mcp-pin.mjs` verifies that npm can actually serve it and fails a stale pin as soon as the prepared release is published. Publish/verify 0.0.16 before retargeting this override; until then, existing launcher installs do **not** receive the new transport fixes.

## Rollout

CI and local tests do not establish the versions running in staging or production. Rebuild with fresh system CA packages, deploy through the normal release process, record actual runtime/image/binary versions, and smoke-test authentication, MCP, remember/recall, and SEAL/Walrus flows. Publish the new MCP/Python releases through the existing workflows; update the plugin launcher pin only after its target version exists on npm. Existing package-source changes already trigger the normal dev prerelease workflows when merged.

Credential containment for the Railway disclosure remains tracked in WALM-865/WALM-872. Do not restore potentially exposed credentials as a rollback. See [runtime security updates](../contributing/security-updates.md) for environment setup and upstream sources.
