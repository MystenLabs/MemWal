---
"@mysten-incubation/memwal-mcp": patch
---

Send proactive-usage instructions in the MCP `initialize` handshake (#681, WALM-324).

Clients switched to lazy tool loading, so tool schemas no longer enter the model's context until a tool is explicitly loaded. The entire "when to save / when to recall" contract lived inside those descriptions, so the model stopped using Walrus Memory proactively: it either offered its own built-in memory or denied the tool existed, and only worked if the user prefixed the prompt with "using the memwal tools...".

The MCP `instructions` field travels with `initialize`, before any `tools/list`, so lazy loading cannot strip it, and clients inject it into the model's system prompt. Both local responders now send it: the bridge's cold-start `initialize` (which answers locally and suppresses the relayer's reply, so it was the one that actually reached stdio clients) carries the full recall/remember/recover guidance, while the signed-out auth-required stub instead points at `memwal_login`, since every memory tool fails without credentials.

Also replaces the hardcoded `serverInfo.version: "0.0.1"` in both handshakes with the real package version, so handshake logs identify which build a user is running. This is distinct from `MEMWAL_MCP_COMPATIBILITY_VERSION`, which stays pinned as the relayer-contract baseline.
