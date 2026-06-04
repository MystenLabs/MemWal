# @mysten-incubation/memwal-mcp

## 0.0.4

### Fixed

- Accept the browser sign-in callback on `127.0.0.1` when the dashboard is served over HTTPS. The local login listener now answers Chrome's Private Network Access preflight (`Access-Control-Allow-Private-Network`), so the on-chain registration no longer succeeds while the callback is silently blocked.
- Pick up credentials without a second restart. After `memwal_login` writes `~/.memwal/credentials.json`, the next memory tool call hands off to the bridge in the same process instead of reporting "not signed in" until the client is restarted.

## 0.0.3

### Changed

- Rebranded package metadata and documentation from MemWal to Walrus Memory.

## 0.0.2

### Added

- Added relayer compatibility metadata checks before opening the MCP bridge.

## 0.0.1

### Initial Release

- Stdio MCP server for MemWal with browser-based wallet login.
- Inline `memwal_login` and `memwal_logout` session tools.
- Memory tools for remember, recall, analyze, and restore through the Walrus Memory relayer.
- Environment presets for production, dev, staging, and local relayers.
