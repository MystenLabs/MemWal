---
title: Claude Desktop
description: >-
  Add portable Walrus Memory to Claude Desktop through the MemWal MCP server.
  Claude Desktop supports MCP-only installation with proactive memory tools.
keywords:
  - MCP
  - Claude Desktop
  - Walrus Memory
  - MemWal
  - memory tools
goal:
  description: Add the MemWal MCP server to Claude Desktop's configuration, authenticate, and verify that memory tools are available in your Claude Desktop session.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 50
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - How do I add Walrus Memory to Claude Desktop?
  - How do I configure the MemWal MCP server for Claude Desktop?
  - Does Claude Desktop support the MemWal automatic memory plugin?
answer: >-
  To add Walrus Memory to Claude Desktop, configure the MemWal MCP server in your claude_desktop_config.json file using npx -y @mysten-incubation/memwal-mcp as the command. Claude Desktop supports MCP-only (not the plugin with lifecycle hooks). The tool descriptions still make the agent save and recall proactively. Restart Claude Desktop fully (Cmd+Q) after installation, then ask the agent to run memwal_login on first use.
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

<Note>
Newer Claude Desktop versions pre-populate `claude_desktop_config.json` with other top-level keys (such as `preferences`) and no `mcpServers` block. Add `mcpServers` as a sibling of the existing keys rather than replacing the file. If an `mcpServers` block already exists, add the `memwal` entry inside it alongside any other servers.
</Note>

Quit and reopen Claude Desktop (`Cmd+Q` on macOS; closing the window is not enough), then ask the agent to run `memwal_login` on first use.

## Available tools

| Tool | Description |
|------|-------------|
| `auto_save_user_facts_to_memory` | Proactively save a durable fact (preference, decision, constraint, identity). |
| `memwal_remember_bulk` | Save several distinct facts in one call. |
| `memwal_recall` | Semantic search across stored memories for relevant context. |
| `memwal_analyze` | Extract and save multiple facts from a passage of text. |
| `memwal_restore` | Rebuild the search index from Walrus (recovery). |
| `memwal_health` | Fast connectivity check. |
| `memwal_login` / `memwal_logout` | Connect or disconnect this client. |

The tool descriptions tell the agent to save and recall proactively. See [Reference](/mcp/reference) for full parameters.

## Verify

Ask the agent what MCP tools it has available. You should see the Walrus Memory tools. State a durable fact and confirm the agent saves it with `auto_save_user_facts_to_memory`. If your version exposes MCP prompts, invoke **Use Walrus Memory Proactively** from the `/` menu once per chat.

## Troubleshooting

- **Tools missing**: fully quit and reopen Claude Desktop (`Cmd+Q`).
- **Not signed in**: ask the agent to run `memwal_login`, approve in the browser, then retry.
- **`memwal_recall` returns nothing although you saved before**: run `memwal_restore <namespace>` to rebuild the index from Walrus.
