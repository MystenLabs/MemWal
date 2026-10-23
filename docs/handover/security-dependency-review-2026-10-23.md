# October runtime and dependency security update

This update extends PR #1284 beyond the Node runtime pins. It patches the identified October Node, Python certificate, Next.js, MCP, and Rust TLS issues, and records the remaining dependency findings for review. No production deployment or credential rotation was performed.

## Changes and validation

- Node images use 22.23.4 with verified multi-platform digests. Node 22 CI jobs read `.nvmrc`; the Node 24 test/release jobs retain their patched 24.22.1 pins. This also changes the mainnet app build runtime in `deploy-app-walrus.yml`.
- All three Next apps use 16.4.1. The workspace resolves sharp 0.35.5, patched ProseMirror, Auth.js beta.32, React Router, and compatible HTTP/parser/tooling patches. The unused dashboard VitePress dependency was removed. Mintlify was updated within its existing v4 release line; strict documentation validation passes.
- Both MCP dependency graphs use SDK 1.32.1. Hosted tool validation is capped at 10,000 elements and HTTP bodies at 2 MiB, matching the Rust proxy cap. Legacy SSE body parsing runs after authentication and session ownership checks. Regression tests drive the actual HTTP routes and the configured SDK server.
- The client's handwritten SSE path also refuses redirects and endpoints on another origin. Tests confirm that SSE and Streamable HTTP do not forward custom headers or tool bodies through a cross-origin redirect.
- Python SDK 0.2.0 intentionally requires Python 3.11+ and raises the certifi/AnyIO minimums. CI uses patched interpreters and a checksum-verified pip bootstrap. The benchmark has a hash-locked dependency file and offline unit-test/audit CI coverage. Existing virtual environments require recreation/update; repository changes do not update the user's installed interpreters or pip.
- Rust locks update rustls 0.23.46, rustls-webpki 0.103.16, webpki-roots 1.0.10, rust-openssl 0.10.80, h2 0.4.16, anyhow 1.0.103, and event-listener 5.4.2 where applicable. The Sui framework revision is unchanged. Relayer/indexer `cargo check --locked --all-targets` passes.

Local validation includes SDK 299 tests, MCP client 323 tests, sidecar 457 tests, Python SDK 254 unit tests, benchmark 42 tests, chatbot 81 tests, researcher 153 tests, noter 56 tests, dashboard 145 tests, the pip-bootstrap integrity test, and the relayer compatibility test. All five web app builds and the strict docs build validation pass. The PR description records any additional CI or container results.

The production Chatbot Docker image builds successfully on Linux arm64. Its runtime reports Node v22.23.4, Next 16.4.1, and native sharp 0.35.5. With dummy credentials and an unreachable local test database, container smoke tests serve auth providers and the favicon; a malformed Bearer request returns a redirect (307), not a server error. No real account, wallet, provider, or production data is used.

## Audit results and remaining findings

At the October 23 scan, the root pnpm audit reports **0 critical and 7 high** findings, down from 11 critical and 171 high report occurrences. These counts cover lockfile dependencies, including optional/platform/build-only packages; they are not counts of demonstrated production exploits. No advisory suppression was added. The sidecar's independent npm production audit has no high/critical finding; it retains one low-severity esbuild development-server finding. The fresh Python SDK and benchmark environments have no known pip-audit findings at this scan.

The seven remaining pnpm high advisories are documented below rather than force-overriding incompatible dependency majors:

| Dependency / advisory | Current exposure review | Follow-up |
| --- | --- | --- |
| valibot 0.36.0, [GHSA-vqpr-j7v3-hqw9](https://github.com/advisories/GHSA-vqpr-j7v3-hqw9) | Requires the `emoji` validator. It is retained by legacy Sui 1.x packages; no `emoji()` validator caller was found in those compiled consumers. | Migrate the legacy Sui consumers before introducing new validation behavior. The patched Valibot line is 1.2.0+. |
| undici 5.29.0, [GHSA-vrm6-8vpv-qv8q](https://github.com/advisories/GHSA-vrm6-8vpv-qv8q), [GHSA-v9p9-hfj2-hcw8](https://github.com/advisories/GHSA-v9p9-hfj2-hcw8), [GHSA-vxpw-j846-p89q](https://github.com/advisories/GHSA-vxpw-j846-p89q) | These three findings affect WebSocket client handling. The retained consumer is `@vercel/blob@0.24.1`; its compiled code has no WebSocket caller. Undici 7.x was patched independently. | Upgrade the Blob SDK with its API/storage tests rather than forcing a new Undici major under the old SDK. |
| @fastify/busboy 2.1.1, [GHSA-x8mw-p69m-v3mx](https://github.com/advisories/GHSA-x8mw-p69m-v3mx) | Retained through the same Undici 5 dependency. The Blob consumer has no response `.formData()` parsing call. This is not the parser used by the application's upload route. | Upgrade with the Blob SDK; patched parser is 3.2.1+. |
| drizzle-orm 0.34.1, [GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9) | The advisory requires attacker-controlled SQL identifiers/aliases. The reviewed chatbot/researcher DB queries use static schema objects; no `sql.identifier()` or dynamic `.as()` call was found there. | Plan the ORM 0.45.2+ migration with database/migration tests. Keep identifiers mapped to static schema objects. |
| braces 3.0.3, [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | Retained through file-watching/glob tooling. No public API accepting brace patterns was identified. The advisory has no patched release at this scan. | Track upstream and do not add an API that evaluates untrusted glob patterns. |

The Cargo OSV scan still reports 16 advisory records across 13 package/version entries. Some records are unmaintained-package notices or alias duplicates. Remaining code findings include protobuf 2.x recursion, RSA timing behavior, OpenTelemetry SDK, quick-xml, and lru in inherited dependency graphs. They require feature/call-site review and coordinated parent/API migrations; this PR does not claim the Rust graph is advisory-free.

## Rollout

CI and local tests do not establish the versions running in staging or production. Rebuild with fresh system CA packages, deploy through the normal release process, record actual runtime/image/binary versions, and smoke-test authentication, MCP, remember/recall, and SEAL/Walrus flows. Publish the new MCP/Python releases through the existing workflows; update the plugin launcher pin only after its target version exists on npm. Existing package-source changes already trigger the normal dev prerelease workflows when merged.

Credential containment for the Railway disclosure remains tracked in WALM-865/WALM-872. Do not restore potentially exposed credentials as a rollback. See [runtime security updates](../contributing/security-updates.md) for environment setup and upstream sources.
