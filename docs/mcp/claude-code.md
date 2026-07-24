---
title: Claude Code
description: >-
  Add portable Walrus Memory to Claude Code as a full plugin with automatic memory, or as a plain MCP server.
  The plugin adds lifecycle hooks that make the agent prefer Walrus Memory over built-in memory.
keywords:
  - MCP
  - Claude Code
  - Walrus Memory
  - MemWal
  - plugin
  - automatic memory
goal:
  description: Install and configure MemWal on Claude Code as either a plugin or MCP-only server.
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
  - How do I add Walrus Memory to Claude Code?
  - How do I install the MemWal plugin on Claude Code?
  - What is the difference between the MemWal plugin and MCP-only on Claude Code?
answer: >-
  To add Walrus Memory to Claude Code, install the MemWal plugin via the marketplace (/plugin marketplace add MystenLabs/MemWal, then /plugin install memwal@memwal-plugins), or add it as MCP-only with claude mcp add. The plugin includes lifecycle hooks for session start, user prompt, and post-tool events that reinforce automatic memory behavior and make the agent prefer Walrus Memory over Claude Code's built-in memory.
---

Add MemWal to Claude Code so it recalls context and saves durable facts as you work. Install it as a **plugin** (recommended; adds automatic-memory hooks) or as **MCP-only** (just the tools).

## Prerequisites

- Node.js 20+
- A Walrus Memory account. The first memory tool call opens a browser sign-in (`memwal_login`).

## Installation

<Tabs>
  <Tab title="Plugin (recommended)">
    <Steps>
      <Step title="Add the marketplace">
        ```
        /plugin marketplace add MystenLabs/MemWal
        ```
      </Step>
      <Step title="Install the plugin">
        ```
        /plugin install memwal@memwal-plugins
        ```
      </Step>
      <Step title="Restart and sign in">
        Restart Claude Code. On first use the agent runs `memwal_login`, which opens a browser to connect your wallet.
      </Step>
    </Steps>
  </Tab>
  <Tab title="MCP-only">
    ```bash
    claude mcp add --scope user memwal -- npx -y @mysten-incubation/memwal-mcp
    ```
    Restart Claude Code, then ask the agent to run `memwal_login` on first use.

    Or connect to the relayer over HTTP directly (no local package):
    ```bash
    claude mcp add --transport http memwal https://relayer.memory.walrus.xyz/api/mcp
    ```
  </Tab>
</Tabs>

## What the plugin includes

| Component | Plugin | MCP-only |
|---|:-:|:-:|
| MemWal MCP (memory tools) | ✓ | ✓ |
| Lifecycle hooks (automatic recall/save) | ✓ | ✗ |

MCP-only still saves and recalls on its own because the tools are proactive. The plugin adds hooks that reinforce the behavior and make the agent **prefer Walrus Memory over Claude Code's built-in memory**.

## Available tools

| Tool | Description |
|------|-------------|
| `memwal_remember` | Save a durable fact (preference, decision, constraint, identity). |
| `memwal_remember_bulk` | Save several distinct facts in one call. |
| `memwal_recall` | Semantic search across stored memories for relevant context. |
| `memwal_analyze` | Extract and save multiple facts from a passage of text. |
| `memwal_restore` | Rebuild the search index from Walrus (recovery). |
| `memwal_health` | Fast connectivity check. |
| `memwal_login` / `memwal_logout` | Connect or disconnect this client. |

See [Reference](/mcp/reference) for full parameters.

## Lifecycle hooks (plugin only)

| Hook | Event | What it does |
|------|-------|--------------|
| Session start | `SessionStart` | Announces that memory is active and reminds the agent to use the `memwal_*` tools (preferring them over any built-in memory). |
| User prompt | `UserPromptSubmit` | Detects when your message references past work or states a durable fact, and reminds the agent to recall or save. |
| Post-tool | `PostToolUse` (Bash) | When a command's output looks like an error, reminds the agent to recall prior fixes and save the resolution. |

## Example workflow

**Session 1**

```
You:   I prefer pnpm and always use TypeScript strict mode.
Agent: (calls memwal_remember on its own to store both preferences)
```

**Session 2: a brand-new chat**

```
You:   set up a new package in this repo
Agent: (calls memwal_recall, finds your preferences)
       Scaffolding with pnpm and "strict": true, matching how you like to work.
```

## Verify

```
/mcp          → "memwal" should be Connected
```

Expand its tools and confirm the list includes `memwal_remember_bulk` and `memwal_health`. Then state a durable fact and check that the agent saves it with `memwal_remember`.

## Troubleshooting

- **Tools missing**: restart Claude Code (MCP servers load at startup).
- **Not signed in**: ask the agent to run `memwal_login`, approve in the browser, then retry.
- **Hooks not firing**: use the **Plugin** install, not MCP-only; the hooks ship only with the plugin.
- **`memwal_recall` returns nothing although you saved before**: run `memwal_restore <namespace>` to rebuild the index from Walrus.
