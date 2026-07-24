---
title: Codex
description: >-
  Add portable Walrus Memory to OpenAI Codex as a full plugin with automatic memory, or as a plain MCP server.
  The plugin adds lifecycle hooks that reinforce automatic recall and save behavior.
keywords:
  - MCP
  - Codex
  - Walrus Memory
  - MemWal
  - plugin
  - automatic memory
goal:
  description: Install and configure MemWal on Codex as either a plugin or MCP-only server.
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
  - How do I add Walrus Memory to Codex?
  - How do I install the MemWal plugin on Codex?
  - How do I configure MemWal hooks for Codex?
answer: >-
  To add Walrus Memory to Codex, install the MemWal plugin by running the install script (node packages/mcp/plugin/scripts/install_codex_hooks.mjs), which merges hooks into ~/.codex/hooks.json and registers the MCP server in ~/.codex/config.toml. Alternatively, add it as MCP-only by configuring [mcp_servers.memwal] in config.toml. The plugin requires enabling the codex_hooks feature flag. Do not combine both installation methods to avoid duplicate server errors.
---

Add MemWal to Codex so it recalls context and saves durable facts as you work. Install it as a **plugin** (recommended; adds automatic-memory hooks) or as **MCP-only** (just the tools).

## Prerequisites

- Node.js 20+
- A Walrus Memory account. The first memory tool call opens a browser sign-in (`memwal_login`).

## Installation

<Tabs>
  <Tab title="Plugin (recommended)">
    <Steps>
      <Step title="Install the hooks + MCP server">
        From a cloned repo:
        ```bash
        node packages/mcp/plugin/scripts/install_codex_hooks.mjs
        ```
        This merges the MemWal hooks into `~/.codex/hooks.json` and registers `[mcp_servers.memwal]` in `~/.codex/config.toml`. Re-running is safe (idempotent); add `--uninstall` to remove the hooks.
      </Step>
      <Step title="Enable the hooks feature flag">
        Add to `~/.codex/config.toml`:
        ```toml
        [features]
        codex_hooks = true
        ```
      </Step>
      <Step title="Restart and sign in">
        Restart Codex. On first use the agent runs `memwal_login` to connect your wallet.
      </Step>
    </Steps>
  </Tab>
  <Tab title="MCP-only">
    Add to `~/.codex/config.toml`:
    ```toml
    [mcp_servers.memwal]
    command = "npx"
    args = ["-y", "@mysten-incubation/memwal-mcp"]
    ```
    Restart Codex, then ask the agent to run `memwal_login` on first use.
  </Tab>
</Tabs>

<Warning>
Do not combine both options: the plugin installer already registers `[mcp_servers.memwal]`. Adding it again creates a duplicate server.
</Warning>

## What the plugin includes

| Component | Plugin | MCP-only |
|---|:-:|:-:|
| MemWal MCP (memory tools) | ✓ | ✓ |
| Lifecycle hooks (automatic recall/save) | ✓ | ✗ |

MCP-only still saves and recalls on its own because the tools are proactive. The plugin adds hooks that reinforce the behavior and make the agent prefer Walrus Memory over any built-in memory.

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
| Session start | `SessionStart` | Announces that memory is active and reminds the agent to use the `memwal_*` tools. |
| User prompt | `UserPromptSubmit` | Detects when your message references past work or states a durable fact, and reminds the agent to recall or save. |
| Post-tool | `PostToolUse` (Bash) | When a command errors, reminds the agent to recall prior fixes and save the resolution. |

## Verify

Ask the agent what MCP tools it has available. You should see the `memwal_*` tools, including `memwal_remember_bulk` and `memwal_health`. Then state a durable fact and confirm the agent saves it with `memwal_remember`.

## Troubleshooting

- **Tools missing**: restart Codex.
- **Duplicate `memwal` errors**: you have both the plugin and a manual `[mcp_servers.memwal]`; remove the manual entry.
- **Hooks not firing**: confirm `codex_hooks = true` under `[features]` in `~/.codex/config.toml`, and that you restarted Codex.
- **`memwal_recall` returns nothing although you saved before**: run `memwal_restore <namespace>` to rebuild the index from Walrus.
