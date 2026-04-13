# Memory System Redesign — Requirements Breakdown

## Goal

Produce a **research report + proposal** for a redesigned memory model for MemWal.

## Scope

The report needs to cover:

1. **Memory Lifecycle** — How/when memory is created and curated
2. **Memory History & Archival** — Versioning memories over time (memory A at timestamp X, memory B with same topic at timestamp Y)
3. **Memory Linking** — How to connect related memories together (potentially via knowledge graph)
4. **Memory Retrieval** — How to efficiently extract relevant memories for existing context

## Key Scenarios to Address

- **Temporal relevance**: When a newer memory B covers the same topic as older memory A, should B rank higher? Is A considered irrelevant or just lower priority?
- **Memory versioning**: Users want to track different versions of a memory across timestamps to "remember" how their thinking evolved
- **Timestamp as a query factor**: Time should be a first-class dimension in memory retrieval, not just metadata

## Design Considerations

- Knowledge graph may be an integral part if it fits the model
- Henry has already ported the Mem0 open-source logic to the `feat/memory-structure-upgrade` branch as a starting point

## References

1. **Mem0 paper**: [arxiv.org/abs/2504.19413](https://arxiv.org/abs/2504.19413) — "Building Production-Ready AI Agents with Scalable Long-Term Memory" — covers memory extraction, consolidation, retrieval, and graph-based memory representations
2. **Claude context engineering cookbook**: [platform.claude.com/cookbook/tool-use-context-engineering](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools) — strategies for memory, compaction, and tool clearing in long-running agents
3. **Henry's Mem0 port**: `feat/memory-structure-upgrade` branch ([commit ec00986](https://github.com/MystenLabs/MemWal/commit/ec00986ed3695429dd3f5e32c78e44ce81ac1641)) — working local copy of Mem0 logic

## Stakeholders

- **Daniel Lam** — initiated the brainstorming, owns the vision for the redesign
- **Henry** — ported Mem0 logic to the branch, technical reference
- **Margo** — assigned to produce the research report and proposal
- **Aaron** — discussed timestamp-based memory relevance with Daniel
