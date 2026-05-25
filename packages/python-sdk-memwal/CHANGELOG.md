# memwal

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
