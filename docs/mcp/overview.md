---
title: MCP
description: >-
  Portable, verifiable agent memory for any MCP client, as a plain MCP server or as a plugin with automatic memory.
  Works with Claude Code, Codex, Cursor, Antigravity, Claude Desktop, and OpenCode.
keywords:
  - MCP
  - Walrus Memory
  - MemWal
  - plugin
  - automatic memory
  - agent memory
goal:
  description: Choose between the plugin installation path (with automatic before/after hooks) and the MCP-only path, then navigate to the correct client-specific setup guide for your AI tool.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 300
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - What is the MemWal MCP server and how does it work?
  - What is the difference between the MemWal plugin and MCP-only installation?
  - Which MCP clients support the MemWal automatic memory plugin?
answer: >-
  The MemWal MCP server exposes portable Walrus Memory as Model Context Protocol tools so AI agents can save and recall memories on their own. It can be installed as a plugin (with lifecycle hooks for automatic memory) on Claude Code, Codex, Cursor, and Antigravity, or as an MCP-only server on any MCP-aware client. Available tools include auto_save_user_facts_to_memory, memwal_recall, memwal_analyze, memwal_restore, memwal_health, memwal_login, and memwal_logout.
---

The **MemWal MCP server** exposes your portable Walrus Memory as Model Context Protocol tools, so an AI agent can decide when to save and recall memories on its own. It works with any MCP-aware client, and on **Claude Code**, **Codex**, **Cursor**, and **Antigravity** it can be installed as a **plugin** that adds automatic memory through lifecycle hooks.

## MCP vs Plugin

There are two ways to use MemWal. The difference is whether you also get the **lifecycle hooks**:

| Component | **Plugin** | **MCP-only** |
|---|:-:|:-:|
| MemWal MCP: memory tools (`auto_save_user_facts_to_memory`, `memwal_recall`, …) | ✓ | ✓ |
| Lifecycle hooks: automatic recall/save reminders | ✓ | ✗ |

- **MCP-only** gives the agent the memory tools. Because the tool descriptions encourage proactive use, the agent already saves and recalls on its own; you just do not get the hooks. Available on **every** MCP client.
- **Plugin** bundles the MCP server **and** lifecycle hooks that reinforce the behavior (for example, preferring Walrus Memory over a client's built-in memory). Available on **Claude Code**, **Codex**, **Antigravity**, and **Cursor**.

<Note>
The proactive behavior comes from the tool layer, so it works on both installation paths. The plugin hooks add reinforcement on the clients that support them.
</Note>

## Available tools

| Tool | Description |
|------|-------------|
| `auto_save_user_facts_to_memory` | Proactively save a durable user or project fact (preference, decision, constraint, identity). |
| `memwal_remember` | Deprecated API 1.x compatibility alias for the single-fact save tool. |
| `memwal_remember_bulk` | Save several distinct facts in one call. |
| `memwal_recall` | Semantic search across stored memories for relevant context. |
| `memwal_analyze` | Extract and save multiple facts from a passage of text. |
| `memwal_restore` | Rebuild the search index from Walrus when recall is unexpectedly empty. |
| `memwal_health` | Fast connectivity check (no search or decryption). |
| `memwal_login` | Connect this client to your account through browser wallet sign-in. |
| `memwal_logout` | Remove the saved credentials from this machine. |

See [Reference](/mcp/reference) for full parameters, CLI flags, and transports.

## How it works

The npm package (`@mysten-incubation/memwal-mcp`) runs locally next to your MCP client and bridges every memory tool call to the Walrus Memory relayer, which handles embeddings, SEAL encryption, and Walrus storage.

```mermaid
flowchart TD
  A["MCP client starts memwal-mcp"] --> B{"~/.memwal/credentials.json exists?"}
  B -- "No" --> C["Auth-required mode: agent calls memwal_login"]
  C --> D["Browser opens wallet sign-in"]
  D --> E["Credentials saved to ~/.memwal/credentials.json"]
  E --> F["Bridged mode"]
  B -- "Yes" --> F
  F --> G["Memory tools forwarded to the relayer<br/>(embeddings · SEAL encryption · Walrus storage)"]
```

- **First run (no credentials):** the server still starts and exposes `memwal_login`, so the agent signs you in inline instead of failing with a vague startup error. The login tool returns a clickable URL (valid 5 minutes); after you approve in the browser, the next tool call picks up the credentials automatically.
- **Credential file:** login writes `~/.memwal/credentials.json` (mode `0600`) containing your delegate key and account metadata. The delegate private key is a sensitive, long-lived credential; treat it like an API key.
- **Local vs remote tools:** the package handles `memwal_login` / `memwal_logout` locally (they never reach the relayer) and forwards all memory tools (`auto_save_user_facts_to_memory`, `memwal_recall`, …) to the relayer over an authenticated session.
- **Logout** deletes only the local credential file. To fully revoke access, also remove the delegate key from the dashboard.

See [Reference](/mcp/reference) for the credential file contents, transports (stdio vs HTTP), and runtime safety details.

## Client-specific setup

<CardGroup cols={2}>
  <Card title="Claude Code" icon="robot" href="/mcp/claude-code">
    Plugin (automatic memory) or MCP-only
  </Card>
  <Card title="Codex" icon="terminal" href="/mcp/codex">
    Plugin (automatic memory) or MCP-only
  </Card>
  <Card title="Cursor" icon="arrow-pointer" href="/mcp/cursor">
    Plugin or MCP-only
  </Card>
  <Card title="Claude Desktop" icon="desktop" href="/mcp/claude-desktop">
    MCP-only
  </Card>
  <Card title="Antigravity" icon="rocket" href="/mcp/antigravity">
    Plugin or MCP-only
  </Card>
  <Card title="OpenCode" icon="code" href="/mcp/opencode">
    MCP-only
  </Card>
  <Card title="Reference" icon="book" href="/mcp/reference">
    Tools, CLI flags, transports, self-hosting
  </Card>
</CardGroup>

## Verify your setup

Ask the agent in any conversation:

> What MCP tools do you have available?

You should see the Walrus Memory tools. Then state a durable fact (for example, a preferred package manager) and confirm the agent saves it with `auto_save_user_facts_to_memory` and recalls it in a later session.

Clients that support MCP prompts also show **Use Walrus Memory Proactively** in their prompt menu (often opened with `/`). Invoke it once per conversation for the full proactive recall/save rubric.

## Quick recovery

If `memwal_recall` returns nothing although you saved before (a new machine, a fresh relayer, or after switching servers), run `memwal_restore <namespace>` to rebuild the search index from the durable Walrus blobs, then recall again.
