# Walrus Memory Plugin

Walrus Memory gives AI coding tools durable, user-owned memory through the `@mysten-incubation/memwal-mcp` server.

This repo is packaged for the Claude Code plugin marketplace, and the same MCP server also works in Codex, OpenCode, Cursor, Claude Desktop, and other MCP clients.

## What Is Included

- Claude Code plugin manifest: `.claude-plugin/plugin.json`
- MCP server config: `.mcp.json`
- Slash commands: `commands/`
- Setup skill: `skills/setup/`
- Lifecycle hooks: `hooks/hooks.json`
- Optional Codex hook installer: `scripts/install_codex_hooks.mjs`

## Quick Start

For Claude Code local review:

```bash
claude plugin validate . --strict
claude --plugin-dir .
```

Inside Claude Code:

```text
/memwal:setup
/memwal:health
/memwal:remember I use Walrus Memory from Claude Code.
/memwal:recall Claude Code Walrus Memory setup
```

For Codex MCP-only testing, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.memwal]
command = "npx"
args = ["-y", "@mysten-incubation/memwal-mcp", "--label", "Codex"]
```

Restart Codex, then ask:

```text
Call memwal_login and help me connect Walrus Memory.
Call memwal_health.
Remember that Codex successfully connected to Walrus Memory.
Recall Codex Walrus Memory.
```

## Commands

Claude Code slash commands:

- `/memwal:setup`
- `/memwal:health`
- `/memwal:remember`
- `/memwal:recall`
- `/memwal:analyze`
- `/memwal:restore`
- `/memwal:logout`

MCP tools exposed to all supported MCP clients:

- `memwal_login`
- `memwal_logout`
- `memwal_health`
- `memwal_remember`
- `memwal_remember_bulk`
- `memwal_recall`
- `memwal_analyze`
- `memwal_restore`

## Usage Guides

- [Claude Code setup](docs/usage/claude-code.md)
- [Codex setup and testing](docs/usage/codex.md)
- [Other MCP clients](docs/usage/other-clients.md)
- [Hosted Claude custom connector](docs/usage/hosted-connector.md)
- [Full setup skill guide](skills/setup/SETUP.md)

## Auth Model

The plugin path uses local stdio MCP plus delegate-key custom-header auth. On first use, `memwal_login` opens the browser login flow, creates or finds the user's Walrus Memory account, registers a delegate key, and stores local credentials at:

```text
~/.memwal/credentials.json
```

This is separate from the hosted Claude custom-connector OAuth endpoint.
