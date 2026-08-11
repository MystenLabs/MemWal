# Hosted Claude Custom Connector

This repo is for the local plugin package. The hosted Claude custom connector is a separate remote MCP surface that uses OAuth.

Use this URL in Claude's native custom connector UI:

```text
https://relayer.dev.memwal.ai/api/mcp
```

Discovery endpoints:

```text
https://relayer.dev.memwal.ai/.well-known/oauth-authorization-server
https://relayer.dev.memwal.ai/.well-known/oauth-protected-resource
```

Expected flow:

1. Add `https://relayer.dev.memwal.ai/api/mcp` in Claude's connector UI.
2. Claude discovers OAuth metadata.
3. The browser opens the Walrus Memory consent page.
4. The user connects a wallet and approves access.
5. Claude can call `tools/list` and memory tools without manual delegate keys or custom headers.

This hosted connector flow is independent of the Claude Code marketplace plugin, which uses local stdio MCP and delegate-key custom-header auth.

