---
title: "Where to Store AI Agent Data"
description: "A decision guide for where to store data for autonomous AI agents: provider-native memory, managed and self-hosted vector databases, and Walrus Memory, compared across persistence, portability, ownership, and verifiability."
keywords: [where to store AI agent data, AI agent data storage, data storage for AI agents, vector database for AI agents, agent memory storage, decision guide, Walrus Memory]
---

When you give an AI agent long-term memory, you have to decide where that data lives. The choice shapes what the agent can do later: whether its memory survives a restart, moves with the user to another app, stays under the user's control, and can be trusted. This guide compares the common options and shows where each one fits.

If you are new to how agent memory works at all, start with [How AI Agent Memory Works](/fundamentals/concepts/how-agent-memory-works).

## The options

Most teams choose among four approaches:

- **Provider-native memory:** The memory feature built into an agent platform or model provider. It is the least work to turn on, but the data lives inside that provider and follows its rules.
- **Managed vector database:** A hosted vector store such as a cloud vector database. The provider runs the database, and you design the schema, generate embeddings, and manage access in your application.
- **Self-hosted vector database:** A vector store you run yourself, for example `pgvector`, Qdrant, or Chroma. You control everything and you also operate everything.
- **Walrus Memory:** A memory layer that runs the embed, store, and recall loop for you, stores encrypted data on Walrus, and enforces ownership and access onchain through Sui.

## Compare the approaches

The right choice depends on which properties your agent actually needs. The table compares them at the capability level.

| Property | Provider-native memory | Vector database (managed or self-hosted) | Walrus Memory |
|---|---|---|---|
| **Persists across sessions** | Yes, within that provider | Yes | Yes |
| **Semantic (meaning-based) recall** | Usually | Yes | Yes |
| **Portable across apps and providers** | No, locked to the provider | You own the data, but you migrate it yourself | Yes, control follows the onchain account |
| **Ownership and access enforced independently** | No, the provider decides | At the application layer, by your code | Yes, onchain through Sui smart contracts |
| **Integrity independently verifiable** | No | No | Yes, content-addressed blobs plus onchain records |
| **Encrypted before storage** | Provider-dependent | You configure it | Yes, encrypted with Seal before it reaches Walrus |
| **Infrastructure you operate** | None | Managed: the database. Self-hosted: the full stack | None by default, self-hosting is optional |

A vector database gives you persistence and semantic recall, which is often all a single application needs. The properties that set Walrus Memory apart are **portability**, **owner-controlled access enforced onchain**, and **verifiable integrity**, without asking you to run storage infrastructure.

## Choose based on what you need

Use this as a decision guide:

- **Choose provider-native memory** when you are prototyping inside one platform and the data never needs to leave it. Expect to give up portability and independent control.
- **Choose a managed vector database** when you are building a single application, you want semantic search, and the data staying inside your own account is enough. You own the operational and access-control model.
- **Choose a self-hosted vector database** when you need full control of the stack and are prepared to run and secure it, and you do not need portability across apps or onchain ownership.
- **Choose Walrus Memory** when memory should travel with the user or agent across apps, ownership and access should be enforced independently of whoever runs the server, integrity should be verifiable, and you would rather not operate storage yourself.

<Note>
These options are not mutually exclusive. An agent can keep a small local cache for speed and use Walrus Memory as the durable, portable store of record. Because recall returns a `blob_id` for each memory, you can always point back to the exact stored item.
</Note>

## Where Walrus Memory fits against a vector database

Teams often frame this decision as choosing the best vector database for AI agents, but a vector database and Walrus Memory solve overlapping but different problems. A vector database is a search index: it stores vectors and returns nearest neighbors. Walrus Memory uses a vector index internally for exactly that, and adds the layer most agent products end up needing anyway:

- **The data outlives the index:** The encrypted memories live on Walrus, and the vector index is a cache that `restore` can rebuild from Walrus. Losing the database does not lose the memory.
- **Ownership is not an application concern:** Who can read or write a memory space is enforced by Sui smart contracts, so it holds across apps and relayers rather than being reimplemented per application.
- **Portability is built in:** Because control follows the onchain account, a user can move between apps or relayers without exporting and re-importing data.

If you only need nearest-neighbor search inside one app, a vector database is simpler. If you need memory that is durable, portable, owner-controlled, and verifiable, that is what Walrus Memory adds on top.

## Next steps

<CardGroup cols={2}>
  <Card title="How AI Agent Memory Works" icon="brain" href="/fundamentals/concepts/how-agent-memory-works">
    The concepts behind long-term agent memory and semantic recall.
  </Card>
  <Card title="Persistent, Verifiable Memory" icon="shield-check" href="/fundamentals/concepts/verifiable-memory">
    How durability, ownership, and verifiability actually work.
  </Card>
  <Card title="Agent Storage Loop" icon="arrows-rotate" href="/sdk/agent-storage-loop">
    Build the write-confirm-recall loop with the SDK.
  </Card>
  <Card title="Quickstart" icon="rocket" href="/sdk/quick-start">
    Store and recall your first memory.
  </Card>
</CardGroup>
