---
title: Cursor
description: >-
  Add portable Walrus Memory to Cursor through the MemWal MCP server.
  Cursor supports MCP-only installation and optional lifecycle hooks via its plugin system.
keywords:
  - MCP
  - Cursor
  - Walrus Memory
  - MemWal
  - plugin
  - automatic memory
goal:
  description: Install and configure MemWal on Cursor as an MCP server with optional plugin hooks.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 300
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - How do I add Walrus Memory to Cursor?
  - How do I configure the MemWal MCP server for Cursor?
  - Does Cursor support MemWal lifecycle hooks?
answer: >-
  To add Walrus Memory to Cursor, configure the MemWal MCP server in ~/.cursor/mcp.json using npx -y @mysten-incubation/memwal-mcp as the command. Cursor also supports optional lifecycle hooks via its plugin system for session start, before prompt, and post-tool events. The MCP-only setup already provides proactive save and recall through tool descriptions, so the hooks are optional reinforcement.
---

Add MemWal to Cursor so the agent can save and recall durable facts. The **MCP server** (memory tools, below) works on every Cursor version; Cursor's plugin system can also add **lifecycle hooks** for extra reinforcement (see [Lifecycle hooks](#lifecycle-hooks-plugin)).

## Prerequisites

- Node.js 20+
- A Walrus Memory account. The first memory tool call opens a browser sign-in (`memwal_login`).

## Installation

Add the server to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": ["-y", "@mysten-incubation/memwal-mcp"]
    }
  }
}
```

To pin a default namespace, pass `"--namespace", "<name>"` in `args` (or set `MEMWAL_NAMESPACE` in `env`). Restart Cursor (MCP servers load at startup), then ask the agent to run `memwal_login` on first use.

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

## Lifecycle hooks (plugin)

Beyond the MCP tools, Cursor's plugin system can run **lifecycle hooks** that reinforce automatic memory:

| Hook | Cursor event | What it does |
|------|--------------|--------------|
| Session start | `sessionStart` | Reminds the agent to use the `memwal_*` tools. |
| Before prompt | `beforeSubmitPrompt` | Detects recall/remember intent and reminds the agent. |
| Post-tool | `postToolUse` (Bash) | On command errors, reminds the agent to recall prior fixes. |

The hook scripts ship inside the plugin bundle (`packages/mcp/plugin/`); hook support depends on your Cursor version. The MCP-only setup above already gives proactive save/recall, so the hooks are an optional reinforcement.

## Verify

Ask the agent what MCP tools it has available. You should see the `memwal_*` tools. State a durable fact (for example, a preferred package manager) and confirm the agent saves it with `memwal_remember`.

## Troubleshooting

- **Tools missing**: restart Cursor; check the MCP connection status in Settings.
- **Not signed in**: ask the agent to run `memwal_login`, approve in the browser, then retry.
- **`memwal_recall` returns nothing although you saved before**: run `memwal_restore <namespace>` to rebuild the index from Walrus.
