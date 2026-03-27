---
title: "NemoClaw/OpenClaw Plugin"
description: "Give your OpenClaw AI agents persistent, encrypted long-term memory powered by MemWal."
---

The MemWal memory plugin adds a **cloud-based, encrypted memory layer** to OpenClaw agents. It works alongside OpenClaw's existing file-based memory — automatically recalling relevant context and capturing new facts in the background, with no user action needed.

## Features

<CardGroup cols={2}>
  <Card title="Automatic Recall" icon="magnifying-glass">
    Relevant memories are injected into the LLM's context before each conversation turn
  </Card>
  <Card title="Automatic Capture" icon="floppy-disk">
    Facts are extracted from conversations and stored as encrypted memories after each turn
  </Card>
  <Card title="Encrypted & User-Owned" icon="lock">
    SEAL-encrypted, stored on Walrus, tied to your delegate key — you own your data
  </Card>
  <Card title="Cross-App Memory" icon="arrows-rotate">
    Memories stored from any MemWal-connected app are accessible to your OpenClaw agent
  </Card>
  <Card title="Multi-Agent Isolation" icon="users">
    Each agent gets its own memory space via namespaces — no cross-contamination
  </Card>
  <Card title="Prompt Injection Protection" icon="shield">
    Detection and HTML escaping on both read and write paths
  </Card>
  <Card title="Agent Tools" icon="wrench">
    Optional `memory_search` and `memory_store` tools for explicit LLM control
  </Card>
  <Card title="CLI Commands" icon="terminal">
    `openclaw memwal search` and `openclaw memwal stats` for debugging and inspection
  </Card>
</CardGroup>

## When to use this

- You want your OpenClaw agents to **remember across conversations** — preferences, decisions, context
- You need **encrypted, user-owned memory** instead of plaintext files or platform-managed storage
- You want **cross-app continuity** — memories from other MemWal-connected apps (chatbot, noter, researcher) surface in OpenClaw
- You're running **multiple agents** and need each to have its own isolated memory space

## Get started

<CardGroup cols={2}>
  <Card title="Quick Start" icon="rocket" href="/openclaw/quick-start">
    Install, configure, and verify the plugin in minutes
  </Card>
  <Card title="How It Works" icon="gear" href="/openclaw/how-it-works">
    Architecture, message flow, hooks vs tools
  </Card>
  <Card title="Reference" icon="book" href="/openclaw/reference">
    Hooks, tools, CLI, configuration, and troubleshooting
  </Card>
  <Card title="Source Code" icon="github" href="https://github.com/MystenLabs/MemWal/tree/main/packages/openclaw-memory-memwal">
    Browse the source on GitHub
  </Card>
</CardGroup>
