# Quick Start

This example uses the default relayer-backed client.

```ts
import { MemWal } from "@cmdoss/memwal";

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  serverUrl: process.env.MEMWAL_SERVER_URL,
  namespace: process.env.MEMWAL_NAMESPACE ?? "demo",
});

await memwal.health();

await memwal.remember("I live in Hanoi and prefer dark mode.");

const recall = await memwal.recall("What do we know about this user?");
console.log(recall.results);

const analyzed = await memwal.analyze(
  "I live in Hanoi, prefer dark mode, and usually work late at night."
);
console.log(analyzed.facts);
```

## What Happens

- the SDK signs each request with your delegate key
- the relayer verifies the key against the onchain account model
- memories are stored under the current namespace
- the relayer coordinates embeddings, SEAL, Walrus, and vector indexing

## Restore Example

If local vector state needs to be rebuilt for a namespace, the SDK also exposes:

```ts
const result = await memwal.restore("demo");
console.log(result);
```

Restore is incremental. It restores missing blobs for that namespace instead of rebuilding everything.

## Next Steps

- [SDK Usage](/sdk/usage)
- [AI Integration](/sdk/ai-integration)
- [SDK API Reference](/reference/sdk-api)
