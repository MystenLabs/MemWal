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
  packageId: '0xb625c403a26c4b985a3f2549e6115c1646b0094d39fa142016807ba015952869',
  registryId: '0x3d46792b7676e6558707982b535092454a46e668b52c0a6d83b9a9fdecd71c46',
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
