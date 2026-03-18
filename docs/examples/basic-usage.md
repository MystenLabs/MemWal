# Basic Usage

## Installation

First, install the MemWal SDK:

```bash
pnpm add @cmdoss/memwal
```

## Initialize

```typescript
import { MemWal } from '@cmdoss/memwal'

const memwal = new MemWal({
  network: 'testnet',
  packageId: '0x12b28adbe55c25341f08b8ad9ac69462aab917048c7cd5b736d951200090ee3f',
  registryId: '0xfb8a1d298e2a73bdab353da3fcb3b16f68ab7d1f392f3a5c4944c747c026fc05',
})
```

## Connect Wallet

```typescript
// Using Enoki zkLogin (Google)
await memwal.connectEnoki()

// Or using Sui wallet
await memwal.connectWallet()
```

## Store Memory

```typescript
const memory = await memwal.addMemory({
  content: 'Your memory content here',
  metadata: {
    type: 'note',
    tags: ['important', 'work']
  }
})

console.log('Memory ID:', memory.id)
```

## Search Memories

```typescript
const results = await memwal.search('search query', {
  limit: 10
})

results.forEach(memory => {
  console.log(memory.content)
})
```

## Get All Memories

```typescript
const allMemories = await memwal.getMemories()

console.log(`Found ${allMemories.length} memories`)
```
