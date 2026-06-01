# memwal

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
