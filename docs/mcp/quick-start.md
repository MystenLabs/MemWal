---
title: "Quick Start"
description: "Install the MemWal MCP package, sign in with your wallet, and wire it into an MCP client in under five minutes."
---

This page gets you from zero to a working MemWal MCP server inside Cursor, Claude Desktop, Claude Code, or Codex.

## Prerequisites

- **Node.js 20** or newer (`node -v` to check)
- A **Sui wallet** with the MemWal app authorized — Sui Wallet, Suiet, Phantom, or any [Sui-compatible wallet](https://memwal.ai)
- An **MCP-aware client**: Cursor, Claude Desktop, Claude Code, Codex, Antigravity, or another MCP host

No npm install needed — `npx` fetches the `@mysten-incubation/memwal-mcp` package on demand.

## Installation

<Steps>
  <Step>
    ### Sign in with your Sui wallet

    Run the login flow once from your terminal. Your browser opens to `https://memwal.ai/connect/mcp` — approve the connection in your Sui wallet.

    ```bash
    npx -y @mysten-incubation/memwal-mcp login --prod
    ```

    The package writes credentials to `~/.memwal/credentials.json`. For other environments use `--staging`, `--dev`, or `--local`.

    <Warning>
    Run this in a real terminal (with a TTY). The login command opens a browser and waits for your wallet approval. If you wrap it in a non-interactive shell, the browser won't pop and the flow exits silently.
    </Warning>
  </Step>

  <Step>
    ### Add MemWal to your MCP client

    Pick the snippet for your client. Drop it into the client's MCP config file.

    <Tabs>
      <Tab title="Cursor">
      ```json
      // ~/.cursor/mcp.json
      {
        "mcpServers": {
          "memwal": {
            "command": "npx",
            "args": ["-y", "@mysten-incubation/memwal-mcp"]
          }
        }
      }
      ```
      </Tab>
      <Tab title="Claude Desktop">
      ```json
      // macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
      // Windows: %APPDATA%\Claude\claude_desktop_config.json
      {
        "mcpServers": {
          "memwal": {
            "command": "npx",
            "args": ["-y", "@mysten-incubation/memwal-mcp"]
          }
        }
      }
      ```
      </Tab>
      <Tab title="Claude Code">
      ```bash
      claude mcp add --scope user memwal -- npx -y @mysten-incubation/memwal-mcp
      ```
      </Tab>
      <Tab title="Codex">
      ```toml
      # ~/.codex/config.toml
      [mcp_servers.memwal]
      command = "npx"
      args = ["-y", "@mysten-incubation/memwal-mcp"]
      ```
      </Tab>
    </Tabs>
  </Step>

  <Step>
    ### Restart the client

    MCP servers load at client startup. Quit and reopen your MCP client (`Cmd+Q` on macOS — closing the window is not enough). On first start, `npx` fetches the package — expect a 5–10 second delay the first time.
  </Step>
</Steps>

## Verify

### Check connectivity

Ask the agent in any conversation:

> What MCP tools do you have available?

You should see six tools:

- `memwal_remember`
- `memwal_recall`
- `memwal_analyze`
- `memwal_restore`
- `memwal_login`
- `memwal_logout`

If you only see five — or only `memwal_login` — credentials are missing. Run the login command from step 1 again or ask the agent to call `memwal_login`.

### Save and recall a memory

```text
Use memwal_remember to save: "My favorite programming language is Rust and I drink black coffee in the mornings."
```

Wait a few seconds for the async upload to land on Walrus, then:

```text
Use memwal_recall to search for: "what is my favorite language?"
```

The agent should retrieve the memory you just saved.

### Extract multiple facts from a passage

```text
Use memwal_analyze on this paragraph: "I live in Saigon, work as a software engineer at MystenLabs, exercise at 6am, and am allergic to shellfish."
```

The tool extracts each distinct fact and saves them as separate memories. Follow up with `memwal_recall` to verify any one of them came back.

## Switching environments

Need to hop between prod, staging, dev, or a local relayer without re-editing your client config?

```bash
npx -y @mysten-incubation/memwal-mcp --logout
npx -y @mysten-incubation/memwal-mcp login --staging
```

Your client config doesn't change — the package reads the saved environment from `~/.memwal/credentials.json` on each run. See [Environment presets](/mcp/reference#environment-presets) for all four shortcuts.

## Signing out

Ask the agent to call `memwal_logout`, or run from your terminal:

```bash
npx -y @mysten-incubation/memwal-mcp --logout
```

This deletes the local credentials file. The on-chain delegate key is **not** revoked — visit the [MemWal dashboard](https://memwal.ai) to remove it from your account if needed.

## Next steps

<CardGroup cols={2}>
  <Card title="Reference" icon="book" href="/mcp/reference">
    All six tools with parameters, CLI flags, and transport routes
  </Card>
  <Card title="Streamable HTTP transport" icon="globe" href="/mcp/reference#streamable-http">
    Skip `npx` — point your client at the relayer URL directly
  </Card>
  <Card title="Self-Hosting" icon="server" href="/mcp/reference#self-hosting">
    Run your own relayer and route MCP traffic through it
  </Card>
  <Card title="Environment Variables" icon="gear" href="/reference/environment-variables">
    Full list of relayer + sidecar settings (SEAL, Walrus, sessions)
  </Card>
</CardGroup>
