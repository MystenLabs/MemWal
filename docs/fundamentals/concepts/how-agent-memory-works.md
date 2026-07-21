---
title: "How AI Agent Memory Works"
description: "How AI agents store and recall long-term memory: the difference between the context window and persistent memory, short-term versus long-term memory, and how semantic memory works with embeddings and vector search."
keywords: [agent memory, AI agent memory, long-term memory, short-term memory, context window, semantic memory, embeddings, vector search, retrieval-augmented generation, persistent memory]
---

An AI agent is only as capable as what it can remember. A model on its own starts every session blank: it has no record of the last conversation, the decisions it made, or what it learned. Agent memory is the layer that gives an agent a durable, searchable record it can carry across sessions, apps, and workflows.

This page explains what agent memory is, how it differs from the model's context window, and how long-term memory actually works under the hood. For the hands-on version, see the [Agent Storage Loop](/sdk/agent-storage-loop).

## The context window is not memory

A large language model reads and writes through its **context window**: the block of tokens it sees on each request. Everything the model "knows" in the moment lives there, and when the request ends, it is gone. The next request starts fresh unless you resend the earlier text.

Treating the context window as memory runs into hard limits:

- **Bounded:** A context window holds a fixed number of tokens. You cannot fit an agent's entire history into it, and stuffing it with old turns crowds out room for the current task.
- **Temporary:** Nothing in the window survives the request. Persistence has to come from somewhere the model does not control.
- **Expensive to re-send:** Replaying a long history on every call costs tokens and latency, and most of that history is irrelevant to the current question.

Long-term memory solves this by keeping the agent's knowledge outside the prompt and pulling only the relevant pieces back into the context window when they are needed.

| | Context window | Long-term memory |
|---|---|---|
| **Lifetime** | One request | Persists across sessions |
| **Capacity** | Fixed token budget | Effectively unbounded |
| **Retrieval** | Everything, every call | Only the relevant pieces, on demand |
| **Who holds it** | The model provider, transiently | A store you control |

## Short-term and long-term memory

By analogy with how people think about memory, an agent has two layers:

- **Short-term (working) memory** is the context window: the current conversation, the task at hand, and whatever you have just retrieved. It is fast and immediate, but small and fleeting.
- **Long-term memory** is a durable store outside the model: past conversations, extracted facts, embeddings, and checkpoints. It is large and persistent, and the agent reaches into it deliberately.

A working agent uses both. It keeps the active task in the context window and, when it needs something it does not currently hold, it retrieves that from long-term memory and adds it to the window.

## How long-term memory works

Long-term memory for agents is usually **semantic**: the agent stores and retrieves by *meaning* rather than by exact keywords. The mechanism behind this is embeddings and vector search.

1. **Embed.** When you store a piece of text, an embedding model converts it into a vector, a list of numbers that captures its meaning. Two texts about the same idea produce vectors that sit close together, even if they share no words.
2. **Store.** The vector is saved alongside the original text (and any metadata) so it can be searched later.
3. **Recall.** When the agent needs context, its query is embedded into a vector too. The store returns the entries whose vectors are closest to the query vector, ranked by similarity. Those results are the agent's relevant memories.
4. **Augment.** The agent adds the retrieved memories to its context window and answers with them in hand. This retrieve-then-answer pattern is the core of retrieval-augmented generation.

<Note>
Semantic recall is why an agent can answer "How are session tokens issued?" from a memory written as "createSession signs a JWT with a 30-minute TTL," even though the two share almost no words. The embeddings encode meaning, so the match is by concept, not by string.
</Note>

### Kinds of memory an agent keeps

Not every memory is a conversation turn. Agents accumulate several kinds of long-term memory:

- **Semantic memory** is general knowledge and facts: how a system works, a user's preferences, a project convention.
- **Episodic memory** is a record of what happened: past conversations, actions taken, and their outcomes.
- **Procedural memory** is how to do things: reusable steps, workflows, and learned routines.

The same store can hold all three. What matters is that each item is individually retrievable by meaning when the agent needs it.

## How Walrus Memory implements this

Walrus Memory is a long-term memory layer built for agents. It handles the embed, store, and recall loop for you and adds durability, ownership, and verifiability that a plain database does not provide:

- **Remember and recall:** These run the semantic loop above. `remember` embeds and stores an item, and `recall` embeds your query and returns the closest matches, scoped to a [memory space](/fundamentals/concepts/memory-space).
- **Analyze:** Extracts discrete facts from a longer text and stores each as its own memory, so recall is precise instead of returning one large blob.
- **Durable and portable:** Memories are encrypted and stored on Walrus, so they outlive any single process or provider and travel with the agent across apps. See [Persistent, Verifiable Memory](/fundamentals/concepts/verifiable-memory).
- **Owner-controlled:** Ownership and access are enforced onchain through Sui, not by whoever runs the server. See [Ownership and Access](/fundamentals/concepts/ownership-and-access).

## Next steps

<CardGroup cols={2}>
  <Card title="Agent Storage Loop" icon="arrows-rotate" href="/sdk/agent-storage-loop">
    Build the write-confirm-recall loop end to end with the SDK.
  </Card>
  <Card title="Headless SDK Setup" icon="server" href="/sdk/headless-setup">
    Initialize memory in a server or agent runtime with no browser step.
  </Card>
  <Card title="Where to Store AI Agent Data" icon="scale-balanced" href="/fundamentals/concepts/where-to-store-agent-data">
    Compare Walrus Memory with vector databases and other options.
  </Card>
  <Card title="Memory Space" icon="folder" href="/fundamentals/concepts/memory-space">
    Understand how memories are scoped, isolated, and retrieved.
  </Card>
</CardGroup>
