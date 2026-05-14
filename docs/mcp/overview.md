---
title: "MCP"
---

MemWal exposes a Model Context Protocol (MCP) server so MCP-aware clients can read from and write to a user's encrypted Walrus-backed memory.

Use MCP when you want tools like Cursor, Claude Desktop, Claude Code, or Antigravity to call MemWal directly from an agent workflow.

## Tools

The MCP server exposes six tools — four memory tools that round-trip to the relayer, and two session tools served locally by the stdio package.

**Memory tools** (forwarded to the relayer):

| Tool | Purpose |
| --- | --- |
| `memwal_remember` | Save a memory to MemWal |
| `memwal_recall` | Search saved memories by query |
| `memwal_analyze` | Extract and save durable facts from longer text |
| `memwal_restore` | Re-index memories from onchain Walrus blob records |

**Session tools** (handled locally by `@mysten-incubation/memwal-mcp`):

| Tool | Purpose |
| --- | --- |
| `memwal_login` | Open the browser, approve the wallet, and write credentials to `~/.memwal/credentials.json`. Use for first-time sign-in or to switch accounts. |
| `memwal_logout` | Remove the saved credentials from this machine. The on-chain delegate key is not revoked — visit the dashboard to remove it from the account. |

The two session tools mean a user can sign in from inside their MCP client (Cursor, Claude Desktop, Claude Code, Antigravity, …) without leaving the chat to run a separate CLI command.

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

The HTTP transport authenticates every request with a bearer token (the delegate private key) and account ID. To get those values, run the stdio package once to generate them:

```bash
npx -y @mysten-incubation/memwal-mcp login
```

This opens the dashboard, registers a delegate key, and writes credentials to `~/.memwal/credentials.json`. Copy `delegatePrivateKey` into the bearer token placeholder and `accountId` into `x-memwal-account-id`:

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

Use this when your MCP client supports command-based MCP servers. Add the entry to your client config:

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

**First run.** When `~/.memwal/credentials.json` is missing, the package starts in a sign-in-required mode and advertises a `memwal_login` tool to the client. Ask your agent to call `memwal_login` — it returns a one-time URL. Open the URL, approve the connection in your Sui wallet, and the next `memwal_*` call works without restarting the client.

The login URL stays valid for **5 minutes**. If it expires, ask the agent to call `memwal_login` again to get a fresh one.

**Manual fallback.** You can also pre-authorize from the terminal:

```bash
npx -y @mysten-incubation/memwal-mcp login
```

**Switching accounts or signing out.** Ask the agent to call `memwal_logout` (clears local credentials) followed by `memwal_login`. The CLI equivalent is:

```bash
npx -y @mysten-incubation/memwal-mcp --logout
```

After login, MCP clients can use the saved credentials without prompting again.

## CLI Flags and Environment Variables

The stdio package reads flags from `args` in the client config. Environment variables work too — flags win when both are set.

| CLI flag | Environment variable | Description |
| --- | --- | --- |
| `--relayer <url>` | `MEMWAL_SERVER_URL` | Override the relayer base URL. |
| `--web-url <url>` | `MEMWAL_WEB_URL` | Override the dashboard URL used during login. |
| `--label <text>` | `MEMWAL_CLIENT_LABEL` | Friendly delegate-key label shown in the MemWal dashboard. |
| `--login` | — | Force a re-login even when credentials already exist. |
| `--logout` | — | Wipe `~/.memwal/credentials.json` and exit. |
| `--help`, `-h` | — | Print usage and exit. |

Set `MEMWAL_MCP_DEBUG=1` to enable verbose stderr logging.

## Environment Presets

The stdio package accepts environment shortcuts that set both the relayer and the dashboard URL in one flag:

| Flag | Relayer | Dashboard |
| --- | --- | --- |
| `--prod` | `https://relayer.memwal.ai` | `https://memwal.ai` |
| `--dev` | `https://relayer.dev.memwal.ai` | `https://dev.memwal.ai` |
| `--staging` | `https://relayer.staging.memwal.ai` | `https://staging.memwal.ai` |
| `--local` | `http://127.0.0.1:8000` | `http://localhost:5173` |

Explicit `--relayer` and `--web-url` override the preset. You can also pass explicit URLs without a preset:

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

The MCP session limits that operators most often need to tune:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIDECAR_URL` | `http://localhost:9000` | Loopback endpoint the Rust relayer uses to reach the sidecar. |
| `MCP_MAX_TOTAL_SESSIONS` | `1000` | Cap on concurrent MCP sessions across SSE and Streamable HTTP. |
| `MCP_MAX_SESSIONS_PER_IP` | `16` | Cap on concurrent sessions from one source IP. |
| `MCP_MAX_NEW_SESSIONS_PER_IP_PER_MIN` | `30` | Rate cap on new sessions per source IP per minute. |

See [Environment Variables](/reference/environment-variables) for the full list, including SEAL and Walrus settings.
