---
title: Claude Desktop
description: Add portable Walrus Memory to Claude Desktop through the MemWal MCP server.
keywords: [MCP, Claude Desktop, Walrus Memory, MemWal, memory]
---

Add MemWal to Claude Desktop so the agent can save and recall durable facts. Claude Desktop uses the **MCP server** (the memory tools); the automatic-memory plugin hooks are available on [Claude Code](/mcp/claude-code), [Codex](/mcp/codex), [Cursor](/mcp/cursor), and [Antigravity](/mcp/antigravity).

## Prerequisites

- Node.js 20+
- A Walrus Memory account. The first memory tool call opens a browser sign-in (`memwal_login`).

## Installation

Add the server to your Claude Desktop config:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": ["-y", "@mysten-incubation/memwal-mcp"],
      "env": { "MEMWAL_NAMESPACE": "default" }
    }
  }
}
```

Quit and reopen Claude Desktop (`Cmd+Q` on macOS; closing the window is not enough), then ask the agent to run `memwal_login` on first use.

## Available tools

| Tool | Description |
|------|-------------|
| `memwal_remember` | Save a durable fact (preference, decision, constraint, identity). |
| `memwal_remember_bulk` | Save several distinct facts in one call. |
| `memwal_recall` | Semantic search across stored memories for relevant context. |
| `memwal_analyze` | Extract and save multiple facts from a passage of text. |
| `memwal_restore` | Rebuild the search index from Walrus (recovery). |
| `memwal_health` | Fast connectivity check. |
| `memwal_login` / `memwal_logout` | Connect or disconnect this client. |

The tool descriptions tell the agent to save and recall proactively. See [Reference](/mcp/reference) for full parameters.

## Verify

Ask the agent what MCP tools it has available. You should see the `memwal_*` tools. State a durable fact and confirm the agent saves it with `memwal_remember`.

## Troubleshooting

- **Tools missing**: fully quit and reopen Claude Desktop (`Cmd+Q`).
- **Not signed in**: ask the agent to run `memwal_login`, approve in the browser, then retry.
- **`memwal_recall` returns nothing although you saved before**: run `memwal_restore <namespace>` to rebuild the index from Walrus.
