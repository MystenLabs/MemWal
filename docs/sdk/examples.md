---
title: "Examples"
---

## Basic: Store and Recall

The shortest working MemWal example using the default relayer-backed SDK.

```ts
import { MemWal } from "@mysten/memwal";

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  accountId: process.env.MEMWAL_ACCOUNT_ID!,
  serverUrl: process.env.MEMWAL_SERVER_URL,
  namespace: "demo",
});

await memwal.health();

const stored = await memwal.remember(
  "User prefers dark mode and works in TypeScript."
);

const recalled = await memwal.recall(
  "What do we know about this user?",
  5
);

console.log(stored.blob_id);
console.log(recalled.results);
```

What you should see:

- `health()` succeeds
- `remember()` returns a `blob_id`
- `recall()` returns plaintext results for the same namespace

## Advanced: Manual Methods and Analyze

### Manual Registration

Use `rememberManual()` when you already have an encrypted payload plus vector, and `recallManual()`
when you already have a query vector.

### Fact Extraction

Use `analyze()` when you want the relayer to extract facts from longer text and store them as
memories.

```ts
const analyzed = await memwal.analyze(
  "I live in Hanoi, prefer dark mode, and usually work late at night."
);
console.log(analyzed.facts);
```

### AI Middleware

Use `withMemWal` when you want recall before generation and optional auto-save after generation.
See [AI Integration](/sdk/ai-integration) for the full setup.

## Research App Pattern

Use this when you want to store structured research findings and recall them in later sessions.

1. Save a structured summary with `remember()`
2. Generate targeted queries later
3. Use `recall()` to pull relevant findings back into context

Structured summaries usually recall better than raw transcripts because they keep the signal high.
