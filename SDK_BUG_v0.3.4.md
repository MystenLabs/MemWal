# 🐛 NEW BUG in v0.3.4: Top-Level Await in ConsentRepository

## Summary
v0.3.4 fixed the directory import bug ✅, but introduced a **new critical bug** with top-level await.

---

## Error
```
ReferenceError: require is not defined in ES module scope
at file:///.../personal-data-wallet-sdk/dist/permissions/ConsentRepository.js:3:34
```

## Root Cause

### In `dist/permissions/ConsentRepository.js` around line 9-15:

```javascript
if (typeof window === 'undefined') {
  try {
    // Use dynamic import for Node.js built-ins
    const { createRequire } = await import('module');  // ❌ TOP-LEVEL AWAIT
    const require = createRequire(import.meta.url);
    fsPromises = require('fs/promises');
    pathModule = require('path');
```

**Problem**: This code uses `await` at the module's top level **outside of an async function**. While top-level await is supported in Node.js, it doesn't work properly when the module is imported through Next.js/Webpack.

---

## How to Fix (SDK Author)

### Option 1: Wrap in Async Function (Recommended)
```javascript
// Instead of top-level await
let fsPromises = null;
let pathModule = null;

// Initialize lazily when needed
async function initNodeModules() {
  if (fsPromises) return; // Already initialized
  
  if (typeof window === 'undefined') {
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      fsPromises = require('fs/promises');
      pathModule = require('path');
    } catch (error) {
      console.warn('Failed to load Node.js modules:', error);
    }
  }
}

// Then call initNodeModules() before using fsPromises/pathModule
```

### Option 2: Use Direct ESM Imports
```javascript
// Instead of createRequire + require:
import * as fs from 'fs/promises';
import * as path from 'path';

// Conditional export
export const fsPromises = typeof window === 'undefined' ? fs : null;
export const pathModule = typeof window === 'undefined' ? path : null;
```

### Option 3: Mark as Side-Effect Free
In package.json:
```json
{
  "sideEffects": false
}
```

---

## Impact

- ❌ SDK loads but crashes immediately when imported
- ❌ Affects Next.js API routes
- ❌ Affects all server-side usage
- ⚠️ May work in pure Node.js (outside Next.js)

---

## Test Case

```bash
npx create-next-app@latest test-pdw --typescript --app
cd test-pdw
pnpm add personal-data-wallet-sdk@0.3.4 @mysten/sui
```

```typescript
// app/api/test/route.ts
import { SimplePDWClient } from 'personal-data-wallet-sdk';

export async function GET() {
  return Response.json({ message: 'loaded' });
}
```

```bash
pnpm run dev
# Visit http://localhost:3000/api/test
# Error: require is not defined in ES module scope
```

---

## Urgency

🔴 **CRITICAL** - v0.3.4 is still unusable in Next.js/server environments.

**Need v0.3.5 with this fix ASAP!**
