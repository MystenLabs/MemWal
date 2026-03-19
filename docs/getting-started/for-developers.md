# For Developers

This is the fastest supported path to a working MemWal integration.

## Do This First

1. get an Ed25519 delegate key
2. start with the relayer-backed SDK
3. choose a namespace for your app
4. run `health()`
5. run one `remember()` and one `recall()`

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

## What You Need

- a delegate key
- a relayer URL
- a namespace
- `@cmdoss/memwal`

## What Happens

1. the SDK signs each request
2. the relayer verifies delegate access onchain
3. memory is stored and searched by `owner + namespace`
4. Walrus keeps encrypted payloads
5. PostgreSQL keeps searchable vector state

## Good Day-One Rules

- keep the same namespace during testing
- use the public relayer before self-hosting
- avoid older MemWal examples from previous iterations

## Read Next

- [Installation](/getting-started/installation)
- [Choose Your Path](/getting-started/choose-your-path)
- [SDK Quick Start](/sdk/quick-start)
