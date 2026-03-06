# MemWal V2 — Implementation Tasks

> **Deadline:** March 12, 2025
> **Approach:** Build with regular server first (mock TEE), migrate to Nautilus TEE later
> **Architecture:** Ed25519 keypair auth, server-side processing, embedding-based vector search

---

## Phase 1: Smart Contract + Server Foundation (Day 1–2)

### Smart Contract (Sui Move)
- [x] Create `MemWalAccount` struct with `owner`, `delegate_keys`, `created_at`
- [x] Create `DelegateKey` struct with `public_key`, `label`, `created_at`
- [x] Entry function: `create_account(ctx)` → creates MemWalAccount
- [x] Entry function: `add_delegate_key(account, public_key, label)`
- [x] Entry function: `remove_delegate_key(account, public_key)`
- [x] View function: `is_delegate(account, public_key) → bool`
- [x] Deploy to testnet (package: `0x93c775e573c0d9aefc0908cc9bb5b0952e131ab6c40b2b769c8b74bb991d34a0`)
- [x] Write basic tests (8 tests passing)

### Server (Rust/Axum — regular server, mock TEE)
- [x] Project setup: `packages/v2-server/` with Rust + Axum
- [x] API endpoint: `POST /api/remember` — receives {text, owner} + signed request → encrypt → Walrus → store
- [x] API endpoint: `POST /api/recall` — receives {query, owner} + signed request → search → download → decrypt → plaintext
- [x] API endpoint: `POST /api/embed` — stub (mock vector, real OpenAI when key provided)
- [x] Ed25519 signature verification middleware (ed25519-dalek)
- [x] Onchain verification: check publicKey ∈ MemWalAccount.delegate_keys (via Sui JSON-RPC + reqwest)

### Vector DB (SQLite via rusqlite)
- [x] Setup rusqlite (bundled SQLite)
- [x] Schema: `vector_entries { id, owner, blob_id, vector(BLOB), enc_key(BLOB), created_at }`
- [x] Insert vectors (f32 → little-endian bytes)
- [x] Cosine similarity search (top-K, owner-scoped)

> ✅ **Phase 1 E2E tested**: `server-e2e.ts` — full flow against running Rust server with real Sui + Walrus testnet

---

## Phase 2: SDK + Embedding + SEAL (Day 3–4)

### Rewrite SDK (`packages/v2/`)
- [x] Rewrite `types.ts` — Ed25519 key config, server API response types
- [x] Rewrite `memwal.ts` — `MemWal.create({ privateKey, owner })` with Ed25519 signing
- [x] `remember(text)` — sign request + send to server
- [x] `recall(query)` — sign request + send to server
- [x] `embed(text)` — sign request + send to server
- [x] HTTP client with Ed25519 signed requests
- [x] Remove old services: `classifier.ts`, `storage.ts`, `search.ts` (logic moved to server)

### Embedding Pipeline (server-side)
- [x] Call OpenAI embedding API (`text-embedding-3-small`) via OpenRouter
- [x] Store vector + blobId in Vector DB
- [x] Similarity search endpoint

### SEAL Integration (server-side)
- [x] AES-256-GCM encrypt content before Walrus upload (`aes-gcm` crate)
- [x] AES-256-GCM decrypt content for search results
- [x] Key managed by TEE server (stored in Vector DB per entry)

### Walrus Integration (server-side)
- [x] Upload encrypted blob → Walrus Publisher HTTP API → get blobId
- [x] Extract Sui object ID of Blob from publisher response
- [x] Transfer Walrus Blob object → user's address (via `send_object_to` Publisher API param)
- [x] Download blob by blobId from Walrus Aggregator HTTP API
- [x] Store blobId reference in Vector DB

> ✅ **Phase 2 E2E tested**: Real semantic embeddings (OpenRouter), AES encryption, Walrus upload/download, cosine search

---

## Phase 3: AI Middleware + Web App (Day 5–6)

### Rewrite withMemWal Middleware
- [x] Update `middleware.ts` — use Ed25519 key config
- [x] `WithMemWalOptions` → `{ key, maxMemories, autoSave, minRelevance }`
- [x] BEFORE: sign query → server recall → inject memories into prompt
- [x] AFTER: auto-save user message as memory (fire-and-forget)
- [x] Update `examples/usage.ts`

### AI Analyzer (server-side)
- [x] LLM-based fact extraction (`/api/analyze` route, `gpt-4o-mini`)
- [x] Filter: LLM returns NONE if no memorable facts
- [x] Extract structured facts → embed + encrypt + Walrus upload + store each
- [x] SDK `analyze()` method added

### Web App MVP
- [x] `packages/v2-app/` — Vite + React + TypeScript
- [x] Enoki zkLogin integration (Google OAuth via `@mysten/enoki` + `@mysten/dapp-kit`)
- [x] Fallback: standard Sui wallet connect when Enoki keys not configured
- [x] Create MemWalAccount onchain (via `useSignAndExecuteTransaction`)
- [x] Generate Ed25519 keypair (`@noble/ed25519`)
- [x] Display private key once to user (copy + confirm flow)
- [x] Add delegate key onchain (`add_delegate_key` Move call)
- [x] Dashboard: account info, delegate key management, SDK code snippets

---

## Phase 4: E2E Demo + Docs (Day 7)

### End-to-End Demo
- [ ] Demo script: signup → get key → SDK remember → SDK recall → AI response with context
- [ ] Verify: data encrypted, stored on Walrus, searchable via embeddings

### Documentation
- [ ] README.md — setup guide, quick start
- [ ] API reference: MemWal.create, remember, recall, embed
- [ ] Architecture overview with diagrams

---

## Post-MVP (After March 12)
- [ ] Migrate server to Nautilus TEE
- [ ] LangChain / OpenAI SDK integrations
- [ ] Key rotation mechanism
- [ ] Rate limiting per delegate key
- [ ] Memory management dashboard
- [ ] `memwal.decrypt(blobId)` — offline self-decrypt
