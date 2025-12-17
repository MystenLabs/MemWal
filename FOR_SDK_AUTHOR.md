# 📨 For the PDW SDK Author

## 👋 Hi! Your SDK is great, but has a critical bug in v0.3.4

---

## 🐛 The Bug

**File**: `src/permissions/ConsentRepository.ts` (your source code)  
**Problem**: Top-level `await` causes crash in Next.js/server environments

### Current Code (Lines ~9-15):
```typescript
if (typeof window === 'undefined') {
  try {
    const { createRequire } = await import('module');  // ❌ TOP-LEVEL AWAIT
    const require = createRequire(import.meta.url);
    fsPromises = require('fs/promises');
    pathModule = require('path');
  } catch (e) {
    fsPromises = null;
    pathModule = null;
  }
}
```

**Error**:
```
ReferenceError: require is not defined in ES module scope
```

---

## ✅ The Fix (Easy!)

Replace the top-level await with a lazy initialization function:

```typescript
// At the top of the file
let fsPromises: any = null;
let pathModule: any = null;

// Lazy initialization function
async function initNodeModules() {
  if (fsPromises !== null) return; // Already initialized
  
  if (typeof window === 'undefined') {
    try {
      // Use direct ESM imports instead of createRequire
      fsPromises = await import('fs/promises');
      pathModule = await import('path');
    } catch (e) {
      fsPromises = null;
      pathModule = null;
    }
  }
}

// Then in FileSystemConsentRepository class methods:
export class FileSystemConsentRepository implements ConsentRepository {
  async save(request: ConsentRequest) {
    await initNodeModules(); // ← Add this line
    if (!fsPromises) throw new Error('FileSystemConsentRepository not available');
    // ... rest of method
  }

  async readAll() {
    await initNodeModules(); // ← Add this line
    if (!fsPromises || !pathModule) return [];
    // ... rest of method
  }

  async writeAll(records: ConsentRecord[]) {
    await initNodeModules(); // ← Add this line
    if (!fsPromises || !pathModule) throw new Error('Filesystem not available');
    // ... rest of method
  }
  
  // Add to other methods that use fsPromises/pathModule...
}
```

---

## 🎯 Changes Needed

**In your source code** (`src/permissions/ConsentRepository.ts`):

1. ❌ **Remove** top-level `await import('module')`
2. ✅ **Add** `async function initNodeModules()`
3. ✅ **Call** `await initNodeModules()` at start of each method that uses `fsPromises`/`pathModule`

That's it! 3 simple changes.

---

## 🚀 Bonus Feature Request (Optional but Highly Requested)

**Problem**: Current implementation uses browser APIs (`indexedDB`, `hnswlib-wasm`) which don't work in Next.js API routes.

**Request**: Add a **server-side vector search option** that queries the on-chain HNSW index via Sui RPC.

### Proposed API:
```typescript
const pdw = new SimplePDWClient({
  features: {
    enableLocalIndexing: false,    // Disable browser WASM/IndexedDB
    enableRemoteIndexing: true,    // ← NEW! Query on-chain index via RPC
  }
});

// Should work on server-side:
const results = await pdw.search.vector('my query', { limit: 5 });
// Internally: Queries Sui blockchain's on-chain HNSW index via RPC
```

**Why**: This would enable RAG (Retrieval-Augmented Generation) in Next.js/server environments where browser APIs aren't available.

---

## 📊 Current Status

### v0.3.4 Status:
- ✅ Fixed directory imports (good!)
- ❌ Broke with top-level await (critical bug)
- ❌ Can't use local indexing in Next.js (requires browser APIs)

### What Users Are Doing Now:
- 🔧 Manually patching `node_modules` after install
- ⚠️ Disabling `enableLocalIndexing` (no vector search/RAG)
- 📝 Waiting for v0.3.5 or v0.4.0

---

## 🧪 Test in Next.js

To reproduce the bug:

```bash
npx create-next-app@latest test-pdw --typescript --app
cd test-pdw
pnpm add personal-data-wallet-sdk@0.3.4 @mysten/sui
```

```typescript
// app/api/test/route.ts
import { SimplePDWClient } from 'personal-data-wallet-sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

export async function GET() {
  const keypair = new Ed25519Keypair();
  
  const pdw = new SimplePDWClient({
    signer: keypair,
    network: 'testnet',
    packageId: '0x123...',
    geminiApiKey: 'test',
  });
  
  return Response.json({ message: 'loaded' });
}
```

```bash
pnpm run dev
# Visit http://localhost:3000/api/test
# Error: ReferenceError: require is not defined
```

After fix → Should load without errors.

---

## 📦 Release Checklist

For v0.3.5 (or v0.4.0):

- [ ] Fix `ConsentRepository.ts` top-level await
- [ ] Test in Next.js API routes
- [ ] Test in pure Node.js
- [ ] Test in browser (existing tests)
- [ ] (Optional) Add server-side vector search
- [ ] Update docs
- [ ] Publish to npm
- [ ] Update changelog

---

## 💬 Users Who Need This

This fix is needed for:
- ✅ Next.js 14+ App Router users
- ✅ Next.js 13+ API routes
- ✅ Remix loaders/actions
- ✅ SvelteKit server routes
- ✅ Any server-side JavaScript framework

Currently, these users can't use the SDK without manually patching.

---

## 🙏 Thank You!

The SDK is amazing, and this is just a small packaging issue. Once fixed, it will work perfectly in all environments!

**Timeline Request**: Can you release v0.3.5 within a week or two?

---

## 📧 Contact

If you need more details or have questions, feel free to ask!

**What's Working Now** (with our local patch):
- ✅ AI personal data detection
- ✅ Blockchain storage (Sui + Walrus)
- ✅ Knowledge graph extraction
- ✅ Memory creation & classification

**What Needs SDK Fix**:
- ❌ Automatic setup (currently requires manual patch)
- ❌ Vector search in Next.js (needs server-side mode)

---

## 🎯 TL;DR

**The fix is literally just**:
1. Remove top-level `await import('module')`
2. Wrap it in an `async function initNodeModules()`
3. Call it at the start of methods that need Node.js modules

**5-10 minutes of work, will unblock all server-side users!** 🚀
