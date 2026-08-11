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

