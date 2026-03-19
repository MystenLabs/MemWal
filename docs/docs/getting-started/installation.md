# Quick Start

The fastest way to get MemWal running is through the TypeScript SDK.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+ or [Bun](https://bun.sh/) v1+
- A delegate key (Ed25519 private key in hex)
- A relayer URL — use the [public relayer](/relayer/public-relayer) to get started

## Installation

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
  <TabItem value="pnpm" label="pnpm" default>

```bash
pnpm add @cmdoss/memwal
```

  </TabItem>
  <TabItem value="npm" label="npm">

```bash
npm install @cmdoss/memwal
```

  </TabItem>
  <TabItem value="yarn" label="yarn">

```bash
yarn add @cmdoss/memwal
```

  </TabItem>
  <TabItem value="bun" label="bun">

```bash
bun add @cmdoss/memwal
```

  </TabItem>
</Tabs>

### Optional packages

For AI middleware with [Vercel AI SDK](https://sdk.vercel.ai/) (`@cmdoss/memwal/ai`):

<Tabs>
  <TabItem value="pnpm" label="pnpm" default>

```bash
pnpm add ai
```

  </TabItem>
  <TabItem value="npm" label="npm">

```bash
npm install ai
```

  </TabItem>
  <TabItem value="yarn" label="yarn">

```bash
yarn add ai
```

  </TabItem>
  <TabItem value="bun" label="bun">

```bash
bun add ai
```

  </TabItem>
</Tabs>

For the [manual client flow](/getting-started/choose-your-path) (`@cmdoss/memwal/manual`):

<Tabs>
  <TabItem value="pnpm" label="pnpm" default>

```bash
pnpm add @mysten/sui @mysten/seal @mysten/walrus
```

  </TabItem>
  <TabItem value="npm" label="npm">

```bash
npm install @mysten/sui @mysten/seal @mysten/walrus
```

  </TabItem>
  <TabItem value="yarn" label="yarn">

```bash
yarn add @mysten/sui @mysten/seal @mysten/walrus
```

  </TabItem>
  <TabItem value="bun" label="bun">

```bash
bun add @mysten/sui @mysten/seal @mysten/walrus
```

  </TabItem>
</Tabs>

## Configure

Set up the SDK with your delegate key and relayer URL:

```ts
import { MemWal } from "@cmdoss/memwal";

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  serverUrl: process.env.MEMWAL_SERVER_URL,
  namespace: "my-app",
});
```

## Verify

Run a health check to confirm your connection:

```ts
await memwal.health();
```

## Store and recall your first memory

```ts
await memwal.remember("User prefers dark mode and works in TypeScript.");

const result = await memwal.recall("What do we know about this user?");
console.log(result.results);
```

That's it — you're up and running.

## Next steps

- [SDK Usage](/sdk/usage) — explore the full SDK surface
- [AI Integration](/sdk/ai-integration) — add memory to AI agents

