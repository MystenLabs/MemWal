# @mysten-incubation/memwal-mcp

## 0.0.5

### Added

- Automatic memory plugin for Claude Code, Codex, Cursor, and Antigravity.
- New `memwal_remember_bulk` and `memwal_health` tools.

### Fixed

- Ship the plugin's `.mcp.json` in the marketplace bundle. A root gitignore rule excluded it, so plugin installs loaded the lifecycle hooks but never registered the MCP server.

### Changed

- Memory tools are now proactive — agents recall and save context on their own.

### Fixed

- Plugin bundle now ships its `.mcp.json` so the MCP server registers on install.
- Automatically recover from dropped relayer connections that could hang tool calls.

## 0.0.4

### Fixed

- Accept HTTPS dashboard sign-in callbacks to the local `127.0.0.1` MCP listener.
- Reload credentials after `memwal_login` so memory tools work without restarting the MCP client.

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
