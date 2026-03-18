# Basic Usage

This page shows the happy path for integrating the current SDK with the relayer.

## 1. Install the SDK

Install the package:

```bash
pnpm add @cmdoss/memwal
```

## 2. Initialize the Client

```typescript
import { MemWal } from "@cmdoss/memwal"

const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  serverUrl: process.env.MEMWAL_SERVER_URL,
})
```

## 3. Check the Relayer

```typescript
await memwal.health()
```

## 4. Store a Memory

```typescript
const result = await memwal.remember("User prefers dark mode and works in TypeScript.")
console.log(result.blob_id)
```

## 5. Recall Similar Memories

```typescript
const result = await memwal.recall("What do we know about this user?", 5)
for (const hit of result.results) {
  console.log(hit.text, hit.distance)
}
```

## Next Steps

- [Advanced Usage](/examples/advanced-usage)
- [SDK Usage](/sdk/usage)
- [SDK API Reference](/reference/sdk-api)
