---
title: "MCP"
description: "Give MCP-aware AI clients access to your encrypted Walrus-backed MemWal memory."
---

MemWal exposes a **Model Context Protocol (MCP) server** so MCP-aware clients can read from and write to your encrypted memory. Use it when you want Cursor, Claude Desktop, Claude Code, Codex, Antigravity, or any other MCP client to call MemWal directly from an agent workflow — without writing custom integration code.

## Features

<CardGroup cols={2}>
  <Card title="Six Built-In Tools" icon="wrench">
    `memwal_remember`, `memwal_recall`, `memwal_analyze`, `memwal_restore`, `memwal_login`, `memwal_logout`
  </Card>
  <Card title="Inline Browser Login" icon="globe">
    Agents call `memwal_login` to open a browser sign-in — no separate CLI step, no client restart
  </Card>
  <Card title="Two Transports" icon="arrows-left-right">
    Streamable HTTP for remote MCP clients, or stdio package (`npx`) for local-command clients
  </Card>
  <Card title="Encrypted & User-Owned" icon="lock">
    SEAL-encrypted, stored on Walrus, tied to your delegate key — you own the data
  </Card>
  <Card title="Cross-Client Memory" icon="arrows-rotate">
    Memories saved from Cursor surface in Claude Desktop, Codex, and vice versa — one MemWal account, every client
  </Card>
  <Card title="Environment Presets" icon="server">
    `--prod` / `--staging` / `--dev` / `--local` flags switch networks without editing client configs
  </Card>
</CardGroup>

## When to use this

- You want an AI client to **call MemWal directly** — no custom SDK integration code in your app
- You need the agent to **remember across conversations and sessions**
- You're running **multiple MCP clients** and want all of them to share one memory store
- You need **encrypted, user-owned memory** instead of platform-managed storage

## Supported clients

The package is designed first for MCP hosts that run **local commands**:

- Cursor
- Claude Desktop
- Claude Code
- Codex
- Antigravity

If your MCP host supports **remote Streamable HTTP** servers with custom headers, you can also skip the local package and point directly at the relayer. See [Reference](/mcp/reference#streamable-http).

## Get started

<CardGroup cols={2}>
  <Card title="Quick Start" icon="rocket" href="/mcp/quick-start">
    Install the package, sign in with your wallet, wire your client, and run your first tool call
  </Card>
  <Card title="How It Works" icon="route" href="/mcp/how-it-works">
    Auth-required mode, inline browser login, local credential storage, and the stdio bridge
  </Card>
  <Card title="Reference" icon="book" href="/mcp/reference">
    All six tools, CLI flags, environment presets, transport routes, and self-hosting notes
  </Card>
  <Card title="Changelog" icon="clock-rotate-left" href="/mcp/changelog">
    Release history for the `@mysten-incubation/memwal-mcp` package
  </Card>
  <Card title="Source Code" icon="github" href="https://github.com/MystenLabs/MemWal/tree/main/packages/mcp">
    Browse the `@mysten-incubation/memwal-mcp` package on GitHub
  </Card>
  <Card title="MemWal Dashboard" icon="window" href="https://memwal.ai">
    Manage delegate keys, view storage, and revoke connected clients
  </Card>
</CardGroup>

## What happens on the client machine

The MCP package is not just a thin HTTP wrapper.

1. It checks for `~/.memwal/credentials.json`.
2. If the file is missing, it starts in an **auth-required mode** instead of crashing the MCP host.
3. In that mode the agent can still call `memwal_login` inline.
4. After wallet approval, the package writes credentials locally and future MemWal tool calls succeed without reconfiguring the client.
5. Once signed in, the package bridges local stdio MCP traffic to the relayer and keeps `memwal_login` and `memwal_logout` local-only.

See [How It Works](/mcp/how-it-works) for the full flow and security model.

## Why use the package instead of raw HTTP

- Most MCP hosts support local `command + args` servers before they support remote auth UX cleanly.
- The package can open the browser flow, save credentials, and recover from missing auth inline.
- It keeps bearer credentials out of the MCP client config in the common stdio path.

## What the MCP package adds

Compared with wiring a raw HTTP MCP endpoint by hand, the package adds a few important runtime behaviors:

- **First-run recovery**: when credentials are missing, the MCP host still gets a healthy server plus `memwal_login`
- **Local session tools**: `memwal_login` and `memwal_logout` are handled on the client machine instead of forwarded upstream
- **Automatic tool surfacing**: the package injects local session tools alongside the relayer-backed memory tools
- **Session resilience**: the stdio bridge reconnects to the relayer if the underlying SSE session is dropped
- **Safer defaults**: the common `npx` path avoids pasting long-lived bearer credentials into client config files
