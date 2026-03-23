---
title: "Basic Usage"
---

## Installation

```bash
pnpm add @mysten/memwal
```

## Initialize

```typescript
import { MemWal } from "@mysten/memwal";

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  accountId: process.env.MEMWAL_ACCOUNT_ID!,
  serverUrl: process.env.MEMWAL_SERVER_URL,
  namespace: "my-app",
});
```

## Store a Memory

```typescript
const result = await memwal.remember("User prefers dark mode and works in TypeScript.");
console.log("Blob ID:", result.blob_id);
```

## Recall Memories

```typescript
const results = await memwal.recall("What do we know about this user?", 10);

for (const memory of results.results) {
  console.log(memory.text, `(distance: ${memory.distance})`);
}
```

## Analyze Text

Extract structured facts from longer text and store each as a separate memory.

```typescript
const analyzed = await memwal.analyze(
  "I live in Hanoi, prefer dark mode, and usually work late at night."
);

console.log(`Extracted ${analyzed.total} facts:`);
for (const fact of analyzed.facts) {
  console.log(`- ${fact.text}`);
}
```

## Restore a Namespace

Rebuild missing indexed entries from Walrus if your local database is incomplete.

```typescript
const restored = await memwal.restore("my-app", 50);
console.log(`Restored ${restored.restored} memories, skipped ${restored.skipped}`);
```

## Health Check

```typescript
const health = await memwal.health();
console.log(health.status); // "ok"
```
