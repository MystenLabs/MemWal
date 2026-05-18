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

## Get started

<CardGroup cols={2}>
  <Card title="Quick Start" icon="rocket" href="/mcp/quick-start">
    Install the package, sign in with your wallet, wire your client, and run your first tool call
  </Card>
  <Card title="Reference" icon="book" href="/mcp/reference">
    All six tools, CLI flags, environment presets, transport routes, and self-hosting notes
  </Card>
  <Card title="Source Code" icon="github" href="https://github.com/MystenLabs/MemWal/tree/main/packages/mcp">
    Browse the `@mysten-incubation/memwal-mcp` package on GitHub
  </Card>
  <Card title="MemWal Dashboard" icon="window" href="https://memwal.ai">
    Manage delegate keys, view storage, and revoke connected clients
  </Card>
</CardGroup>
