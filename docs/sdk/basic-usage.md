---
title: "Basic Usage"
---

## Use This When

- you want the shortest working MemWal example
- you are using the default relayer-backed SDK

## Code

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

## What You Should See

- `health()` succeeds
- `remember()` returns a `blob_id`
- `recall()` returns plaintext results for the same namespace

## Read Next

- [Advanced Usage](/sdk/advanced-usage)
- [SDK Usage](/sdk/usage)
- [SDK API Reference](/reference/sdk-api)
