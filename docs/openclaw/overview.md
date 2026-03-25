---
title: "OpenClaw Plugin"
description: "Give your OpenClaw AI agents persistent, encrypted long-term memory powered by MemWal."
---

The MemWal memory plugin replaces OpenClaw's default file-based memory with a **cloud-based, encrypted memory backend**. After setup, it runs silently — your agent remembers things from past conversations and learns new facts automatically.

<CardGroup cols={2}>
  <Card title="Automatic Memory" icon="rotate">
    Memories are recalled before each turn and facts are captured after — no user action needed
  </Card>
  <Card title="Encrypted & User-Owned" icon="lock">
    SEAL-encrypted, stored on Walrus, tied to your Ed25519 key — you own your data
  </Card>
  <Card title="Multi-Agent Isolation" icon="users">
    Each agent gets its own memory space via namespaces — no cross-contamination
  </Card>
  <Card title="Injection Protected" icon="shield">
    Prompt injection detection and HTML escaping on both read and write paths
  </Card>
</CardGroup>

## What it does

The plugin hooks into OpenClaw's conversation lifecycle at two points:

1. **Before each LLM turn** — searches MemWal for memories relevant to the user's message and injects them into the prompt as context. The LLM sees these as background knowledge without knowing they were injected.

2. **After each LLM turn** — extracts the conversation, filters out trivial content, and sends it to the MemWal server. A server-side LLM extracts individual facts and stores them as encrypted blobs on Walrus.

The plugin also registers optional LLM-callable tools (`memory_search`, `memory_store`) for explicit memory operations, and CLI commands (`openclaw memwal search`, `openclaw memwal stats`) for debugging and inspection.

## When to use this

- You want your OpenClaw agents to **remember across conversations** — preferences, decisions, context
- You need **encrypted, user-owned memory** instead of plaintext files or platform-managed storage
- You're running **multiple agents** and need each to have its own isolated memory space
## Get started

<CardGroup cols={2}>
  <Card title="Quick Start" icon="rocket" href="/openclaw/quick-start">
    Install, configure, and verify the plugin in minutes
  </Card>
  <Card title="How It Works" icon="gear" href="/openclaw/how-it-works">
    Architecture, message flow, hooks vs tools
  </Card>
  <Card title="Features" icon="list" href="/openclaw/features">
    Detailed breakdown of every capability
  </Card>
  <Card title="Source Code" icon="github" href="https://github.com/MystenLabs/MemWal/tree/main/packages/openclaw-memory-memwal">
    Browse the source on GitHub
  </Card>
</CardGroup>
