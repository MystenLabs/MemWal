# What is MemWal?

MemWal is a privacy-preserving, decentralized memory protocol for humans and AI agents — powered by Walrus and Sui. Store, recall, and share memory across apps, sessions, and agents.

## Motivation

AI agents today lose context between sessions — every conversation starts from scratch. When memory does exist, it's locked inside platform-specific databases that the user doesn't control. MemWal solves this by giving agents:

- **Persistent memory** — context that carries across sessions and apps
- **Decentralized, highly available storage** — with end-to-end encryption baked in
- **Provable ownership** — cryptographically enforced, not just a policy promise
- **Fine-grained access control** — users decide who can read, write, or delegate access

## What's Included

- **TypeScript SDK**: integrate memory into any app with a few lines of code
- **Relayer**: handles encryption, storage, and retrieval behind a simple API
- **Smart Contract**: enforces ownership and delegate access onchain
- **Indexer**: keeps onchain state synced for fast lookups
- **Dashboard**: manage accounts, memory, and delegate keys visually

## Use Cases

MemWal fits any app or protocol that needs to store, retrieve, and update memory persistently:

- **AI chat apps** — capture valuable knowledge from conversations so agents remember context across sessions
- **Note-taking and knowledge tools** — save user insights, summaries, and references as persistent, encrypted memory
- **Multi-agent workflows** — share a common data layer between agents for task lists, knowledge bases, and coordination state
- **Personal AI assistants** — build agents that learn and adapt over time without losing what they've learned
- **Cross-app memory** — let users carry their memory between different apps and services, owned by them

And many more — check out the example apps below to see MemWal in action.

## Example Apps

The repo ships with ready-to-run apps in the [`/apps`](https://github.com/CommandOSSLabs/memwal/tree/main/apps) directory:

- **Chatbot** — AI chat app with persistent memory across sessions
- **Noter** — note-taking tool that stores knowledge as encrypted memory
- **Researcher** — research assistant that builds and recalls a knowledge base