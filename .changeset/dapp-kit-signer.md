---
"@cmdoss/memwal-sdk": patch
---

Add DappKitSigner for @mysten/dapp-kit wallet integration

**New Features:**
- `DappKitSigner` adapter for browser wallet signing with dapp-kit hooks
- `getClient()` method on `UnifiedSigner` interface for SuiClient access
- `./browser` export path for browser-safe imports (excludes Node.js dependencies)

**Bug Fixes:**
- Fix VectorService metadata priority for correct blob retrieval
- Dynamic import for createHnswService to prevent bundling hnswlib-node in browser builds

**Usage with Slush/Sui wallets:**
```typescript
import { DappKitSigner, SimplePDWClient } from '@cmdoss/memwal-sdk/browser';
import { useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';

const signer = new DappKitSigner({
  address: account.address,
  client: suiClient,
  signAndExecuteTransaction: signAndExecute,
});

const pdw = new SimplePDWClient({ signer, network: 'testnet', ... });
await pdw.memory.create('Hello world'); // Wallet popup for signing
```
