---
"@mysten-incubation/memwal-mcp": patch
---

Recover from silently dead relayer SSE sessions. The bridge previously waited
forever on `reader.read()` when the relayer-side session went dead while the
TCP socket stayed open, causing tool calls (notably `memwal_recall`) to hang
indefinitely with no diagnostic output. A heartbeat watchdog now aborts the
SSE stream after `MEMWAL_MCP_SSE_IDLE_MS` (default 30s) of silence, triggering
the existing reconnect path and replaying in-flight requests on the fresh
session. Tunable via the `MEMWAL_MCP_SSE_IDLE_MS` env var; values below 500ms
are clamped to the default.
