---
title: "MCP"
---

MemWal exposes a Model Context Protocol (MCP) server so MCP-aware clients can read from and write to a user's encrypted Walrus-backed memory.

Use MCP when you want tools like Cursor, Claude Desktop, Claude Code, or Antigravity to call MemWal directly from an agent workflow.

## Tools

The MCP server exposes four tools:

| Tool | Purpose |
| --- | --- |
| `memwal_remember` | Save a memory to MemWal |
| `memwal_recall` | Search saved memories by query |
| `memwal_analyze` | Extract and save durable facts from longer text |
| `memwal_restore` | Re-index memories from onchain Walrus blob records |

## Transport Options

MemWal supports two MCP connection modes.

| Mode | Best for | Client config shape |
| --- | --- | --- |
| Streamable HTTP | Clients that support remote HTTP MCP servers | `url: "https://relayer.memwal.ai/api/mcp"` |
| stdio package | Clients that run local MCP commands | `npx -y @mysten-incubation/memwal-mcp` |

For the hosted production relayer, the Streamable HTTP endpoint is:

```text
https://relayer.memwal.ai/api/mcp
```

The stdio package opens a browser-based wallet login the first time it runs, then stores credentials in `~/.memwal/credentials.json`.

<Warning>
The MCP bearer token is the delegate private key created for the MCP client. Treat it like a long-lived API token. Do not commit MCP configs that contain a real `Authorization` header.
</Warning>

## Streamable HTTP Setup

Use this when your MCP client supports HTTP transport.

First run the local login flow once so MemWal can register a delegate key and write credentials to `~/.memwal/credentials.json`:

```bash
npx -y @mysten-incubation/memwal-mcp login
```

Then copy `delegatePrivateKey` into the bearer token placeholder and `accountId` into `x-memwal-account-id`:

```json
{
  "mcpServers": {
    "memwal": {
      "url": "https://relayer.memwal.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_DELEGATE_PRIVATE_KEY>",
        "x-memwal-account-id": "<YOUR_ACCOUNT_ID>"
      }
    }
  }
}
```

The relayer authenticates every request with the bearer key and account ID, then proxies the MCP protocol to the TypeScript sidecar.

For Claude Code, the equivalent command is:

```bash
claude mcp add --transport http memwal https://relayer.memwal.ai/api/mcp
```

If your client cannot attach headers from the command, add the headers in the generated MCP config file.

## stdio Package Setup

Use this when your MCP client supports command-based MCP servers.

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

To authorize the package manually, run:

```bash
npx -y @mysten-incubation/memwal-mcp login
```

The login flow opens the MemWal dashboard, asks you to connect your Sui wallet, and registers a delegate key on chain. After login, MCP clients can use the saved credentials without prompting again.

## Environments

The stdio package accepts environment shortcuts:

| Flag | Relayer |
| --- | --- |
| `--prod` | `https://relayer.memwal.ai` |
| `--dev` | `https://relayer.dev.memwal.ai` |
| `--staging` | `https://relayer.staging.memwal.ai` |
| `--local` | `http://127.0.0.1:8000` |

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

## Client Config

Use the snippets above for Cursor, Claude Desktop, Claude Code, Antigravity, or any other MCP client that accepts either command-based stdio servers or Streamable HTTP servers.

## Self-Hosting Notes

Self-hosted relayers expose the same public MCP routes:

| Route | Purpose |
| --- | --- |
| `GET /api/mcp/sse` | Legacy SSE session for the stdio bridge |
| `POST /api/mcp/messages` | JSON-RPC messages for the legacy SSE transport |
| `GET /api/mcp` | Streamable HTTP server-to-client stream |
| `POST /api/mcp` | Streamable HTTP JSON-RPC messages |
| `DELETE /api/mcp` | Close a Streamable HTTP session |

The Rust relayer starts the TypeScript sidecar automatically and forwards MCP traffic to the sidecar over loopback. The sidecar resolves MCP bearer credentials into normal MemWal SDK sessions, so tool calls still use the same relayer, SEAL, Walrus, and pgvector paths as SDK calls.

See [Environment Variables](/reference/environment-variables) for MCP-specific sidecar and session-capacity settings.
