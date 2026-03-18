# For Developers

This is the fastest supported path to get MemWal working.

## Recommended First Path

1. Get an Ed25519 delegate key from the MemWal onboarding flow.
2. Start with the relayer-backed SDK, not self-hosting.
3. Set a namespace for your app instead of using one global memory pool.
4. Verify connectivity with `health()`.
5. Run one `remember()` call and one `recall()` call end to end.

## Minimal Example

```ts
import { MemWal } from "@cmdoss/memwal";

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  serverUrl: process.env.MEMWAL_SERVER_URL,
  namespace: "demo",
});

await memwal.health();

await memwal.remember("User prefers dark mode and works in TypeScript.");

const result = await memwal.recall("What do we know about this user?");
console.log(result.results);
```

## What Happens

1. the SDK derives a public key from your delegate key
2. each request is signed with Ed25519
3. the relayer verifies that delegate key against the onchain MemWal account model
4. the relayer embeds, encrypts, uploads, and indexes the memory under your namespace
5. recall searches PostgreSQL by owner plus namespace, then resolves matching blobs from Walrus

## What You Need

- an Ed25519 delegate key
- a relayer URL
- a namespace for your application or product surface
- the SDK package

## Recommended Environment Variables

```bash
MEMWAL_PRIVATE_KEY=...
MEMWAL_SERVER_URL=http://localhost:8000
MEMWAL_NAMESPACE=demo
```

## First-Day Checklist

- verify the relayer with `health()`
- store one test memory with `remember()`
- retrieve it with `recall()`
- try `analyze()` if you want the relayer to extract facts from longer text
- keep using the same namespace so your test data stays isolated

## Avoid On Day One

- do not start by self-hosting unless you need infra control immediately
- do not mix unrelated product surfaces into one namespace
- do not rely on undocumented routes or older SDK examples from previous MemWal iterations

## Read Next

- [Installation](/getting-started/installation)
- [Choose Your Path](/getting-started/choose-your-path)
- [SDK Quick Start](/sdk/quick-start)
