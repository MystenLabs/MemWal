---
title: Manage Your Memories
description: Organize memories with namespaces, find them with recall, and restore them from Walrus using the Walrus Memory SDK.
keywords: [Walrus Memory, memory management, namespaces, recall, restore, search index, delegate key]
---

You manage memories in Walrus Memory with your delegate key and the SDK. Group related memories
into namespaces, find them by meaning with recall, and restore them from Walrus when the relayer
has not indexed them.

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

You manage the namespace day to day. A single wallet can hold as many namespaces as you want, and
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

## Browse, search, and restore

With your client ready, you manage memories through the SDK, always scoped to one namespace:

- **Find memories:** `recall` returns the closest matches by meaning. See
  [Walrus Memory](/sdk/usage/memwal) for the recall API and its options.
- **Restore a namespace:** `restore` rebuilds the relayer's search index from Walrus when the
  index has fallen behind. See [How Storage Works](/fundamentals/architecture/how-storage-works)
  for the full flow.
