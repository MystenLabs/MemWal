---
title: "Manage Your Memories"
description: "Organize memories with namespaces, find them with recall, and restore them across devices using the Walrus Memory SDK."
---

## Overview

You manage memories in Walrus Memory with your delegate key and the SDK. Group related memories
into namespaces, find them by meaning with recall, and restore them onto a new device when your
local index is empty.

<Info>
  Walrus Memory scopes every operation to your wallet and a single namespace, so you always work
  within one memory space at a time.
</Info>

## How Walrus Memory organizes memories

Walrus Memory groups your memories into memory spaces. A memory space isolates your storage, and
these values identify it:

| **Component** | **What it is** |
| --- | --- |
| Owner address | The Sui wallet address that owns the memory. |
| Namespace | A label you choose to group related memories, for example `personal` or `work`. |
| App ID | The Walrus Memory package ID, unique to each relayer deployment. |

You manage the namespace day to day. One wallet can hold as many namespaces as you want, and
memories in one namespace never mix with another. For more detail, see
[Memory Space](/fundamentals/concepts/memory-space).

## Prerequisites

Create a client with your delegate key, account ID, relayer URL, and the namespace you want to
manage. To set these up for the first time, see [Walrus Memory](/sdk/usage/memwal).

```ts
import { MemWal } from "@mysten-incubation/memwal";

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  accountId: process.env.MEMWAL_ACCOUNT_ID!,
  serverUrl: process.env.MEMWAL_SERVER_URL,
  namespace: "personal",
});
```

## Browse and search your memories

Recall finds memories by meaning rather than by keyword, and returns the closest matches within
one namespace. Use it to review what you have stored:

```ts
const result = await memwal.recall({
  query: "food allergies",
  limit: 20,
  namespace: "personal",
});

for (const memory of result.results) {
  console.log(memory.text);
}
```

Pass a `namespace` to search a specific memory space, or omit it to use the client's default.
Raise `limit` to return more matches. To move between memory spaces, change the namespace.

## Restore memories on a new device

Walrus Memory keeps a local index for fast search, but you can rebuild it from Walrus at any time.
When a new device has no index, restore rediscovers your memories from the chain:

```ts
// Restore up to 500 of the newest blobs in the "personal" namespace.
await memwal.restore("personal", 500);
```

Restore processes up to `limit` blobs per call, newest first, and defaults to 10. It does not page
through older blobs on its own, so set a `limit` at least as large as the namespace you want to
restore. For the full flow, see [How Storage Works](/fundamentals/architecture/how-storage-works).

<Note>
  Restore only rediscovers memories that Walrus Memory wrote, because it matches on the namespace
  metadata that Walrus Memory attaches at upload.
</Note>
