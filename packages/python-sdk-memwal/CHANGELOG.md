# memwal

## Unreleased

### Added

- Added a runnable [Walrus Memory Python SDK Colab](https://colab.research.google.com/drive/1SaKjkSp0DXnM_nktWSiEC-l9qGtVr6ph) covering installation, secure `staging` configuration, optional `prod`, health checks, async `remember` and `remember_async` job waiting, `recall`, bulk remember, `remember_bulk_async`, manual methods with scoring weights, middleware examples, OpenAI-compatible provider settings such as `OPENAI_BASE_URL`, and troubleshooting.

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
