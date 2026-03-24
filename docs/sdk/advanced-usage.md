---
title: "Advanced Usage"
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
