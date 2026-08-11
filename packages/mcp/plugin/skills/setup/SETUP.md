# Walrus Memory Claude Code Plugin Setup

This guide is for the Walrus Memory Claude Code marketplace plugin. It covers the current plugin auth model: local MCP plus delegate-key custom-header auth.

This plugin does not use the hosted Claude custom-connector OAuth flow. OAuth connector work and Claude Code plugin setup are separate surfaces.

## Hosted Claude Custom Connector URL

If you are testing Claude's native hosted custom connector, use the remote MCP endpoint below in Claude's connector UI:

```text
https://relayer.dev.memwal.ai/api/mcp
```

Discovery endpoints:

```text
https://relayer.dev.memwal.ai/.well-known/oauth-authorization-server
https://relayer.dev.memwal.ai/.well-known/oauth-protected-resource
```

That hosted connector flow uses OAuth. It should let Claude add the remote endpoint, complete login and consent, then call `tools/list` and representative memory tools without the user manually pasting delegate private keys or custom headers.

This setup skill is for the Claude Code plugin path, which is separate: local stdio MCP plus delegate-key custom-header auth through `@mysten-incubation/memwal-mcp`.

## What Gets Installed

The plugin ships these Claude Code components:

- `.claude-plugin/plugin.json`: plugin metadata for Claude Code and marketplace validation.
- `.mcp.json`: starts the Walrus Memory MCP server with `npx -y @mysten-incubation/memwal-mcp`.
- `skills/setup/SKILL.md`: setup and troubleshooting instructions for Claude.
- `commands/`: slash-command shortcuts for setup, health, remember, recall, analyze, restore, and logout.
- `hooks/hooks.json`: lifecycle hooks that remind Claude to recall and save durable context.

The MCP server uses the current custom-header auth path. After login, the MCP package signs relayer requests with the delegate key and sends the existing account-bound headers expected by the relayer.

## Commands And Tools

The slash commands are Claude Code conveniences. The MCP server supports more than `/remember` and `/recall`.

Slash commands included in this plugin:

| Command | Purpose |
| --- | --- |
| `/memwal:setup` | Connect Walrus Memory and verify the tools. |
| `/memwal:health` | Check credential and relayer health. |
| `/memwal:remember` | Save one durable fact. |
| `/memwal:recall` | Search memory. |
| `/memwal:analyze` | Extract and save multiple durable facts from text. |
| `/memwal:restore` | Rebuild the search index for a namespace. |
| `/memwal:logout` | Remove local credentials. |

MCP tools exposed by the server:

| Tool | Purpose |
| --- | --- |
| `memwal_login` | Start browser login and create local credentials. |
| `memwal_logout` | Remove local credentials. |
| `memwal_health` | Check server/auth health. |
| `memwal_remember` | Save one durable fact. |
| `memwal_remember_bulk` | Save multiple durable facts. |
| `memwal_recall` | Semantic memory search. |
| `memwal_analyze` | Extract durable facts from a passage and save them. |
| `memwal_restore` | Rebuild a namespace search index from Walrus. |

Codex, OpenCode, Cursor, Claude Desktop, and other MCP clients can use these MCP tools through config even when they cannot install Claude Code slash commands.

## Claude Code Plugin vs Other IDEs

This repository is prepared for the Claude Code plugin marketplace. Claude Code is the primary target because it understands Claude plugin manifests, skills, slash commands, MCP server config, and lifecycle hooks from one plugin bundle.

The same Walrus Memory MCP server also works in other IDEs and agent clients, but the installation shape is different:

| Client | Recommended setup | What works |
| --- | --- | --- |
| Claude Code | Install this plugin | MCP tools, setup skill, slash commands, lifecycle hooks |
| Codex | MCP-only, or clone repo and run the Codex hook installer | MCP tools everywhere; hooks if installed manually |
| OpenCode | MCP-only | MCP tools |
| Cursor | MCP-only, optional Cursor hook config | MCP tools; hooks depend on Cursor plugin support |
| Claude Desktop | MCP-only | MCP tools |

The auth model is the same across all clients: `@mysten-incubation/memwal-mcp` performs the browser login once, stores credentials locally, and then signs relayer requests using delegate-key custom-header auth.

If a client does not support Claude Code plugins, use the MCP-only config snippets below. The tools still work: `memwal_login`, `memwal_health`, `memwal_remember`, `memwal_recall`, `memwal_analyze`, `memwal_restore`, and `memwal_logout`.

## Prerequisites

- Claude Code installed and authenticated.
- Node.js 20 or newer, because the MCP server runs through `npx`.
- Browser access for the one-time wallet login.
- A Sui wallet that can approve the Walrus Memory setup transaction.

## Install From The Plugin Repo

For local review before marketplace submission:

```bash
claude --plugin-dir .
```

For marketplace install after publication, install the marketplace entry from Claude Code's `/plugin` UI or the marketplace command approved for the final repo.

After install, restart Claude Code or run:

```text
/reload-plugins
```

Then check:

```text
/plugin
/mcp
```

Expected result:

- Plugin namespace appears as `memwal`.
- MCP server appears as `memwal`.
- Tools include `memwal_login`, `memwal_health`, `memwal_remember`, `memwal_recall`, `memwal_analyze`, `memwal_restore`, and `memwal_logout`.

## MCP-Only Setup For Other Clients

Use these snippets when the target client is not Claude Code, or when you only want the memory tools without plugin hooks.

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.memwal]
command = "npx"
args = ["-y", "@mysten-incubation/memwal-mcp", "--label", "Codex"]
```

Optional namespace:

```toml
[mcp_servers.memwal]
command = "npx"
args = ["-y", "@mysten-incubation/memwal-mcp", "--label", "Codex", "--namespace", "work"]
```

Restart Codex, then ask the agent to call `memwal_login`.

Codex hook support is separate from Claude Code plugin support. If you cloned the full MemWal repo and want hook nudges, run:

```bash
node packages/mcp/plugin/scripts/install_codex_hooks.mjs
```

Then enable hooks in `~/.codex/config.toml`:

```toml
[features]
codex_hooks = true
```

Do not also add a duplicate `[mcp_servers.memwal]` entry if the installer already added one.

### OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "memwal": {
      "type": "local",
      "command": ["npx", "-y", "@mysten-incubation/memwal-mcp", "--label", "OpenCode"],
      "enabled": true
    }
  }
}
```

Optional namespace:

```json
{
  "mcp": {
    "memwal": {
      "type": "local",
      "command": ["npx", "-y", "@mysten-incubation/memwal-mcp", "--label", "OpenCode"],
      "environment": {
        "MEMWAL_NAMESPACE": "work"
      },
      "enabled": true
    }
  }
}
```

Restart OpenCode, then ask the agent to call `memwal_login`.

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": ["-y", "@mysten-incubation/memwal-mcp", "--label", "Cursor"]
    }
  }
}
```

Optional namespace:

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": ["-y", "@mysten-incubation/memwal-mcp", "--label", "Cursor"],
      "env": {
        "MEMWAL_NAMESPACE": "work"
      }
    }
  }
}
```

Restart Cursor and verify the `memwal` server is connected in Cursor's MCP settings.

### Claude Desktop

Add to Claude Desktop's config:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\\Claude\\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": ["-y", "@mysten-incubation/memwal-mcp", "--label", "Claude Desktop"]
    }
  }
}
```

If the file already has other top-level keys, add `mcpServers` as a sibling instead of replacing the whole file.

Fully quit and reopen Claude Desktop, then ask the agent to call `memwal_login`.

## Authenticate

Start setup from Claude Code:

```text
/memwal:setup
```

Or ask plainly:

```text
Connect Walrus Memory.
```

Claude should call `memwal_health` first. If local credentials are missing, Claude should call `memwal_login`.

`memwal_login` opens a browser-based login flow. The flow:

1. Opens the Walrus Memory web app.
2. Prompts the user to connect a Sui wallet.
3. Looks up the wallet's Walrus Memory account.
4. If no account exists, walks the user through account creation.
5. Registers a delegate key labeled `Claude Code Plugin`.
6. Saves local MCP credentials at:

```text
~/.memwal/credentials.json
```

The credentials file contains the delegate key needed by the local MCP package. It should be treated as sensitive and is written with owner-only file permissions where supported.

## Verify End To End

After login, ask Claude Code:

```text
Check Walrus Memory health.
```

Then test save and recall:

```text
/memwal:remember Walrus Memory Claude Code plugin setup was verified from Claude Code.
```

```text
/memwal:recall Claude Code plugin setup verified
```

Expected result:

- `memwal_health` succeeds.
- `memwal_remember` stores the fact.
- `memwal_recall` returns the fact or a close semantic match.

## Optional Namespace

By default, memories go to the relayer's default namespace unless the agent passes a namespace.

To pin a default namespace, update `.mcp.json` before packaging or configure the MCP server with:

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": [
        "-y",
        "@mysten-incubation/memwal-mcp",
        "--label",
        "Claude Code Plugin",
        "--namespace",
        "work"
      ]
    }
  }
}
```

Per-call `namespace` values still win over the configured default.

## Logout And Reconnect

To clear local credentials:

```text
Ask Claude to call memwal_logout.
```

Or from a terminal:

```bash
npx -y @mysten-incubation/memwal-mcp --logout
```

Then run `/memwal:setup` again.

## Troubleshooting

### MCP Server Not Connected

Symptoms:

- `/mcp` does not show `memwal`.
- Claude cannot see `memwal_login`.

Fix:

1. Confirm Node.js 20+ is installed.
2. Restart Claude Code or run `/reload-plugins`.
3. Reopen `/mcp`.
4. If needed, run Claude Code with the local plugin directory and inspect plugin errors:

```bash
claude --plugin-dir .
```

### Login Completed But Tools Still Say Missing Credentials

The MCP process may have started before credentials existed.

Fix:

1. Run `memwal_health` again.
2. If still missing, restart Claude Code.
3. Confirm the credentials file exists:

```bash
ls -l ~/.memwal/credentials.json
```

Do not paste the contents of this file into chat.

### Wallet Has No Walrus Memory Account

The browser setup flow should create one. After account creation, the app returns to the connector flow and registers the delegate key.

If the user lands on the dashboard instead of completing setup, restart `/memwal:setup` and run `memwal_login` again.

### Maximum Delegate Keys

Walrus Memory accounts currently cap delegate keys. If the transaction fails with a max delegate-key error, open the Walrus Memory dashboard and revoke an unused key, then run setup again.

### Recall Returns Nothing

If memories were saved before but search returns no useful result, rebuild the index for the namespace:

```text
Ask Claude to call memwal_restore with the namespace you use.
```

Then retry `/memwal:recall`.

### Need Non-Production Environments

The marketplace plugin defaults to production. For dev or staging testing, adjust `.mcp.json` before local validation:

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": [
        "-y",
        "@mysten-incubation/memwal-mcp",
        "--dev",
        "--label",
        "Claude Code Plugin"
      ]
    }
  }
}
```

Use production settings for marketplace submission unless the PM explicitly asks for a dev-only test package.

## Marketplace Validation

Run validation from the plugin repo root:

```bash
claude plugin validate . --strict
```

Expected output:

```text
Validating plugin manifest: .../.claude-plugin/plugin.json
Validation passed
```

The current prepared repo should pass validation before submission.

## Reviewer Notes

For marketplace reviewers:

- The plugin does not request OAuth credentials.
- It starts a local stdio MCP server with `npx`.
- The login flow is user-initiated through `memwal_login`.
- The delegate key is stored locally at `~/.memwal/credentials.json`.
- Users can revoke delegate keys from the Walrus Memory dashboard.
- Users can remove local credentials with `memwal_logout`.
