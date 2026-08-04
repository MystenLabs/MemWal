---
title: MCP Quick Start
description: >-
  Add Walrus Memory to any MCP client in one step, with per-client setup for Claude Code,
  Claude Desktop, Cursor, Codex, OpenCode, and Antigravity, plus verification and sign-in.
keywords:
  - MCP
  - quick start
  - Walrus Memory
  - MemWal
  - Claude Code
  - Claude Desktop
  - Cursor
  - Codex
  - OpenCode
  - Antigravity
goal:
  description: Add the MemWal MCP server to your AI client from one consolidated page, sign in with memwal_login, and verify the memory tools respond.
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
  - How do I add Walrus Memory to my MCP client?
  - Which MCP clients does Walrus Memory support?
  - What is the MemWal MCP setup command for my editor?
answer: >-
  Every supported client runs the same server, npx -y @mysten-incubation/memwal-mcp, and differs
  only in where the configuration lives. Claude Code uses claude mcp add or the plugin, Claude
  Desktop and Cursor use a JSON mcpServers block, Codex uses config.toml, OpenCode uses
  opencode.json, and Antigravity accepts the plugin or a JSON block. After adding the server,
  restart the client and ask the agent to run memwal_login.
---

Every supported client runs the same local server, `npx -y @mysten-incubation/memwal-mcp`, and differs only in where the configuration lives. Pick your client below, add the server, restart, and sign in.

See also:

- [Overview](/mcp/overview): how the local server bridges tool calls to the relayer
- [Reference](/mcp/reference): every tool with full parameters and transports

## Prerequisites

- Node.js 20+ (the server runs with `npx`, no install step).
- A Walrus Memory account. The first tool call triggers `memwal_login`, which opens a browser to connect your wallet; no keys go in config files.

## Set up your client

| **Client** | **Where the config lives** | **Setup** |
| --- | --- | --- |
| Claude Code | Managed by the CLI | `claude mcp add --scope user memwal -- npx -y @mysten-incubation/memwal-mcp`, or install the [plugin](/mcp/claude-code) for automatic-memory hooks |
| Claude Desktop | `claude_desktop_config.json` | Add the [JSON block](#json-clients) below; see [Claude Desktop](/mcp/claude-desktop) for the per-OS file path |
| Cursor | `~/.cursor/mcp.json` | Add the [JSON block](#json-clients) below; hooks are [optional](/mcp/cursor) |
| Codex | `~/.codex/config.toml` | Add the [TOML block](#codex) below; hooks need a [repo install](/mcp/codex) |
| OpenCode | `~/.config/opencode/opencode.json` | Add the [OpenCode block](#opencode) below |
| Antigravity | Plugin directory or MCP config | `npx degit MystenLabs/MemWal/packages/mcp/plugin ~/.gemini/config/plugins/memwal`, or the [JSON block](#json-clients); see [Antigravity](/mcp/antigravity) |

After any of these, restart the client (MCP servers load at startup) and ask the agent to run `memwal_login`.

### JSON clients

Claude Desktop, Cursor, and Antigravity's MCP config all take the same shape:

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

### Codex

```toml
[mcp_servers.memwal]
command = "npx"
args = ["-y", "@mysten-incubation/memwal-mcp"]
```

### OpenCode

```json
{
  "mcp": {
    "memwal": {
      "type": "local",
      "command": ["npx", "-y", "@mysten-incubation/memwal-mcp"],
      "enabled": true
    }
  }
}
```

## Configure a namespace

Recall is scoped per account and namespace. To keep a client's memories in their own space, set the `MEMWAL_NAMESPACE` environment variable in the server entry (`env` in JSON configs, `environment` in OpenCode), or pass `"--namespace", "<name>"` in `args`. Without it, memories go to the `default` namespace.

## Verify

1. Open your client's MCP status view (for example `/mcp` in Claude Code) and confirm `memwal` shows as connected with tools listed.
2. Ask the agent to run `memwal_health`; it returns a fast connectivity check against the relayer.
3. State a durable fact, for example a package-manager preference, confirm the agent calls `memwal_remember`, then start a fresh session and confirm `memwal_recall` finds it.

If a step fails, run `npx -y @mysten-incubation/memwal-mcp --help` in a terminal to surface the real error, and set `MEMWAL_MCP_DEBUG=1` in the server's environment for verbose logging. The [Claude Code page](/mcp/claude-code#troubleshooting-faq) carries the full troubleshooting FAQ; the errors apply to every client.

