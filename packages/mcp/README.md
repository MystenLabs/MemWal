# MemWal MCP

MemWal MCP is a stdio Model Context Protocol server for MemWal. It lets MCP clients such as Cursor, Claude Desktop, Antigravity, and Claude Code connect to the MemWal relayer without manually configuring remote headers or auth tokens.

On first use, the CLI opens a browser-based wallet login flow and stores local credentials at `~/.memwal/credentials.json`.

## Quick Start

Add MemWal MCP to your MCP client config:

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

Use CLI flags or environment variables to override the default MemWal endpoints.

| CLI flag | Environment variable | Description |
| --- | --- | --- |
| `--relayer <url>` | `MEMWAL_SERVER_URL` | Override the relayer base URL. |
| `--web-url <url>` | `MEMWAL_WEB_URL` | Override the web app URL used during login. |
| `--label <text>` | `MEMWAL_CLIENT_LABEL` | Friendly delegate-key label shown in MemWal. |

Enable verbose stderr logging with `MEMWAL_MCP_DEBUG=1`.

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
