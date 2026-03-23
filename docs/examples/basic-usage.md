# Basic Usage

## Installation

First, install the MemWal SDK:

```bash
pnpm add @mysten/memwal
```

## Initialize

```typescript
import { MemWal } from '@mysten/memwal'

const memwal = new MemWal({
  network: 'testnet',
  packageId: '0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6',
  registryId: '0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437',
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
