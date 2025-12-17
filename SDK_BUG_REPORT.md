# 🐛 BUG REPORT: personal-data-wallet-sdk v0.3.3

## Summary
The SDK has **ES Module packaging issues** that prevent it from loading in Node.js environments (Next.js API routes).

---

## Error Message
```
Error [ERR_UNSUPPORTED_DIR_IMPORT]: Directory import '/Users/.../node_modules/personal-data-wallet-sdk/dist/pipeline' is not supported
resolving ES modules imported from /Users/.../personal-data-wallet-sdk/dist/index.js
```

---

## Root Cause

### Problem in `dist/index.js` Line 18:
```javascript
export { MemoryPipeline, PipelineManager } from './pipeline';
```

**Issue**: Node.js ES modules don't support directory imports. You must either:
1. Use explicit file paths: `'./pipeline/index.js'`
2. Or use named exports: `'./pipeline/MemoryPipeline.js'` and `'./pipeline/PipelineManager.js'`

---

## How to Reproduce

1. **Install the SDK** in a Next.js project:
   ```bash
   pnpm add personal-data-wallet-sdk @mysten/sui
   ```

2. **Create a simple API route**:
   ```typescript
   // app/api/test/route.ts
   import { SimplePDWClient } from 'personal-data-wallet-sdk';
   
   export async function GET() {
     return Response.json({ status: 'loaded' });
   }
   ```

3. **Run dev server**:
   ```bash
   pnpm run dev
   ```

4. **Visit the API route** → Error occurs

---

## Environment
- **Node.js**: v20+ (ESM strict mode)
- **Package Manager**: pnpm (also affects npm/yarn)
- **Framework**: Next.js 14.2.25 (App Router with API routes)
- **Module System**: ES Modules (type: "module" in package.json)
- **SDK Version**: personal-data-wallet-sdk@0.3.3

---

## Affected Files in SDK

Based on inspection of `dist/index.js`, these imports are problematic:

```javascript
// Line 18 - Directory import
export { MemoryPipeline, PipelineManager } from './pipeline';

// Potentially other directory imports exist too
// All './directory' imports need to be './directory/index.js' or specific files
```

---

## Recommended Fix

### Option 1: Use Explicit Index Files (Recommended)
```javascript
// dist/index.js - Line 18
export { MemoryPipeline, PipelineManager } from './pipeline/index.js';
```

### Option 2: Import from Specific Files
```javascript
// dist/index.js - Line 18
export { MemoryPipeline } from './pipeline/MemoryPipeline.js';
export { PipelineManager } from './pipeline/PipelineManager.js';
```

### Option 3: Fix package.json exports
Add proper exports field to handle directory imports:
```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./dist/pipeline": "./dist/pipeline/index.js",
    "./dist/client/SimplePDWClient.js": "./dist/client/SimplePDWClient.js"
  }
}
```

---

## Workaround (Temporary)

As a temporary workaround, users can try importing directly from specific files:

```typescript
// Instead of:
import { SimplePDWClient } from 'personal-data-wallet-sdk';

// Use direct file import:
const clientModule = await import('personal-data-wallet-sdk/dist/client/SimplePDWClient.js');
const SimplePDWClient = clientModule.SimplePDWClient;
```

**However**: This may still fail if `SimplePDWClient.js` internally depends on the broken pipeline imports.

---

## Additional Information

### SDK Structure (Confirmed to exist):
```
dist/
├── index.js                    ← Entry point (has the bug)
├── pipeline/
│   ├── index.js               ← Exists!
│   ├── MemoryPipeline.js
│   └── PipelineManager.js
└── client/
    ├── SimplePDWClient.js      ← The class users need
    └── ...
```

### All Directory Imports Need Fixing
The SDK likely has multiple directory imports throughout the codebase. All need to be updated to use `.js` extensions or proper package.json exports.

---

## Impact

- ✅ Build succeeds (static analysis doesn't catch this)
- ❌ **Runtime fails** when trying to import/use the SDK
- ❌ Cannot use SDK in Next.js API routes
- ❌ Cannot use SDK in Node.js server-side code
- ❌ May work in browser if bundled differently

---

## Verification After Fix

After fixing, please verify the SDK works in:
1. ✅ Next.js API routes (App Router)
2. ✅ Next.js API routes (Pages Router)
3. ✅ Standalone Node.js scripts
4. ✅ Serverless functions (Vercel, AWS Lambda)
5. ✅ Browser (via bundlers)

---

## Test Case for SDK Author

Create a minimal Next.js project and test:

```bash
npx create-next-app@latest test-pdw-sdk --typescript --app --no-tailwind
cd test-pdw-sdk
pnpm add personal-data-wallet-sdk @mysten/sui
```

```typescript
// app/api/test/route.ts
import { SimplePDWClient } from 'personal-data-wallet-sdk';

export async function GET() {
  return Response.json({ message: 'SDK loaded successfully' });
}
```

```bash
pnpm run dev
# Visit http://localhost:3000/api/test
# Should see success, not ERR_UNSUPPORTED_DIR_IMPORT
```

---

## Contact Information

This issue was discovered while integrating the SDK into a Next.js chatbot with blockchain memory storage.

**Severity**: 🔴 **CRITICAL** - SDK is unusable in Node.js/Next.js environments

**Affected Users**: Anyone using:
- Next.js API routes
- Node.js server-side code
- Serverless functions
- Any ES Module strict environment

---

## Thank You!

The SDK architecture looks great, and we're excited to use it once this packaging issue is resolved. The concept of decentralized personal data storage with RAG is fantastic! 🚀

Please let us know once a fixed version is published to npm.
