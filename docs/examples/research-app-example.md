# Research App Example

This example shows how a research-oriented application can use MemWal for persistent memory across
conversations.

## Core Pattern

- save a structured research summary with `remember()`
- generate one or more targeted queries for later retrieval
- use `recall()` to bring relevant findings back into a new session

## Why This Pattern Works

Structured summaries recall better than raw chat transcripts because they keep the signal high and
the noise low.

For a deeper walkthrough, see the legacy page:

- [AI Research Assistant with Remember & Recall](/examples/research-advanced)
