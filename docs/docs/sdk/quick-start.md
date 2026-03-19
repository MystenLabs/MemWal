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

## Good Namespace Examples

- `chatbot-prod`
- `researcher-staging`
- `support-agent`

Avoid keeping everything in `"default"` after early testing.

## What Happens

- the SDK signs each request
- the relayer verifies delegate access
- data is stored and searched by `owner + namespace`
- the relayer coordinates embeddings, SEAL, Walrus, and vector indexing

## Restore Example

```ts
const result = await memwal.restore("demo");
console.log(result);
```

Use restore when the relayer needs to rebuild missing indexed state for one namespace.

## Next Steps

- [SDK Usage](/sdk/usage)
- [AI Integration](/sdk/ai-integration)
- [SDK API Reference](/reference/sdk-api)
