---
"@mysten-incubation/memwal-mcp": patch
---

Make `memwal_logout` actually revoke access on the running bridge (#616).

Logout previously deleted `~/.memwal/credentials.json` and nothing else. The bridge kept the delegate key in memory and kept its SSE session open, so every later `memwal_recall` / `memwal_remember` was still forwarded to the relayer and executed under the key the user had just removed — and `memwal_logout` is the only revocation path in bridge mode.

Logout now tears the session down: it aborts the SSE stream, fails anything still in flight, and refuses every memory tool locally until the next `memwal_login`. The connect and reconnect paths honour the signed-out state too, so an in-flight handshake that completes after logout is discarded rather than published. Signing back in restores service without restarting the MCP client.
