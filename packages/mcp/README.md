# Walrus Memory MCP

Walrus Memory MCP is a stdio Model Context Protocol server for Walrus Memory. It lets MCP clients such as Cursor, Claude Desktop, Antigravity, and Claude Code connect to the Walrus Memory relayer without manually configuring remote headers or auth tokens.

On first use, the package advertises a `memwal_login` tool to the MCP client. The agent can call it inline — no separate CLI command needed. The tool opens a browser-based wallet login flow and stores local credentials at `~/.memwal/credentials.json`. A matching `memwal_logout` tool clears the saved credentials.

## Quick Start

Add Walrus Memory MCP to your MCP client config:

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

## Login

Run the login flow manually:

```sh
npx -y @mysten-incubation/memwal-mcp login
```

The command opens your browser, asks you to connect your Sui wallet, and saves credentials locally.

## Commands

```sh
memwal-mcp
memwal-mcp login
memwal-mcp --logout
memwal-mcp --help
```

## Options

Use CLI flags or environment variables to override the default Walrus Memory endpoints.

| CLI flag | Environment variable | Description |
| --- | --- | --- |
| `--relayer <url>` | `MEMWAL_SERVER_URL` | Override the relayer base URL. |
| `--web-url <url>` | `MEMWAL_WEB_URL` | Override the web app URL used during login. |
| `--label <text>` | `MEMWAL_CLIENT_LABEL` | Friendly delegate-key label shown in Walrus Memory. |
| `--namespace <name>` (alias `--ns`) | `MEMWAL_NAMESPACE` | Default memory namespace applied when the agent omits one. |

Enable verbose stderr logging with `MEMWAL_MCP_DEBUG=1`.

## Default Namespace

By default the MCP tool schemas expose an optional `namespace` argument and the
agent has to pass it on every `memwal_remember` / `memwal_recall` /
`memwal_analyze` call (and `memwal_restore` requires it). Set a default once in
your client config instead:

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": ["-y", "@mysten-incubation/memwal-mcp", "--namespace", "work"]
    }
  }
}
```

Or with an environment variable (e.g. Claude Desktop / Codex `env` blocks):

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": ["-y", "@mysten-incubation/memwal-mcp"],
      "env": { "MEMWAL_NAMESPACE": "work" }
    }
  }
}
```

Resolution and precedence:

- **Per-call wins**: an explicit, non-empty `namespace` in a tool call is
  always used as-is — the configured default never overrides it.
- **Configured default**: when the agent omits `namespace`, the package
  injects `--namespace` (CLI) or `MEMWAL_NAMESPACE` (env); CLI wins over env.
- **Unset**: if neither is configured, the call is forwarded without a
  `namespace` and the relayer applies its own `"default"` namespace.

`memwal_restore` still advertises `namespace` as **required** in its schema, so
agents normally pass one explicitly. If a default is configured and the agent
calls `memwal_restore` without a namespace, the configured default is filled
in the same way.

### Verifying namespace injection

No automated test runner ships with this package (consistent with the rest of
the monorepo). To verify manually:

1. Start the server pinned to a namespace and with debug logging:
   `MEMWAL_MCP_DEBUG=1 npx -y @mysten-incubation/memwal-mcp --namespace demo-ns`
2. From your MCP client, ask the agent to remember a fact **without**
   specifying a namespace, then recall it **without** a namespace — the recall
   should return that fact (both landed in `demo-ns`).
3. Ask the agent to recall with an explicit different namespace
   (e.g. `other`) — it should **not** return the fact, proving the per-call
   value overrode the default.

The injection itself is the pure, exported `applyDefaultNamespace(msg, ns)`
function in `src/bridge.ts` if you want to assert it directly.

## Environment Presets

```sh
memwal-mcp --prod
memwal-mcp --dev
memwal-mcp --staging
memwal-mcp --local
```

You can also pass explicit URLs:

```json
{
  "mcpServers": {
    "memwal": {
      "command": "npx",
      "args": [
        "-y",
        "@mysten-incubation/memwal-mcp",
        "--relayer",
        "https://relayer.dev.memwal.ai"
      ]
    }
  }
}
```

## Credential Storage

Credentials are stored locally in `~/.memwal/credentials.json`. To remove them:

```sh
npx -y @mysten-incubation/memwal-mcp --logout
```

## License

Apache-2.0
