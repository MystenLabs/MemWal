# Walrus Memory Claude Code Plugin

Walrus Memory gives Claude Code durable, user-owned memory through the bundled `@mysten-incubation/memwal-mcp` server.

This marketplace plugin includes:

- `.mcp.json` for the Walrus Memory MCP server.
- Delegate-key setup guidance through `/memwal:setup`.
- Slash commands for `/memwal:remember` and `/memwal:recall`.
- Lifecycle hooks that nudge Claude Code to recall prior context and save durable facts.

## Auth Model

This plugin uses the current Walrus Memory custom-header auth flow. On first use, the MCP package opens the browser login flow, creates or finds the user's Walrus Memory account, registers a delegate key, and stores local credentials in:

```text
~/.memwal/credentials.json
```

It is independent of the hosted Claude custom-connector OAuth work.

## Hosted Claude Custom Connector

This plugin repo is for the Claude Code marketplace package. It runs a local stdio MCP server and uses delegate-key custom-header auth.

The hosted Claude custom connector is a separate remote MCP surface that uses OAuth. Use this URL in Claude's native custom connector UI when testing the hosted connector:

```text
https://relayer.dev.memwal.ai/api/mcp
```

Discovery endpoints:

```text
https://relayer.dev.memwal.ai/.well-known/oauth-authorization-server
https://relayer.dev.memwal.ai/.well-known/oauth-protected-resource
```

Expected hosted connector flow:

1. Add `https://relayer.dev.memwal.ai/api/mcp` in Claude's connector UI.
2. Claude discovers the OAuth metadata.
3. The browser opens the Walrus Memory consent page.
4. The user connects a wallet and approves access.
5. Claude can call `tools/list` and the memory tools without manual delegate keys or custom headers.

## Verify Locally

```bash
claude plugin validate .
claude --plugin-dir .
```

Inside Claude Code:

```text
/memwal:setup
/memwal:remember I use Walrus Memory from Claude Code.
/memwal:recall Claude Code Walrus Memory setup
```
