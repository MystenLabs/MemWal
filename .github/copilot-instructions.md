# Personal Data Wallet — Copilot Guide (SDK: packages/pdw-sdk)

Purpose: make AI agents productive inside the SDK by pointing to the right files, APIs, and workflows.

## Scope and role
- **Primary Purpose**: PDW is a vector embedding storage system that stores vector embeddings on Walrus with rich metadata, tag-based search, and graph relationships
- The SDK wraps Sui + Walrus + SEAL and exposes a single client extension for vector embedding storage, metadata search, access control, and view calls
- **Core Functionality**: Store vector embeddings with metadata → Search by tags/properties → Build knowledge graphs → SEAL encryption for sensitive data
- It relies on generated Move bindings under `src/generated/pdw/*` and a configured `packageId` to talk to deployed contracts

## Current Status: Dynamic Fields Architecture Complete ✅
**PRODUCTION READY**: Wallet system upgraded to use Sui dynamic object fields for context storage with zero build errors.

### ✅ Completed Implementation Phases:
1. **✅ SEAL Integration**: SealService working with official @mysten/seal package
2. **✅ Walrus Integration**: StorageService using official writeBlobFlow patterns with upload relay
3. **✅ Memory Operations**: Existing memory creation/retrieval flows confirmed working
4. **✅ Client Extension**: PersonalDataWallet client extension loading and functioning correctly
5. **✅ OAuth Access Control**: Comprehensive OAuth-style permission system implemented and tested
6. **✅ Smart Contract**: Updated seal_access_control.move deployed with OAuth validation
7. **✅ ViewService Testing**: 33/33 comprehensive tests passing (100% success rate)
8. **✅ StorageService Consolidation**: Production service with 4/4 tests passing (~60s execution time)
9. **✅ HNSW Consolidation**: Removed custom BrowserHNSW implementation (-375 lines), unified to native hnswlib-node (10-100x faster)
10. **✅ QueryService Enhancement**: Integrated latest EmbeddingService API with embedText, embedBatch, similarity calculations
11. **✅ Dynamic Fields Architecture**: Complete wallet system using Sui dynamic object fields (see DYNAMIC_FIELDS_IMPLEMENTATION.md)

### **CRITICAL Test Quality Gates**:
- **ALL TESTS MUST PASS**: No component proceeds to next phase with failing tests
- **100% Pass Rate Required**: Tests must achieve complete success before moving forward
- **Real Data Integration**: Use actual object IDs from testnet for realistic testing
- **Run Tests After Every Edit**: Verify test success after each implementation change

### Real Testnet Data Sources (for realistic testing):
**User Address**: `0xc5e67f46e1b99b580da3a6cc69acf187d0c08dbe568f8f5a78959079c9d82a15`
**Suiscan URL**: https://suiscan.xyz/testnet/account/0xc5e67f46e1b99b580da3a6cc69acf187d0c08dbe568f8f5a78959079c9d82a15

**Real Walrus Blob IDs** (use in tests instead of mock data):
- `0x0e9058ca720598c364352f37d0aa4d2b15961242354f361f3df4f2a020f4b237` (12b)
- `0x0fc3708e2b08c54410ba2d114dc2ad142a11432feaf2e5e468322ec5c3e7ca0f` (445556b)
- `0x15f25a0cc3a7c7cc7034c2fe4cd6f0b8878bccdb77cd2cd129c1c64d3b30a920` (445556b)
- `0x189be71333f2ee345b024f2fb7ffed7e4ad8ff4c99475c8a7b15c8246795ca65` (445556b)
- `0x33067d2b6b210090fd7f2f0404acd31e48025285300a29b6162f85903fbee3f5` (445556b)
- `0x4607877ecddf59c0b3b9db32516b883b39d6a82df1bfa9fd5a621b188f8fbdfa` (445556b)
- `0x4bffaf33b4d3f8242a4cebe7e991b769de5bf5ceffa8bccecab12cd9ce751eaf` (445556b)
- `0x5433c4d7e3ca64e70b7b9f05ce551ed82ec50b9b2341decc9199acbcf18cd6fd` (445556b)
- `0x5575e73b9158be786635e4470b461def1d16ad04349b6640d510846396940a2d` (445556b)
- `0x6bac5a31f0aa8ba2eb45090eb475209e77b555012e9a44a4b138206381ad10a2` (445556b)

**Object Type**: `0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66::blob::Blob`

### ✅ WALRUS TESTNET INFRASTRUCTURE STATUS
**CURRENT STATUS**: Walrus storage integration is code-complete and live testnet uploads now succeed:
- **✅ StorageService**: Complete rewrite using client extension pattern with upload relay
- **✅ Upload Relay Integration**: Uses `https://upload-relay.testnet.walrus.space` for reliable uploads
- **✅ Network Configuration**: Added `undici` Agent with 60-second timeouts as per official examples
- **✅ Proper Attributes**: Fixed metadata to use Walrus `attributes` parameter correctly
- **✅ Real Implementation**: Uses actual private keys from `.env.test` with WAL tokens
- **✅ Network Restored**: Testnet storage nodes renewed SSL certificates; uploads/downloads verified operational
- **📌 Monitor**: Keep an eye on future certificate expirations and report regressions to Walrus team promptly

**Comprehensive Test Status**: 
- **✅ Code Quality**: All major issues resolved, build successful
- **✅ TypeScript**: Zero compilation errors across entire SDK (29% code reduction from HNSW consolidation)
- **✅ StorageService**: 4/4 tests passing with real Walrus writeBlobFlow operations  
- **✅ API Integration**: PersonalDataWallet, QueryService, HnswIndexService working
- **✅ Legacy Cleanup**: Duplicate services removed, custom BrowserHNSW removed (-375 lines), imports unified to services/ directory
- **✅ Native HNSW**: Using hnswlib-node (10-100x faster than pure JS implementation)
- **✅ Test Suite**: 98/98 production tests passing (8 cross-context + 10 SEAL + 18 Classifier + 12 Gemini + 34 GraphService + 16 KnowledgeGraphManager)

### Current Phase: Dynamic Fields Architecture Complete ✅
**WALLET SYSTEM IMPLEMENTED**: Complete implementation using Sui dynamic object fields with zero build errors:
- **✅ Move Contract Enhanced**: wallet.move with dynamic field support, entry functions, helper methods
- **✅ SDK Types Updated**: ContextWallet with contextId/permissions, new DerivedContext interface
- **✅ MainWalletService Enhanced**: Added getContextInfo(), contextExists() for dual-mode operation
- **✅ ContextWalletService Rewritten**: Full dynamic field integration (create, fetch, list methods)
- **✅ Build Verification**: Zero TypeScript compilation errors across entire SDK
- **✅ Architecture Requirements**: MainWallet per user ✓, Deterministic derivation ✓, 3rd party create ✓, Read with permissions ✓, No delete ✓

**Implementation Complete** (see docs/DYNAMIC_FIELDS_IMPLEMENTATION.md):
- **Wallet Architecture**: MainWallet stores ContextWallets as dynamic fields using app_id as key
- **Deterministic IDs**: sha3_256(userAddress || appId || context_salt) for SEAL/tags
- **O(1) Lookups**: Direct context retrieval by app_id
- **Permission Model**: OAuth-style scopes (read:own, write:own, read:other, write:other) - NO delete
- **3rd Party Integration**: Any app can create contexts for users (with signature)
- **Cross-Context Access**: Apps can read other contexts with explicit user permission grants

### 🚧 In Flight: Hierarchical Wallet SEAL Access Control Redesign
- **Objective**: Replace app_id-scoped permissions with wallet-based allowlists that align with SEAL IBE identities.
- **Wallet Hierarchy**: Main wallet acts as administrator; per-app context wallets derived via Sui Kit HD paths (target: `m/44'/784'/0'/0/app_index`).
- **Move Contract Changes**: `seal_access_control.move` will transition to `address` identities, add allowlist tables for `(requester_wallet, target_wallet, scope, expiry)` and emit audit events for grants/revocations.
- **SDK Updates**: `SealService` will manage per-context session keys, new wallet manager under `src/wallet/` handles deterministic derivation, and a permissions module under `src/permissions/` orchestrates allowlist transactions.
- **Backend Alignment**: `backend/src/infrastructure/seal/seal.service.ts` will proxy allowlist requests, coordinate main-wallet approvals, and cache permission state.
- **Migration Strategy**: Maintain temporary compatibility layer to honor legacy `app_id` ciphertexts while registering new context wallet addresses and replaying permissions.
- **Testing Requirements**: Add integration suites to validate allowlist enforcement, hierarchical derivation, and cross-context aggregation with SEAL key servers.

**Key Files**:
- **Move Contract**: smart-contract/sources/wallet.move (dynamic fields, entry functions, events)
- **SDK Services**: packages/pdw-sdk/src/wallet/{MainWalletService,ContextWalletService}.ts
- **Types**: packages/pdw-sdk/src/types/wallet.ts (ContextWallet, DerivedContext, MainWallet)
- **Documentation**: docs/DYNAMIC_FIELDS_IMPLEMENTATION.md (complete guide with examples)

## Key files to know
- Client extension: `src/client/PersonalDataWallet.ts` (public surface: `pdw.createMemory`, `pdw.tx/*`, `pdw.call/*`, `pdw.view/*`, `pdw.bcs`)
- **✅ WALLET SERVICES**: `src/wallet/MainWalletService.ts`, `src/wallet/ContextWalletService.ts` (dynamic field architecture)
- Transactions: `src/services/TransactionService.ts` (uses `@mysten/sui/transactions` Transaction, not TransactionBlock)
- **✅ PRODUCTION STORAGE**: `src/services/StorageService.ts` (official @mysten/walrus writeBlobFlow integration)
- **✅ NATIVE HNSW**: `src/vector/HnswIndexService.ts` (native hnswlib-node with batching, caching, Walrus persistence)
- **✅ MEMORY INDEXING**: `src/services/MemoryIndexService.ts` (high-level memory operations using native HNSW)
- **✅ EMBEDDINGS**: `src/services/EmbeddingService.ts` (Google Gemini API with embedText, embedBatch, similarity calculations)
- **✅ ADVANCED QUERIES**: `src/services/QueryService.ts` (semantic, vector, hybrid search with EmbeddingService integration)
- Encryption/SEAL: `src/services/EncryptionService.ts`, `src/security/SealService.ts`
- Views: `src/services/ViewService.ts` | Blockchain helpers: `src/blockchain/*`
- Knowledge Graph: `src/graph/GraphService.ts`, `src/services/KnowledgeGraphManager.ts`
- Generated types: `src/generated/pdw/{memory,seal_access_control,wallet}.ts`
- Codegen config/scripts: `sui-codegen.config.ts`, `scripts/{fix-codegen-paths.js,verify-deployment.js}`
- Examples/tests: `examples/*.ts`, `test/*.ts`
  - ⚠️ **Active Constraint**: During the current demo-hardening sprint, all source edits must stay within `packages/pdw-sdk/*`. Treat frontend/backend adjustments as out-of-scope and capture follow-ups instead of patching them directly.
  - **PDW Chat Demo**: lives in `packages/pdw-sdk/examples/pdw-chat-demo/`, is intentionally independent from the root frontend/backend codebase, and must remain fully runnable—keep its backend/frontend builds green and verify the README steps.

**Legacy/Deprecated Files** (do not use):
- `src/storage/{WalrusService,WalrusStorageService,StorageManager}.ts` - Use `services/StorageService` instead
- `src/storage/WalrusTestAdapter.ts` - Disabled during consolidation
- Custom BrowserHNSW implementation - Removed, use native HnswIndexService

## Public API patterns (how to use)
- Extend Sui client: `const client = new SuiClient(...).$extend(PersonalDataWallet /* or PersonalDataWallet.asClientExtension(cfg) */)` → access via `client.pdw`.
- **Main Wallet Operations**: `mainWalletService.createMainWallet(userAddress)`, `getMainWallet(userAddress)`, `deriveContextId(userAddress, appId)`, `getContextInfo(userAddress, appId)`, `contextExists(userAddress, appId)`.
- **Context Wallet Operations**: `contextWalletService.create(userAddress, { appId }, signer)`, `getContextForApp(userAddress, appId)`, `listUserContexts(userAddress)`, `ensureContext(userAddress, appId, signer)`.
- **Vector Embedding Storage**: `pdw.createMemory(content, embeddings, metadata)`, `pdw.searchMemories(query, tags)`, `pdw.getMemoryContext(contextId)`.
- **Graph Operations**: Build knowledge graphs with embeddings, search by relationships and metadata tags
- **Advanced Queries**: Use `QueryService` for semantic/hybrid/analytical search with auto-embedding generation
- **Embeddings**: `EmbeddingService.embedText({ text, type, taskType })` → `{ vector, dimension, model, processingTime }`
- **Vector Search**: Native HNSW via `HnswIndexService` with O(log N) performance, batching, metadata filtering
- Transactions: build with `pdw.tx.createMemoryRecord(...)` (returns Transaction) or execute with `pdw.call.createMemoryRecord(opts, signer)`.
- Views: `pdw.view.getUserMemories(addr)`, `getMemory(id)`, `getMemoryIndex(addr)`, `objectExists(id)`.
- BCS/types: `pdw.bcs.Memory`, `MemoryIndex`, `MemoryMetadata`, plus access-control types from `seal_access_control`.


## Wallet SDK API (specs to implement)
- Main wallet
	- `pdw.wallet.getMainWallet(userAddress)` → `MainWallet` metadata (on-chain id, createdAt, derivation salts)
	- `pdw.wallet.deriveContextId(userAddress, appId)` → deterministic contextId (sha3(user|app|salt))
	- `pdw.wallet.rotateKeys(userAddress)` → rotates SEAL session/backup keys (uses `EncryptionService`)
- Context wallets
	- `pdw.context.create(appId, opts)` → creates app-scoped container; persists registry entry (Sui) + backing blobs (Walrus)
	- `pdw.context.addData(contextId, item)` | `removeData(contextId, itemId)` | `list(contextId, filters)`
	- Isolation: enforce `contextId` on all CRUD, never mixing appIds
- Cross-app access
	- `pdw.access.requestConsent(request: ConsentRequest)` → creates a pending consent (off-chain via `apiUrl`) and optional on-chain intent
	- `pdw.access.grant({ contextId, recipientAppId, scope, expiresAt })` → Move call to register policy; mirrors in Walrus tag
	- `pdw.access.revoke({ grantId })` → revoke on-chain + invalidate cached policy
	- `pdw.aggregate.query({ apps: appIds[], userAddress, query, scope })` → runs retrieval across permitted contexts only

Contracts for inputs/outputs (types/wallet.ts):
- `MainWallet { owner: string; walletId: string; createdAt: number; salts: { context: string } }`
- `ContextWallet { id: string; appId: string; owner: string; policyRef?: string; createdAt: number }`
- `ConsentRequest { requesterAppId: string; targetScopes: string[]; purpose: string; expiresAt?: number }`
- `AccessGrant { id: string; contextId: string; granteeAppId: string; scopes: string[]; expiresAt?: number }`

## Dev workflow (SDK package)
- Install deps (peer): `@mysten/sui` required by consumers.
- Codegen after Move changes: run from `packages/pdw-sdk` → `npm run codegen` (generates under `src/generated/pdw/*` and fixes paths).
- Build: `npm run build` (runs codegen then TS build for CJS + ESM).
- **Testing Phase**: Before new feature development, validate current functionality:
  - `npm test` (Jest); SEAL connectivity: `npm run test:seal`; quick check: `npm run verify:quick`; deployment check: `npm run verify:deployment`.
  - Test SEAL encryption/decryption with official @mysten/seal package
  - Test memory operations with actual storage backends
  - Verify client extension integration works correctly

## Test Quality Assurance Workflow
**MANDATORY TESTING REQUIREMENTS**: All new components must achieve 100% test pass rate before proceeding.

### **CRITICAL: NO MOCKS ALLOWED** 🚫
- **NEVER use mocks, stubs, or spies**: All tests must use real implementations
- **NO `jest.mock()`, `jest.spyOn()`, `jest.fn()`**: Tests must interact with actual services
- **NO `mockImplementation()` or `mockReturnValue()`**: Use real function behavior
- **Real network calls**: Tests hit actual Sui testnet and Walrus storage
- **Real encryption**: Tests use actual @mysten/seal package, not mocked SEAL
- **Real console output**: Let console.warn/error appear in test output naturally
- **Exception**: Only mock external services that are truly unavailable (e.g., third-party APIs with rate limits)

**Test Refactoring Status**:
- ✅ **COMPLIANT**: `test/integration/cross-context-data-access.test.ts` (8/8 passing)
- ✅ **COMPLIANT**: `test/encryption/seal-oauth-integration.test.ts` (10/10 passing)
- ✅ **REFACTORED**: `test/services/ClassifierService.test.ts` (18/18 passing - real EmbeddingService)
- ✅ **REFACTORED**: `test/services/GeminiAIService.test.ts` (12/12 passing - real Gemini API)
- ✅ **REFACTORED**: `test/services/GraphService.test.ts` (34/34 passing - real embeddings + AI extraction)
- ✅ **REFACTORED**: `test/services/KnowledgeGraphManager.integration.test.ts` (16/16 passing - real orchestration)
- ⚠️ **PENDING**: Legacy service tests (7 files) - awaiting refactoring
- ⚠️ **PENDING**: Infrastructure tests (3 files) - awaiting refactoring

**Refactoring Priority**:
1. ✅ **DONE**: ClassifierService.test.ts - removed all mocks, 18/18 passing
2. ✅ **DONE**: GeminiAIService.test.ts - removed all mocks, 12/12 passing
3. ✅ **DONE**: GraphService.test.ts - removed all mocks, 34/34 passing with vector embeddings
4. ✅ **DONE**: KnowledgeGraphManager.integration.test.ts - created NEW file, 16/16 passing with real orchestration
5. ⚠️ **TODO**: MainWalletService.test.ts - use real SuiClient
6. ⚠️ **TODO**: ViewService.test.ts - use real blockchain queries

**CRITICAL ENFORCEMENT**: 
- ANY test file using `jest.mock()`, `jest.fn()`, `jest.spyOn()`, `mockImplementation()`, or `jest.Mocked<T>` is **NOT COMPLIANT**
- Tests must instantiate real service classes with real dependencies
- Only exception: External third-party APIs with rate limits (document why mock is needed)

### Testing Process:
1. **Create Comprehensive Tests**: Cover all public API methods, error scenarios, edge cases
2. **Use Real Data**: Integrate actual testnet object IDs and blob IDs from Suiscan account 
3. **Run After Every Edit**: Execute tests immediately after code changes to verify functionality
4. **100% Pass Rate Gate**: All tests must pass before moving to next implementation phase
5. **Codacy Analysis**: Run code quality checks on all test files after creation/modification
6. **Real Implementations Only**: Tests must use actual services, real network calls, real encryption

### Test Execution Commands:
- **Component Tests**: `npm test -- test/{component}/{ComponentName}.test.ts`
- **All Tests**: `npm test` (must show 100% pass rate)
- **Verbose Output**: Add `--verbose` flag for detailed test information
- **Real Data Validation**: Tests should use actual object IDs, not mock placeholders

### Real Data Integration Requirements:
- **User Address**: `0xc5e67f46e1b99b580da3a6cc69acf187d0c08dbe568f8f5a78959079c9d82a15`
- **Blob Objects**: Use real Walrus blob IDs from Suiscan (sizes: 12b to 445556b)
- **Object Types**: Validate against actual `0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66::blob::Blob`
- **Network Integration**: Tests should handle real network conditions, timeouts, rate limiting

## Configuration you must set
- Minimal: `{ packageId: '0x...', apiUrl: 'https://backend/api' }` when extending the client.
- SEAL/Walrus: configure through SDK config (key servers, storage provider) if encrypting or using storage helpers.
- Keep `packageId` in sync with the deployed Move package in `smart-contract/sources/*`.

## Data & storage format
- On-chain: index objects for `MainWallet` and `ContextWallet` (Move types under `memory` or new `wallet` module). SDK keeps IDs in `ViewService`.
- Off-chain: Walrus blobs for context data; tag with `context-id`, `app-id`, `encrypted=true`, `encryption-type=seal`.
- Hashing/derivation: `deriveContextId = sha3_256(userAddress + appId + salt)`; salt stored in main wallet metadata.
- Keys: Use SEAL IBE with user address identity; keep `backupKey` only client-side; never store raw keys in blobs.

## Implementation conventions
- Transactions use `Transaction` from `@mysten/sui/transactions`; set gas via `tx.setGasBudget()` or `tx.setGasPrice()` as needed.
- Codegen wrappers (e.g., `MemoryModule.createMemoryRecord`) are preferred where available; otherwise fall back to `tx.moveCall({ target: packageId + '::module::fn', ... })`.
- **Vector Indexing**: Use `HnswIndexService` (native hnswlib-node) for O(log N) vector search. Features: intelligent batching, LRU caching, Walrus persistence, metadata filtering.
- **Embeddings**: Use `EmbeddingService` (Google Gemini) for vector generation. Methods: `embedText()`, `embedBatch()`, `calculateCosineSimilarity()`, `findMostSimilar()`.
- **Advanced Search**: Use `QueryService` for complex queries. Supports: vector, semantic, keyword, hybrid, graph, temporal, and analytical search modes.
- Chat view methods in the SDK hit the backend via `apiUrl`; ensure backend is running and URL is configured.

### Official dependencies and docs policy
- **CRITICAL**: Always use official `@mysten/seal` and `@mysten/walrus` packages that are installed in the SDK
- Import actual classes: `import { SealClient, SessionKey } from '@mysten/seal'` and `import { WalrusClient } from '@mysten/walrus'`
- **NO MOCKS**: Do not add or rely on mock/stub implementations in SDK source OR tests; integrate with the real services/APIs
- **Real Implementations Only**: All tests must use actual network calls, real encryption, real storage operations
- Always use the latest stable packages from the Mysten ecosystem (`@mysten/sui`, `@mysten/seal`, `@mysten/walrus`, `@mysten/bcs`, `@mysten/codegen`, `@mysten/utils`). Prefer generated bindings over handwritten calls.
- Follow the official publisher documentation and API references when adding or updating functionality. Mirror official patterns and types; avoid hand-rolled cryptography or ad-hoc protocol changes.
- When upstream APIs change, update types and code via `npm run codegen`, align usages, and bump versions accordingly. Avoid temporary shims; fix at the integration points.

#### **Package Version-Specific Syntax (CRITICAL)**:
Use correct syntax for current package versions. Deprecated methods must be replaced:

**@mysten/sui/utils**:
- ✅ `fromHex()` - Use this (current)
- ❌ `fromHEX()` - DEPRECATED, do not use

**@mysten/bcs**:
- ✅ `bcs.struct()`, `bcs.vector()`, `bcs.u64()` - Use current BCS API patterns
- ❌ Old BCS struct patterns - Use official generated types

**@mysten/sui/transactions**:
- ✅ `Transaction` - Use this (current)
- ❌ `TransactionBlock` - DEPRECATED for new code

**@mysten/walrus**: 
- ✅ `WalrusClient.experimental_asClientExtension()` - Use client extension pattern (REQUIRED)
- ✅ Upload relay configuration: `https://upload-relay.testnet.walrus.space` with tip config
- ✅ `undici` Agent with 60-second timeouts for Node.js environments  
- ✅ `client.walrus.writeBlob()`, `client.walrus.readBlob()` - Use extended client methods
- ❌ Direct `new WalrusClient()` - Use client extension pattern only
- ❌ Custom HTTP wrappers - Use official client extension only

**@mysten/seal**:
- ✅ `SealClient.encrypt()`, `SessionKey.create()` - Use official API
- ❌ Mock SEAL implementations - Use real package only

#### Documentation sources (must use these)
- Walrus: https://docs.wal.app/
- SEAL: https://seal-docs.wal.app/
Always fetch and verify API shapes and examples from these official sites when implementing or updating storage/encryption logic.

## Permission model (cross-app)
- Source of truth: on-chain access registry (reuse `seal_access_control` or add `access` module) + mirrored policy blob in Walrus for quick reads.
- Grant semantics: subject = `contextId`, grantee = `recipientAppId`, scopes = verbs (read:list, read:item, search, export), TTL optional.
- Enforcement: `AggregationService` resolves allowed contexts via `ViewService` + `PermissionService`, then queries only permitted datasets.
- Consent UX: apps initiate `requestConsent` (backend surfaces UI). Users approve → SDK writes `grant` on-chain and cache policy blob.

## Access Control Pattern (OAuth-style App Permissions)
**App-Centric Permission Model**: Similar to Google OAuth, apps request access and users grant permissions:

### **Permission Request Flow**:
1. **App Requests Access**: Dapp calls `requestAccess(userWallet, permissions[], purpose)` 
   - Example: `["read:memories", "write:preferences"]` 
   - Purpose: "Access your memories to provide personalized recommendations"
2. **User Reviews & Approves**: User sees permission request in wallet UI and approves/denies
3. **On-Chain Grant**: Upon approval, SDK calls `grant_access()` to record permission on-chain
4. **App Uses Permissions**: App can now decrypt/access user data within granted scope

### **Permission Scopes** (like Google/OAuth):
- **`read:memories`**: Can decrypt and read user's memory data
- **`write:memories`**: Can create/modify memory entries  
- **`read:preferences`**: Can access user settings/preferences
- **`write:preferences`**: Can modify user settings
- **`read:contexts`**: Can list user's app contexts
- **`write:contexts`**: Can create new contexts for user

### **SEAL Integration**:
- **seal_approve** function validates: `appId` has been granted `requestedScope` by `walletOwner`
- **Permission Storage**: On-chain registry maps `(userAddress, appId) -> GrantedPermissions[]`
- **Time-Limited**: All permissions have expiration dates (renewable)
- **Revocable**: Users can revoke app permissions at any time

### **Implementation Components**:
- `requestConsent(appId, scopes[], purpose, expiresIn)` → creates pending consent UI
- `grantPermissions(appId, scopes[], expiresAt)` → user approves, writes on-chain
- `revokePermissions(appId, scopes[])` → user removes app access
- `checkPermission(appId, scope, userAddress)` → validates during SEAL decrypt

## Walrus usage (TESTED WORKING PATTERNS - use exactly these)
**Based on official examples**: https://github.com/MystenLabs/ts-sdks/tree/main/packages/walrus/examples

### **Required Setup for Node.js** (CRITICAL):
```typescript
// Configure network agent for reliability (from examples)
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({
  connectTimeout: 60_000,
  connect: { timeout: 60_000 }
}));
```

### **Client Creation Pattern** (REQUIRED):
```typescript
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { WalrusClient } from '@mysten/walrus';

const client = new SuiClient({
  url: getFullnodeUrl('testnet'),
  network: 'testnet',
}).$extend(
  WalrusClient.experimental_asClientExtension({
    uploadRelay: {
      host: 'https://upload-relay.testnet.walrus.space',
      sendTip: { max: 1_000 }
    },
    storageNodeClientOptions: {
      timeout: 60_000
    }
  })
);
```

### **Upload Pattern** (TESTED WORKING):
```typescript
const { blobId, blobObject } = await client.walrus.writeBlob({
  blob: content,
  deletable: true,
  epochs: 3,
  signer: keypair,
  attributes: {
    'content-type': 'application/json',
    'context-id': contextId,
    'app-id': appId,
    'encrypted': 'true',
    'encryption-type': 'seal'
  }
});
```

### **Required Dependencies**:
- `undici` - For network configuration in Node.js environments
- `@mysten/walrus` - Official Walrus SDK with client extension
- Upload relay endpoint: `https://upload-relay.testnet.walrus.space`
	- Optional: `policy-ref`, `created-at`, `updated-at`
- **Retrieval**: Use `walrusClient.readBlob()`, validate `content-hash`, and if `encrypted=true && encryption-type=seal`, delegate to SEAL decrypt before returning plaintext
- **No XOR/placeholder encryption and no production local fallback**. Use official client retries and surface errors; offline cache only for dev

## Common gotchas
- Generated files go stale when Move changes → rerun `npm run codegen` and rebuild.
- Using TransactionBlock in app code vs Transaction in SDK: import the correct type per context.
- Some tests require network/SEAL key servers; see `packages/pdw-sdk/.env.test` and `docs/SEAL_*` for setup.
- Isolation: never allow cross-app reads without explicit `AccessGrant`; validate `appId` on every context operation.
- Consistency: treat context data as eventually consistent between Sui index and Walrus; prefer idempotent writes and retry-once on reads.

## SEAL flows (standard)
- Initialize: use `@mysten/seal` with allowlisted key servers from config; verify on mainnet only.
- Session key lifecycle:
	- Create via `SessionKey.create({ address, packageId, ttlMin, suiClient })`.
	- Get personal message; require wallet signature; set via `setPersonalMessageSignature(signature)`.
	- Cache session per address with TTL; refresh when expired.
- Encryption:
	- Call `sealClient.encrypt({ threshold, packageId, id, data })` where `id` is the user address identity (hex) for IBE.
	- Persist only the encrypted object; keep `backupKey` client-side; never store raw keys in Walrus.
- Approval intent:
	- Build Move tx using generated bindings from `src/generated/pdw/seal_access_control` (avoid hardcoded module strings) for approve/consent flows (e.g., `seal_approve`).
	- Use tx bytes from this intent when calling `decrypt`.
- Decryption:
	- Call `sealClient.decrypt({ data: encryptedObject, sessionKey, txBytes })` after user’s session key + approval tx.
- Key rotation:
	- Expose `pdw.wallet.rotateKeys(userAddress)` to mint a new session key and rotate backup key; do not write raw keys to chain or Walrus.

## Security model (quick triage)
- Threats: unauthorized cross-app reads, linkability of contexts, key exfiltration, blob tampering.
- Mitigations: IBE per user, deterministic but salted context IDs, on-chain policy checks, Walrus tags + content-hash verification, audit events.
- Privacy: expose only scoped fields via `AggregationService`; support redaction and per-scope filters.

Questions for follow-up
- Confirm canonical client-extension import: prefer `SuiClient().$extend(PersonalDataWallet)` vs `.$extend(PersonalDataWallet.asClientExtension(cfg))` across apps.
- List any additional required config keys (e.g., default key servers, Walrus endpoints) to pin in this guide.
