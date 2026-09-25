# Walrus Memory Claude Code plugin

Walrus Memory gives Claude Code durable, user-owned memory. This plugin packages the published [`@mysten-incubation/memwal-mcp`](https://www.npmjs.com/package/@mysten-incubation/memwal-mcp) server with setup guidance, slash commands, and lifecycle hooks.

This tree is generated from [`MystenLabs/MemWal/packages/mcp/plugin`](https://github.com/MystenLabs/MemWal/tree/dev/packages/mcp/plugin) by `scripts/build-claude-plugin.mjs`. Do not hand-edit a published copy: change it in MemWal and regenerate, or the fix will be lost at the next build.

Publisher: [Mysten Labs](https://mystenlabs.com). Dashboard: [memory.walrus.xyz](https://memory.walrus.xyz). Docs: [Claude Code setup](https://docs.wal.app/walrus-memory/mcp/claude-code.html).

## Install

After the plugin is listed in the Claude plugin directory, install **Walrus Memory** from `/plugin` → Discover.

To load this repo locally for review:

```bash
claude plugin validate . --strict
claude --plugin-dir .
```

Then restart Claude Code or run `/reload-plugins`, and confirm `/plugin` and `/mcp` show `memwal`.

The plugin starts the MCP server with `node ${CLAUDE_PLUGIN_ROOT}/scripts/launch_mcp.mjs`. That launcher installs `@mysten-incubation/memwal-mcp@__MEMWAL_MCP_VERSION__` once under `~/.memwal/runtime/` and runs it from an absolute path it owns, so the package name is never resolved against the project directory.

MCP-only (tools, no plugin hooks, no trusted launcher):

```bash
claude mcp add --scope user memwal -- npx -y @mysten-incubation/memwal-mcp@__MEMWAL_MCP_VERSION__ --label "Claude Code"
```

## Setup

```text
/memwal:setup
```

`memwal_login` opens the browser wallet flow and stores credentials at `~/.memwal/credentials.json` (mode `0600`). Do not paste that file or its private key into chat.

## Example prompts

1. `Connect Walrus Memory and confirm memwal_health is ok.`
2. `Remember that I use pnpm and TypeScript strict mode in this project.`
3. `What package manager and TypeScript settings do I prefer?`

## Commands

- `/memwal:setup`
- `/memwal:health`
- `/memwal:remember`
- `/memwal:recall`
- `/memwal:analyze`
- `/memwal:restore`
- `/memwal:logout`

## What is never saved

__MEMWAL_SECRET_POLICY__

__MEMWAL_AUTO_SAVE_RULE__

## Authentication

This plugin uses local stdio MCP and delegate-key login. It does not use the hosted Claude custom-connector OAuth flow.

The hosted connector is a separate remote MCP surface at `https://relayer.memory.walrus.xyz/api/mcp`. See [`docs/usage/hosted-connector.md`](docs/usage/hosted-connector.md).

## Privacy and support

Walrus Memory encrypts memories with SEAL and stores them on Walrus. The local MCP process keeps a delegate private key on disk after login so it can sign relayer calls.

- Privacy policy: https://docs.wal.app/docs/legal/privacy
- Terms: https://docs.wal.app/docs/legal/walrus_general_tos
- Product docs: https://docs.wal.app/walrus-memory/mcp/claude-code.html
- Support: open an issue on [MystenLabs/MemWal](https://github.com/MystenLabs/MemWal/issues), or use the [Walrus Memory dashboard](https://memory.walrus.xyz)

## License

Apache-2.0
