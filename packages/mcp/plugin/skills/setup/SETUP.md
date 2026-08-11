# Walrus Memory Claude Code Plugin Setup

This plugin uses the current Walrus Memory custom-header auth path through the local `@mysten-incubation/memwal-mcp` package.

It does not use the hosted Claude custom-connector OAuth flow.

## Install

After the plugin is installed and enabled, restart Claude Code so the bundled MCP server starts.

## Authenticate

Ask Claude Code:

```text
/memwal:setup
```

Or ask:

```text
Connect Walrus Memory.
```

Claude should use the bundled `memwal_login` tool. The browser flow creates or finds your Walrus Memory account, registers a delegate key, and stores local credentials at:

```text
~/.memwal/credentials.json
```

## Verify

Ask Claude Code:

```text
Check Walrus Memory health, remember that this plugin setup works, then recall it.
```

