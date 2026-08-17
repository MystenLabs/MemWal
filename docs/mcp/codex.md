---
title: Codex
description: Add portable Walrus Memory to OpenAI Codex as a plain MCP server (recommended), or as a full plugin with automatic-memory hooks.
keywords: [MCP, Codex, Walrus Memory, MemWal, plugin, automatic memory]
---

Add MemWal to Codex so it recalls context and saves durable facts as you work. Install it as **MCP-only** (recommended; just the tools, one config block, no repo to clone) or as a full **plugin** (adds automatic-memory hooks, but currently requires cloning the repo).

## Prerequisites

- Node.js 20+
- A Walrus Memory account. The first memory tool call opens a browser sign-in (`memwal_login`).

## Installation

<Tabs>
  <Tab title="MCP-only (recommended)">
    Add to `~/.codex/config.toml`:
    ```toml
    [mcp_servers.memwal]
    command = "npx"
    args = ["-y", "@mysten-incubation/memwal-mcp"]
    ```
    Restart Codex, then ask the agent to run `memwal_login` on first use. The
    memory tools are proactive, so this is enough for automatic save and recall.
  </Tab>
  <Tab title="Plugin (automatic-memory hooks)">
    The plugin adds lifecycle hooks on top of the MCP server. There is no Codex
    marketplace install yet, so it currently requires a cloned repo. If you just
    want memory in Codex, use the MCP-only tab instead.

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
| `auto_save_user_facts_to_memory` | Proactively save a durable fact (preference, decision, constraint, identity). |
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
| Session start | `SessionStart` | Announces that memory is active and reminds the agent to use the Walrus Memory tools. |
| User prompt | `UserPromptSubmit` | Detects when your message references past work or states a durable fact, and reminds the agent to recall or save. |
| Post-tool | `PostToolUse` (Bash) | When a command errors, reminds the agent to recall prior fixes and save the resolution. |

## Verify

Ask the agent what MCP tools it has available. You should see the Walrus Memory tools, including `auto_save_user_facts_to_memory`, `memwal_remember_bulk`, and `memwal_health`. Then state a durable fact and confirm the agent saves it with `auto_save_user_facts_to_memory`. If your version exposes MCP prompts, invoke **Use Walrus Memory Proactively** from the `/` menu once per chat.

## Troubleshooting

- **Tools missing**: restart Codex.
- **Duplicate `memwal` errors**: you have both the plugin and a manual `[mcp_servers.memwal]`; remove the manual entry.
- **Hooks not firing**: confirm `codex_hooks = true` under `[features]` in `~/.codex/config.toml`, and that you restarted Codex.
- **`memwal_recall` returns nothing although you saved before**: run `memwal_restore <namespace>` to rebuild the index from Walrus.
