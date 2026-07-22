---
title: "API Reference"
---

The Rust relayer exposes these routes. Routes are defined in `services/server/src/main.rs`.

See also:

- [Environment Variables](/reference/environment-variables)
- [Configuration](/reference/configuration)
- [Versioning and Compatibility](/relayer/versioning-and-compatibility)

## Authentication

All `/api/*` routes require signed headers. The SDK handles this automatically.

### Required Headers

| Header | Description |
|--------|-------------|
| `x-public-key` | Hex-encoded Ed25519 public key (32 bytes) |
| `x-signature` | Hex-encoded Ed25519 signature (64 bytes) |
| `x-timestamp` | Unix timestamp in seconds (5-minute validity window) |
| `x-nonce` | UUID v4 nonce. The relayer records it in Redis for replay protection |

### Optional Headers

| Header | Description |
|--------|-------------|
| `x-account-id` | MemWalAccount object ID hint. Official SDKs always send it and include it in the canonical signature |
| `x-seal-session` | Base64 exported SEAL SessionKey for relayer-managed decrypt flows. Used by the TypeScript and Python SDKs |
| `x-delegate-key` | Legacy delegate private key credential for relayer-managed decrypt flows. Deprecated; use `x-seal-session` where supported |

### Signature Format

The signed message is:

```text
{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}
```

For `GET` requests, `body_sha256` is the SHA-256 of an empty byte string. If a raw client omits `x-account-id`, it must sign the empty string in the final `account_id` position. Official SDKs send `x-account-id`.

The relayer verifies the Ed25519 signature, then resolves the owner by looking up the public key in onchain `MemWalAccount.delegate_keys`.

## Public Routes

### `GET /health`

Service health check. No authentication required.

**Response:**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "relayerVersion": "0.1.0",
  "apiVersion": "1.0.0",
  "minSupportedSdk": {
    "typescript": "0.0.4",
    "python": "0.1.0",
    "mcp": "0.0.1"
  },
  "featureFlags": {
    "auth.accountBoundNonce": true,
    "auth.sealSessionHeader": true,
    "runtime.versionEndpoint": true
  },
  "deprecations": [],
  "build": {},
  "mode": "production",
  "prompt_versions": {
    "extract": "extract.v1",
    "ask": "ask.v1"
  }
}
```

### `GET /version`

Stable relayer/API compatibility metadata. No authentication required.

**Response:** the compatibility object documented in [Versioning and Compatibility](/relayer/versioning-and-compatibility#runtime-metadata).

### `POST /sponsor`

Proxy to the SEAL/Walrus sidecar's `/sponsor` endpoint for sponsored transactions. No authentication required.

### `POST /sponsor/execute`

Proxy to the sidecar's `/sponsor/execute` endpoint. No authentication required.

## Protected Routes

### `POST /api/remember`

Submit text as an encrypted memory job. The relayer returns after creating a background job; embedding, SEAL encryption, Walrus upload, and vector indexing continue asynchronously.

**Request:**

```json
{
  "text": "User prefers dark mode",
  "namespace": "demo"
}
```

`namespace` defaults to `"default"` if omitted.

**Response:** `202 Accepted`

```json
{
  "job_id": "uuid",
  "status": "running"
}
```

### `GET /api/remember/:job_id`

Poll a remember job.

**Response:**

```json
{
  "job_id": "uuid",
  "status": "done",
  "owner": "0x...",
  "namespace": "demo",
  "blob_id": "walrus-blob-id"
}
```

### `POST /api/remember/bulk`

Submit up to 20 memories in one request. `job_ids[i]` corresponds to `items[i]`.

**Request:**

```json
{
  "items": [
    { "text": "User prefers dark mode", "namespace": "demo" },
    { "text": "User works in TypeScript", "namespace": "demo" }
  ]
}
```

**Response:** `202 Accepted`

```json
{
  "job_ids": ["uuid-1", "uuid-2"],
  "total": 2,
  "status": "running"
}
```

### `POST /api/remember/bulk/status`

Poll a batch of remember jobs.

**Request:**

```json
{
  "job_ids": ["uuid-1", "uuid-2"]
}
```

**Response:**

```json
{
  "results": [
    { "job_id": "uuid-1", "status": "done", "blob_id": "walrus-blob-id" },
    { "job_id": "uuid-2", "status": "running" }
  ]
}
```

### `POST /api/recall`

Search for memories matching a natural language query. Returns decrypted plaintext results.

**Request:**

```json
{
  "query": "What do we know about this user?",
  "limit": 10,
  "namespace": "demo"
}
```

`limit` defaults to `10`. `namespace` defaults to `"default"`.

**Response:**

```json
{
  "results": [
    {
      "blob_id": "walrus-blob-id",
      "text": "User prefers dark mode",
      "distance": 0.15
    }
  ],
  "total": 1
}
```

### `POST /api/remember/manual`

Register a client-encrypted payload. The client sends SEAL-encrypted data (base64) and a precomputed embedding vector. The relayer uploads the encrypted bytes to Walrus and stores the vector mapping.

**Request:**

```json
{
  "encrypted_data": "base64-encoded-seal-encrypted-bytes",
  "vector": [0.01, -0.02, ...],
  "namespace": "demo"
}
```

**Response:**

```json
{
  "id": "uuid",
  "blob_id": "walrus-blob-id",
  "owner": "0x...",
  "namespace": "demo"
}
```

### `POST /api/recall/manual`

Search with a precomputed query vector. Returns blob IDs and distances only — the client handles downloading and decrypting.

**Request:**

```json
{
  "vector": [0.01, -0.02, ...],
  "limit": 10,
  "namespace": "demo"
}
```

**Response:**

```json
{
  "results": [
    {
      "blob_id": "walrus-blob-id",
      "distance": 0.15
    }
  ],
  "total": 1
}
```

### `POST /api/analyze`

Extract facts from text using an LLM, then enqueue each fact as a separate memory job.

**Request:**

```json
{
  "text": "I live in Hanoi and prefer dark mode.",
  "namespace": "demo"
}
```

**Response:** `202 Accepted`

```json
{
  "job_ids": ["uuid-1", "uuid-2"],
  "facts": [
    { "text": "User lives in Hanoi", "id": "uuid-1", "job_id": "uuid-1" },
    { "text": "User prefers dark mode", "id": "uuid-2", "job_id": "uuid-2" }
  ],
  "fact_count": 2,
  "status": "pending",
  "owner": "0x..."
}
```

### `POST /api/ask`

Recall memories, inject them into an LLM prompt, and return an AI-generated answer with the context used.

**Request:**

```json
{
  "question": "What do you know about my preferences?",
  "limit": 5,
  "namespace": "demo"
}
```

`limit` defaults to `5`. `namespace` defaults to `"default"`.

**Response:**

```json
{
  "answer": "Based on your memories, you prefer dark mode and live in Hanoi.",
  "memories_used": 2,
  "memories": [
    {
      "blob_id": "walrus-blob-id",
      "text": "User prefers dark mode",
      "distance": 0.12
    }
  ]
}
```

### `POST /api/restore`

Rebuild missing vector entries for one namespace. Queries onchain blobs by owner and namespace, downloads from Walrus, decrypts, re-embeds, and re-indexes only the entries missing from the local database.

**Request:**

```json
{
  "namespace": "demo",
  "limit": 10
}
```

`limit` defaults to `10`.

**Response:**

```json
{
  "restored": 3,
  "skipped": 7,
  "total": 10,
  "namespace": "demo",
  "owner": "0x..."
}
```

### `POST /api/clear-namespace`

Soft-delete every memory in one namespace. The memories immediately stop appearing in `recall`; the underlying Walrus blobs are user-owned and persist (this clears retrievability, not the blob). Owner-scoped.

**Request:**

```json
{
  "namespace": "demo"
}
```

**Response:**

```json
{
  "cleared": 12,
  "namespace": "demo",
  "owner": "0x..."
}
```

`cleared` is the number of memories newly soft-deleted; `0` is a safe no-op (already empty/cleared).

### `POST /api/list`

Enumerate the live memories in one namespace, newest first. Metadata only — no decrypted text — so it is cheap to call for auditing. Each item's `id` is the handle for `/api/memories/forget`. Owner-scoped; soft-deleted memories are omitted.

**Request:**

```json
{
  "namespace": "demo",
  "limit": 50,
  "cursor": "<next_cursor from a previous response, omit for the first page>"
}
```

`limit` defaults to `50` (clamped to 1–500). Omit `cursor` for the first page.

**Response:**

```json
{
  "memories": [
    {
      "id": "uuid",
      "blob_id": "walrus-blob-id",
      "created_at": "2026-06-18T12:00:00+00:00",
      "importance": 0.5
    }
  ],
  "returned": 1,
  "has_more": false,
  "namespace": "demo",
  "owner": "0x..."
}
```

`returned` is this page's size (not the namespace total). When `has_more` is `true`, the response also includes a `next_cursor`; pass it back as `cursor` to fetch the next page.

### `POST /api/memories/forget`

Soft-delete a single memory by its `id` (from `/api/list`). The memory stops appearing in `recall`; an identical-text memory stored separately is unaffected (deletion is per-memory). Owner-scoped.

**Request:**

```json
{
  "id": "uuid"
}
```

**Response:**

```json
{
  "forgotten": 1,
  "id": "uuid",
  "owner": "0x..."
}
```

`forgotten` is `1` on success, `0` if the id was not found, is not the caller's, or was already forgotten (all safe no-ops).
