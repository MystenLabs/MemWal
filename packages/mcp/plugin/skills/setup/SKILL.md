---
name: setup
description: Set up Walrus Memory for Claude Code using the bundled MCP server and current delegate-key header authentication. Use when the user asks to connect, install, authenticate, create an account, create a delegate key, log in, verify setup, or troubleshoot Walrus Memory credentials.
---

# Walrus Memory Setup

Use this skill to help a Claude Code user finish Walrus Memory setup with the plugin's bundled MCP server.

## What This Plugin Uses

This plugin uses the current Walrus Memory MCP package and delegate-key header authentication. It does not depend on the hosted Claude custom-connector OAuth flow.

The plugin starts this MCP server:

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": ["-y", "@mysten-incubation/memwal-mcp", "--label", "Claude Code Plugin"]
    }
  }
}
```

Credentials are stored locally at `~/.memwal/credentials.json` with file mode `0600`.

## Setup Flow

1. Check whether the MCP server is connected.
   - Ask the user to run `/mcp` if you cannot see MCP tool status.
   - The server name should be `memwal`.

2. If tools are available, call `memwal_health`.
   - If it reports missing credentials, call `memwal_login`.
   - If `memwal_login` is not available because the MCP server is not loaded, ask the user to restart Claude Code after installing/enabling the plugin.

3. During login, the browser opens the Walrus Memory app.
   - The user connects a Sui wallet.
   - If no Walrus Memory account exists, the app walks the user through account creation.
   - The app registers a delegate key labeled `Claude Code Plugin`.
   - The local MCP package saves delegate-key credentials to `~/.memwal/credentials.json`.

4. After login, verify with `memwal_health`.

5. Test end-to-end:
   - Save a harmless setup fact with `memwal_remember`.
   - Recall it with `memwal_recall`.

## Troubleshooting

- If the browser flow finishes but Claude Code still says credentials are missing, restart Claude Code so the MCP process reloads.
- If the wallet already has 20 delegate keys, ask the user to open the Walrus Memory dashboard and revoke an unused key.
- If the user needs a clean login, call `memwal_logout`, then call `memwal_login` again.
- If recall returns nothing for memories that should exist, call `memwal_restore` with the relevant namespace.

