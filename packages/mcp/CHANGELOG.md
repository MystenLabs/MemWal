# @mysten-incubation/memwal-mcp

## 0.0.5

### Added

- **Automatic memory plugin** for Claude Code, Codex, Cursor, and Antigravity (`plugin/`): an installable plugin that bundles the MemWal MCP server with lifecycle hooks (SessionStart, UserPromptSubmit, PostToolUse) which remind the agent to recall relevant context and save durable facts on its own — no manual prompting. Install in Claude Code via `/plugin marketplace add` + `/plugin install memwal`; install in Codex via `node plugin/scripts/install_codex_hooks.mjs`.

### Changed

- Memory tools are now **proactive**. The MCP tool descriptions instruct agents to call `memwal_recall` and `memwal_remember` on their own (rather than only when explicitly asked); a new **`memwal_remember_bulk`** tool saves several facts in one call; and a new **`memwal_health`** tool gives a fast connectivity check (use it instead of `memwal_recall` for health checks). These behaviours come from the relayer's MCP tool layer — run a matching relayer/sidecar version.

### Fixed

- Ship the plugin's `.mcp.json` in the marketplace bundle. A root gitignore rule excluded it, so plugin installs loaded the lifecycle hooks but never registered the MCP server.
- Recover from silently dead relayer SSE sessions. The bridge previously waited forever on `reader.read()` when the relayer-side session went dead while the TCP socket stayed open, causing tool calls (notably `memwal_recall`) to hang indefinitely with no diagnostic output. A heartbeat watchdog now aborts the SSE stream after `MEMWAL_MCP_SSE_IDLE_MS` (default 30s) of silence, triggering the existing reconnect path and replaying in-flight requests on the fresh session. Tunable via the `MEMWAL_MCP_SSE_IDLE_MS` env var; values below 500ms fall back to the default.

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
