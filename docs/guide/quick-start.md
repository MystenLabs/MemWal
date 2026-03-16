# Quick Start

## Basic Usage

### 1. Initialize the SDK

```typescript
import { MemWal } from '@cmdoss/memwal'

const memwal = new MemWal({
  network: 'testnet',
  packageId: '0x...',
})
```

### 2. Connect Wallet

```typescript
// Using Enoki zkLogin
await memwal.connectEnoki()

// Or using any Sui wallet
await memwal.connectWallet()
```

### 3. Store a Memory

```typescript
const memory = await memwal.addMemory({
  content: 'Important information',
  metadata: { type: 'note' }
})
```

### 4. Search Memories

```typescript
const results = await memwal.search('search query')
```

## Next Steps

- [Basic Examples](../examples/basic-usage.md)
- [Advanced Usage](../examples/advanced.md)
