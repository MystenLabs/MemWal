# Advanced Usage

This page highlights the more advanced surfaces exposed by the current SDK.

## Manual Registration Flow

Use `rememberManual()` when you already have:

- a Walrus blob ID
- a pre-computed embedding vector

Use `recallManual()` when you already have a query vector and want matching blob IDs back.

## Analyze Flow

Use `analyze()` when you want the relayer to extract candidate facts from text and store them as
memories.

## AI Middleware

Use `withMemWal` when you want memory retrieval and optional fact saving to sit inside an LLM
pipeline.
