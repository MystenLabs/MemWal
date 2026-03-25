---
title: "Quick Start"
description: "Install the MemWal memory plugin for OpenClaw and verify it works."
---

Get the plugin running and test the memory loop in a few minutes.

## Prerequisites

- [OpenClaw](https://openclaw.ai) `>=2026.3.11` installed and running
- [bun](https://bun.sh) as the package manager
- A MemWal account with **Ed25519 key pair**, **MemWalAccount ID**, and a **server URL**

<Note>
**MemWal** is a self-hostable memory infrastructure kit. You can run your own server for full control, or use the default staging server for testing. See [What is MemWal?](/getting-started/what-is-memwal) for details.
</Note>

The plugin needs three values from your MemWal setup:

| Value | What it is |
|-------|-----------|
| **Private Key** | Ed25519 key (64-char hex) — your identity and encryption key |
| **Account ID** | MemWalAccount object ID on Sui (`0x...`) — your on-chain identity |
| **Server URL** | MemWal server endpoint — handles search, fact extraction, and storage |

<Warning>
The default staging server (`https://staging-api-dev.up.railway.app`) is for **testing only**. Data may be wiped and availability is not guaranteed. Self-host for production use.
</Warning>

## Installation

<Steps>
  <Step>
    ### Install dependencies

    ```bash
    cd packages/openclaw-memory-memwal
    bun install
    ```
  </Step>

  <Step>
    ### Link into OpenClaw

    OpenClaw discovers plugins from `~/.openclaw/extensions/`. Create a symlink:

    ```bash
    mkdir -p ~/.openclaw/extensions
    ln -s "$(pwd)" ~/.openclaw/extensions/memory-memwal
    ```
  </Step>

  <Step>
    ### Set your private key

    Store your Ed25519 private key as an environment variable so it's never hardcoded in config files:

    ```bash
    # Add to your shell profile (.zshrc, .bashrc, etc.)
    export MEMWAL_PRIVATE_KEY="your-64-char-hex-key"
    ```
  </Step>

  <Step>
    ### Configure OpenClaw

    Add the plugin config to `~/.openclaw/openclaw.json`:

    ```jsonc
    {
      "plugins": {
        "slots": { "memory": "memory-memwal" },
        "entries": {
          "memory-memwal": {
            "enabled": true,
            "config": {
              "privateKey": "${MEMWAL_PRIVATE_KEY}",                  // References the env var
              "accountId": "0x3247e3da...",                            // Your MemWalAccount ID on Sui
              "serverUrl": "https://staging-api-dev.up.railway.app"   // Your server URL
            }
          }
        }
      }
    }
    ```

    <Accordion title="Optional settings">
      You can add these to the `config` block to tune behavior. The defaults work well for most setups.

      | Option | Default | Description |
      |--------|---------|-------------|
      | `autoRecall` | `true` | Inject relevant memories before each turn |
      | `autoCapture` | `true` | Extract and store facts after each turn |
      | `maxRecallResults` | `5` | Max memories to inject per turn |
      | `minRelevance` | `0.3` | Relevance threshold (0-1) for memory injection |
      | `captureMaxMessages` | `10` | How many recent messages to analyze for facts |
      | `defaultNamespace` | `"default"` | Memory scope for the main agent |
    </Accordion>
  </Step>

  <Step>
    ### Start OpenClaw

    ```bash
    openclaw gateway stop && openclaw gateway
    ```

    You should see in the logs:

    ```
    memory-memwal: registered (server: https://..., key: e21d...ed9b, namespace: default)
    memory-memwal: connected (status: ok, version: ...)
    ```

    <Tip>
    If you see `health check failed`, check that your server URL is reachable and your `MEMWAL_PRIVATE_KEY` env var is set.
    </Tip>
  </Step>
</Steps>

## Verify

### Check connectivity

Run the stats command to confirm the plugin is connected:

```bash
openclaw memwal stats
```

This shows the server status, your key (masked), account ID, active namespace, and whether auto-recall/capture are enabled.

### Test the memory loop

The core value of the plugin is the automatic recall/capture cycle. Test it end-to-end:

**1. Store a fact** — start a conversation and share something memorable:

```
You: I prefer TypeScript over JavaScript for backend work
Bot: (responds normally)
```

Check logs — you should see:
```
memory-memwal: auto-captured 1 facts (agent: main, namespace: default)
```

**2. Recall it** — in a **new conversation**, ask about it:

```
You: What programming languages do I like?
```

Check logs — you should see:
```
memory-memwal: auto-recall injected 1 memories (agent: main, namespace: default)
```

**3. Search from terminal** — confirm the memory exists via CLI:

```bash
openclaw memwal search "programming"
```

If all three steps work, the plugin is fully operational.

### Enable LLM tools (optional)

By default, the plugin works entirely through hooks — the LLM doesn't know about memory tools. To give the LLM explicit control, add tools to your agent profile:

```json
{
  "tools": {
    "allow": ["memory_search", "memory_store"]
  }
}
```

Then the LLM can call `memory_search` and `memory_store` on its own when it decides to. This is a power-user feature — hooks handle the common case automatically.

## Next steps

- [How It Works](/openclaw/how-it-works) — understand the architecture, message flow, and hook mechanics
- [Features](/openclaw/features) — detailed breakdown of every capability including CLI, tools, and multi-agent isolation
