---
title: "What is Walrus Memory?"
description: "Portable agent memory — take your agent's memory anywhere."
---

<Note>
Walrus Memory is currently in beta and actively evolving. While fully usable today, we continue to refine the developer experience and operational guidance. We welcome feedback from early builders as we continue to improve the product.
</Note>

Walrus Memory enables AI agents to operate reliably across apps and sessions, without losing context. Portable, verifiable, and fully controlled by you, it's the memory layer that lets agents handle complex workflows and coordinate using data they can trust.

<CardGroup cols={2}>
  <Card title="Portable by Design" icon="shuffle">
    Memory operates across agents, apps, and workflows — not locked to a single runtime or provider
  </Card>
  <Card title="Fully Under Your Control" icon="key">
    Programmable permissions and explicit ownership define how memory is shared, accessed, and updated
  </Card>
  <Card title="Built for Agent Coordination" icon="robot">
    Shared memory spaces help agents coordinate across long-running and multi-step workflows
  </Card>
  <Card title="Verifiable Integrity" icon="shield-check">
    Memory integrity can be independently verified without centralized trust
  </Card>
</CardGroup>

## Motivation

AI agents today lose context between sessions — every conversation starts from scratch. When memory does exist, it's locked inside platform-specific databases that the user doesn't control. Walrus Memory solves this by giving agents:

- **Portable memory** — memory persists outside prompts and context windows, moving across agents, apps, and workflows
- **Full owner control** — programmable access control and explicit ownership, with delegate access for agents and workflows
- **Agent coordination** — shared memory spaces help agents coordinate across long-running and multi-step workflows
- **Verifiable integrity** — memory integrity can be independently verified without centralized trust

## Features

### Memory Operations

<CardGroup cols={2}>
  <Card title="Remember" icon="floppy-disk">
    Store memories with semantic understanding. The relayer generates vector embeddings so your data is searchable by meaning, not just keywords.
  </Card>
  <Card title="Recall" icon="magnifying-glass">
    Retrieve relevant memories using natural language queries. Finds the closest matches based on meaning, scoped to your memory space.
  </Card>
  <Card title="Analyze" icon="microscope">
    Extract structured facts from text automatically. Each fact is stored as a separate memory for more precise recall later.
  </Card>
  <Card title="Ask" icon="comments">
    Query your memories and get an AI-generated answer with the relevant context attached. Combines recall with LLM reasoning.
  </Card>
</CardGroup>

### Ownership & Access Control

<CardGroup cols={2}>
  <Card title="End-to-End Encryption" icon="lock">
    All content is encrypted via SEAL before it reaches Walrus. Only the owner and authorized delegates can decrypt it.
  </Card>
  <Card title="Decentralized Storage" icon="globe">
    Encrypted blobs stored on Walrus — no single point of failure, no central operator holding your data.
  </Card>
  <Card title="Programmable Permissions" icon="key">
    Ownership and access rules are enforced by Sui smart contracts, giving you explicit, programmable control over who can read and write.
  </Card>
  <Card title="Delegate Access" icon="user-group">
    Grant scoped access to other agents, users, or services — all managed onchain by the owner, enabling agent coordination and cross-app workflows.
  </Card>
</CardGroup>

### Infrastructure

<CardGroup cols={2}>
  <Card title="Restore" icon="rotate">
    Rebuild your index from Walrus if it's ever lost. Rediscovers blobs by owner and namespace, re-embeds only missing entries.
  </Card>
  <Card title="AI Middleware" icon="wand-magic-sparkles">
    Drop-in memory for Vercel AI SDK apps. Automatically saves and recalls context around AI conversations.
  </Card>
</CardGroup>

## What's Included

- **TypeScript SDK**: integrate memory into any app with a few lines of code
- **Relayer**: handles encryption, storage, and retrieval behind a simple API
- **Smart Contract**: enforces ownership and delegate access onchain
- **Indexer**: keeps onchain state synced for fast lookups
- **Dashboard**: manage accounts, memory, and delegate keys visually

## Use Cases

Walrus Memory fits any app where agents need memory that travels with them:

- **AI chat apps** — capture valuable knowledge from conversations so agents remember context across sessions and apps
- **Multi-agent workflows** — shared memory spaces let agents coordinate on task lists, knowledge bases, and coordination state
- **Personal AI assistants** — build agents that learn and adapt over time, with memory the user fully controls
- **Cross-app memory** — let users carry their memory between different apps and services, not locked to any single provider
- **Note-taking and knowledge tools** — save user insights, summaries, and references as portable, verifiable memory

And many more — check out the example apps below to see Walrus Memory in action.

## Example Apps

The repo ships with ready-to-run apps in the [`/apps`](https://github.com/MystenLabs/MemWal/tree/main/apps) directory:

- **Playground** — dashboard demo for Walrus Memory
- **Chatbot** — AI chat app with portable memory across sessions
- **Noter** — note-taking tool that stores knowledge as verifiable memory
- **Researcher** — research assistant that builds and recalls a knowledge base

See [Example Apps](/examples/example-apps) for short code examples from each app.

## Explore the Docs

<CardGroup cols={2}>
  <Card title="Concepts" icon="lightbulb" href="/fundamentals/concepts/memory-space">
    Memory spaces, ownership and delegates
  </Card>
  <Card title="Architecture" icon="building" href="/fundamentals/architecture/core-components">
    System overview, component responsibilities, core flows, data flow security
  </Card>
  <Card title="SDK" icon="box" href="/sdk/quick-start">
    Quickstart, usage patterns, AI integration, and examples
  </Card>
  <Card title="Relayer" icon="tower-broadcast" href="/relayer/overview">
    Managed relayer, installation and setup, self-hosting
  </Card>
  <Card title="Smart Contract" icon="scroll" href="/contract/overview">
    Onchain ownership model, delegate key management, permissions
  </Card>
  <Card title="Indexer" icon="magnifying-glass" href="/indexer/purpose">
    Event indexing, onchain events, database sync
  </Card>
  <Card title="Reference" icon="book" href="/sdk/api-reference">
    SDK API, relayer API, configuration, environment variables
  </Card>
</CardGroup>
