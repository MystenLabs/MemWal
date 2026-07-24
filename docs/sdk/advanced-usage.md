---
title: "Advanced Usage"
description: >-
  Advanced Walrus Memory SDK usage patterns including manual registration with pre-computed vectors, fact extraction with analyze(), and AI SDK middleware integration.
keywords:
  - Walrus Memory
  - MemWal
  - advanced usage
  - manual registration
  - analyze
  - AI middleware
goal:
  description: Use advanced SDK features like manual registration, analyze for fact extraction, and AI middleware integration.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 50
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - How do I use manual registration with pre-computed vectors in Walrus Memory?
  - How does analyze() extract facts in Walrus Memory?
  - When should I use advanced Walrus Memory features?
answer: >-
  Advanced Walrus Memory features include manual registration (rememberManual/recallManual) for pre-computed vectors and encrypted payloads, analyze() for LLM-based fact extraction from longer text, and withMemWal AI middleware for automatic recall before generation and auto-save after generation.
---

## Use This When

- you already have a vector or encrypted payload
- you want fact extraction with `analyze()`
- you want memory inside an AI SDK pipeline

## Manual Registration

Use:

- `rememberManual()` when you already have encrypted payload plus vector
- `recallManual()` when you already have a query vector

## Analyze

Use `analyze()` when you want the relayer to extract facts from longer text and store them as
memories.

## AI Middleware

Use `withMemWal` when you want:

- recall before generation
- optional auto-save after generation

## Read Next

- [SDK Usage](/sdk/usage)
- [AI Integration](/sdk/ai-integration)
