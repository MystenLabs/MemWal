# memwal

## Unreleased

### Fixed

- `wait_for_remember_jobs` / `remember_bulk_and_wait` no longer return a batch they could not read as if it were still uploading. When every status poll is rate-limited, the wait makes one confirming read and raises `MemWalRateLimited` (`status` 429, `job_ids`, `retry_after`) if that is refused too. An item still unsettled at the deadline names its last known status, or says no read got through. (WALM-671, #967)
- `with_memwal_*` gains `save_mode` and confirmable saves: `memwal_wait_for_saves` (async and sync) polls every job the middleware enqueued, and restores the job ids if that poll raises so a retry can still confirm them. (WALM-307, #410, #412)
- `wait_for_remember_jobs` chunks its status reads to the relayer's 20-id `MAX_BULK_ITEMS` cap. Above it the relayer answers a non-transient 400, so a wait over 21+ jobs raised on every attempt and could never confirm — reachable from `save_mode="remember"` after 21 turns, or from two fat `analyze` extracts. (WALM-307)

## 0.1.12

### Fixed

- Grow `wait_for_remember_job` / `wait_for_remember_jobs` poll delay 1.5× from the caller interval (floor 100ms) toward a 5s cap, with an immediate first poll. Backoff is disabled above the cap. (WALM-623)
- A 429 during a remember-job wait is reported on the timeout. Retry-After is still clamped to the caller's remaining budget, and that remainder still buys one status read. (WALM-623)

## 0.1.11

### Added

- `list_namespaces(cursor=None, limit=None)` lists the namespaces that hold memories (name, `memory_count`, `storage_used`, `updated_at`), so an agent can discover namespaces instead of guessing. Metadata only; no decryption. Paginate on `has_more`. `MemWalSync` and the mock clients have it too.

## 0.1.10

### Added

- `restore()` results include `failed` (default `0`) for permanent decrypt/UTF-8 failures instead of folding them into `skipped` or dropping them silently.

## 0.1.9

### Fixed

- HTTP 503 with `x-auth-error: AUTH_UPSTREAM_UNAVAILABLE` is reported as a retryable credential-verification outage, not a sign-in failure. Other 503s keep the generic sanitized body.
- `remember_bulk_async` rejects an empty `items` list before the request and raises when the relayer returns a `job_ids` length that does not match the batch.
- restore `truncated` docs now match WALM-431 retryable semantics.
- Warn when `server_url` uses plaintext `http://` against a non-localhost host, matching the TypeScript SDK `normalizeServerUrl` guard. Localhost, `127.0.0.1`, `::1`, and `*.localhost` are exempt; invalid URLs are left for the HTTP client to surface. The warning logs only scheme, host, and port so URL userinfo is not written to logs.

## 0.1.8

### Added

- `recall()` results include `dropped_count` when the relayer omitted matches that failed to download or decrypt.
- `health()` surfaces optional `write_ready` when the relayer reports write-path sidecar liveness.
- Added `MemWalClockDriftError`, raised when the relayer rejects a request because the signed timestamp is outside its accepted clock-drift window (`401` + `x-auth-error: ERR_TIMESTAMP_OUT_OF_BOUNDS`). Surfaces an actionable "synchronize the client clock" message instead of an opaque `401`. Subclasses `MemWalError`, so existing `except MemWalError` handlers still catch it.
- Added the `dev` relayer preset (`https://relayer.dev.memwal.ai`) to `ENV_PRESETS`.

### Fixed

- `hex_to_bytes` now rejects empty, odd-length, whitespace, and non-hex input instead of silently decoding a different key.
- `remember_manual` sends `encrypted_data` (base64 SEAL ciphertext) instead of a pre-uploaded `blob_id`, matching `POST /api/remember/manual`.
- HTTP error messages and remember-job error strings no longer forward `localhost` / `127.0.0.1` URLs to callers.

## 0.1.7

### Added

- Added deterministic async and sync mock clients for credential-free tests.
- Added idempotency keys to collapse retries onto one paid remember job.

## 0.1.6

### Added

- Added flush helpers for pending middleware auto-saves.
- Added `truncated` to restore results for incomplete recovery.

### Fixed

- Linked `AUTH_REJECTED` errors to troubleshooting guidance.

## 0.1.5

### Added

- Added a runnable [Walrus Memory Python SDK Colab](https://colab.research.google.com/drive/1SaKjkSp0DXnM_nktWSiEC-l9qGtVr6ph) covering installation, secure `staging` configuration, optional `prod`, `MemWalSync`, health/compatibility checks, delegate public-key/address derivation, `remember`, `remember_async`, async job waiting, `recall`, bulk remember, `remember_bulk_async`, `remember_bulk_and_wait`, optional `ask`, `analyze`, `analyze_and_wait`, `embed`, manual methods with scoring weights, `restore`, optional OpenAI/LangChain middleware, OpenAI-compatible provider settings such as `OPENAI_BASE_URL`, and troubleshooting.

### Fixed

- Fixed `MemWalSync` reuse inside notebooks so repeated calls do not reuse an HTTP transport from a closed event loop.

### Security

- Recalled AI memory is now nonce-delimited, explicitly untrusted JSON data with a fixed trust instruction instead of a system-role memory injection.

## 0.1.4

### Added

- Added optional `occurred_at` to `analyze()` and `analyze_and_wait()` (both async and sync) for temporal anchoring of extracted facts. When supplied, the server resolves in-turn relative references ("last Friday", "yesterday") into absolute dates inside the extracted fact text before embedding and encryption.
- Accepts `datetime` or RFC-3339 string. Wire format is RFC-3339 UTC with millisecond precision (e.g. `"2023-05-25T17:50:00.000Z"`) — byte-identical to the TypeScript SDK.
- Field is omitted from the request body when not supplied.

### Changed

- `occurred_at` validates input at the SDK boundary rather than forwarding malformed values to the server: naïve `datetime` instances raise `ValueError` (silently assuming UTC would mis-anchor by N hours for callers outside UTC), and malformed RFC-3339 strings raise `ValueError` with a diagnostic message instead of surfacing as opaque 400s.

## 0.1.3

### Added

- Added `RecallParams` for object-style `recall(...)` calls.

### Changed

- Changed the default `restore()` limit from `50` to `10` to match the relayer and TypeScript SDK.
- Documented `restore()` response fields, default limit, pagination behavior, and performance expectations.

## 0.1.2

### Added

- Added `max_distance` to async and sync `recall()`.
- Added credential verification helper.

### Changed

- Updated docs/examples to use `MEMWAL_PRIVATE_KEY`.
- Rebranded package metadata and documentation from MemWal to Walrus Memory.

### Fixed

- Made `401` relayer errors more actionable.

## 0.1.1

### Added

- Added relayer `env` presets.
- Added compatibility checks and `compatibility()` helpers.

## 0.1.0

### Initial Release

- `MemWal` async client and `MemWalSync` sync wrapper
- Memory APIs: `remember`, `recall`, `analyze`, `ask`, `restore`, `health`
- Async job helpers for remember, bulk remember, and analyze
- LangChain/OpenAI middleware and delegate-key utilities
- Ed25519 delegate-key auth with namespace-scoped memory isolation
