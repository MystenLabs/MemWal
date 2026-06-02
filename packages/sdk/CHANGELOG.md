# @mysten-incubation/memwal

## 0.0.7

### Patch Changes

- [#218](https://github.com/MystenLabs/MemWal/pull/218) [`333d327`](https://github.com/MystenLabs/MemWal/commit/333d3279f59c2a033225bc99238b7586474333fb) Thanks [@hungtranphamminh](https://github.com/hungtranphamminh)! - Add optional `occurredAt` to `analyze()` and `analyzeAndWait()` for temporal anchoring of extracted facts.

  - New `AnalyzeOptions` overload: `analyze(text, { namespace, occurredAt })` accepts `Date` or RFC-3339 string. The legacy `analyze(text, namespace?)` signature still works unchanged.
  - When `occurredAt` is supplied, the server resolves in-turn relative references ("last Friday", "yesterday") into absolute dates inside the extracted fact text before embedding and encryption.
  - Wire format is RFC-3339 UTC with millisecond precision (e.g. `"2023-05-25T17:50:00.000Z"`).
  - Invalid `Date` instances (constructed from malformed input) now throw a diagnostic `TypeError` from the SDK rather than an opaque `RangeError` from `toISOString()`.
  - Field is omitted from the request body when not supplied — existing callers see byte-identical wire payloads.

## 0.0.6

### Added

- Added `RecallParams` for object-style `recall(...)` calls.

### Changed

- Marked the positional `recall(...)` overload as deprecated in favor of `recall({ query, limit, namespace })`.
- Documented `restore()` response fields, default limit, pagination behavior, and performance expectations.

## 0.0.5

### Added

- Added relayer compatibility metadata checks before protected requests.
- Added `compatibility()` and exported compatibility types/errors so callers can inspect SDK/relayer support explicitly.
- Added `RecallOptions` for `topK`, namespace override, and `maxDistance`.

### Changed

- Prefer Sui gRPC for SEAL sessions, with JSON-RPC fallback.
- Updated docs/examples for `MEMWAL_PRIVATE_KEY` and hosted relayer defaults.
- Rebranded package metadata and documentation from MemWal to Walrus Memory.

### Fixed

- Made `401` relayer errors more actionable.

## 0.0.4

### Added

- Added `getRememberStatus(jobId)` so clients can poll and display the full async remember state machine.
- Added `SealServerConfig` and `sealServerConfigs` for manual-mode SEAL committee aggregator configuration.

### Changed

- Manual mode now normalizes full SEAL server configs, validates optional API key pairs, and caps the default threshold to configured server weight.
- Manual mode keeps testnet defaults on the legacy independent key servers for compatibility with hosted testnet relayer data.

## 0.0.3

### Changed

- Updated `remember()` for the relayer's async `/api/remember` flow. It now returns the accepted job payload immediately.
- Added `rememberAsync()`, `waitForRememberJob()`, and `rememberAndWait()` for callers that need the final `blob_id`.
- Added bulk remember helpers: `rememberBulk()`, `rememberBulkAsync()`, `waitForRememberJobs()`, and `rememberBulkAndWait()`.
- Updated `analyze()` for async fact storage and added `analyzeAndWait()`.

### Compatibility

- `recall()` and `restore()` remain wire-compatible with the existing relayer responses.
- The SDK continues to use `x-seal-session` for relayer-mode decrypt credentials.

## 0.0.2

### Security

- Added per-request `x-nonce` signing to block replay within the timestamp window.
- Added `x-account-id` to the canonical signed message so account hints cannot be rebound in transit.
- Replaced relayer-mode `x-delegate-key` transport with ephemeral `x-seal-session`; manual-mode requests no longer send delegate private key material.
- SDK versions that do not send `x-nonce` are no longer supported by the server and receive `426 Upgrade Required`.

## 0.0.1

### Initial Release

- `MemWal` default client — relayer-handled embedding, SEAL encryption, Walrus upload, vector search
- `MemWalManual` manual client — client-side embedding and SEAL operations
- `withMemWal` Vercel AI SDK middleware — automatic memory recall and save
- Account management utilities — `createAccount`, `addDelegateKey`, `removeDelegateKey`, `generateDelegateKey`
- Ed25519 delegate key authentication
- Namespace-scoped memory isolation
