---
title: "What is MemWal?"
description: "Persistent, verifiable memory for AI agents"
---

MemWal introduces a long-term, verifiable memory layer on Walrus, allowing agents to remember, share, and reuse information reliably.

<CardGroup cols={2}>
  <Card title="End-to-End Encrypted" icon="lock">
    Client-side encryption — nobody sees your data but you
  </Card>
  <Card title="Decentralized Storage" icon="globe">
    Stored on Walrus — no single point of failure
  </Card>
  <Card title="AI-Agent Ready" icon="robot">
    Give agents scoped access to memory via delegate keys
  </Card>
  <Card title="Onchain Ownership" icon="key">
    Sui smart contracts enforce who can read and write
  </Card>
</CardGroup>

## Motivation

AI agents today lose context between sessions — every conversation starts from scratch. When memory does exist, it's locked inside platform-specific databases that the user doesn't control. MemWal solves this by giving agents:

- **Persistent memory** — context that carries across sessions and apps
- **Decentralized, highly available storage** — with end-to-end encryption baked in
- **Provable ownership** — cryptographically enforced, not just a policy promise
- **Fine-grained access control** — users decide who can read, write, or delegate access

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

### Security & Access Control

<CardGroup cols={2}>
  <Card title="End-to-End Encryption" icon="lock">
    All content is encrypted via SEAL before it reaches Walrus. Only the owner and authorized delegates can decrypt it.
  </Card>
  <Card title="Decentralized Storage" icon="globe">
    Encrypted blobs stored on Walrus — no single point of failure, no central operator holding your data.
  </Card>
  <Card title="Onchain Ownership" icon="key">
    Ownership and access enforced by Sui smart contracts. Cryptographic and tamper-proof.
  </Card>
  <Card title="Delegate Access" icon="user-group">
    Grant scoped access to other users, agents, or services — all managed onchain by the owner.
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

MemWal fits any app that needs to store, retrieve, and update memory persistently:

- **AI chat apps** — capture valuable knowledge from conversations so agents remember context across sessions
- **Note-taking and knowledge tools** — save user insights, summaries, and references as persistent, encrypted memory
- **Multi-agent workflows** — share a common data layer between agents for task lists, knowledge bases, and coordination state
- **Personal AI assistants** — build agents that learn and adapt over time without losing what they've learned
- **Cross-app memory** — let users carry their memory between different apps and services, owned by them

And many more — check out the example apps below to see MemWal in action.

## Example Apps

The repo ships with ready-to-run apps in the [`/apps`](https://github.com/CommandOSSLabs/memwal/tree/main/apps) directory:

- **App** — dashboard demo for zkLogin, delegate-key setup, and account management
- **Chatbot** — AI chat app with persistent memory across sessions
- **Noter** — note-taking tool that stores knowledge as encrypted memory
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
    Public relayer, installation and setup, self-hosting
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
