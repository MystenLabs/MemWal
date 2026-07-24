---
title: "Examples"
description: >-
  Practical Walrus Memory SDK examples covering basic store and recall, manual registration with pre-computed vectors, fact extraction with analyze(), AI middleware, and a research app pattern for structured memory.
keywords:
  - Walrus Memory
  - MemWal
  - examples
  - store and recall
  - analyze
  - AI middleware
goal:
  description: Run working SDK examples for storing, recalling, analyzing, and using AI middleware, and adapt them as starting points for your own integration.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 200
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - How do I store and recall a memory with the Walrus Memory SDK?
  - How do I extract facts from text with Walrus Memory?
  - What does a basic Walrus Memory example look like?
answer: >-
  The basic example creates a MemWal client, stores a memory with remember(), waits for completion with waitForRememberJob(), and recalls it with recall(). Advanced examples cover manual registration for pre-computed vectors, fact extraction with analyze() for longer text, and AI middleware with withMemWal for automatic recall and save in AI pipelines.
---

## Basic: Store and Recall

The shortest working Walrus Memory example using the default relayer-backed SDK.

```ts
import { MemWal } from "@mysten-incubation/memwal";

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  accountId: process.env.MEMWAL_ACCOUNT_ID!,
  serverUrl: process.env.MEMWAL_SERVER_URL,
  namespace: "demo",
});

await memwal.health();

const accepted = await memwal.remember(
  "User prefers dark mode and works in TypeScript."
);
const stored = await memwal.waitForRememberJob(accepted.job_id);

const recalled = await memwal.recall({
  query: "What do we know about this user?",
  limit: 5,
});

console.log(stored.blob_id);
console.log(recalled.results);
```

What you should see:

- `health()` succeeds
- `remember()` returns a `job_id` immediately
- `waitForRememberJob()` returns a `blob_id`
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
console.log(analyzed.facts, analyzed.job_ids);
```

### AI Middleware

Use `withMemWal` when you want recall before generation and optional auto-save after generation.
See [AI Integration](/sdk/ai-integration) for the full setup.

## Research App Pattern

Use this when you want to store structured research findings and recall them in later sessions.

1. Submit a structured summary with `remember()` and wait for completion when immediate recall is needed
2. Generate targeted queries later
3. Use `recall()` to pull relevant findings back into context

Structured summaries usually recall better than raw transcripts because they keep the signal high.
