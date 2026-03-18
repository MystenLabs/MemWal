# Relayer API Reference

The current Rust server exposes these routes in `services/server/src/main.rs`.

## Public Route

### `GET /health`

Returns:

```json
{
  "status": "ok",
  "version": "..."
}
```

## Protected Memory Routes

### `POST /api/remember`

Store text as memory for the authenticated owner and namespace.

Request body:

```json
{
  "text": "User prefers dark mode",
  "namespace": "demo"
}
```

### `POST /api/recall`

Recall similar memories and return plaintext results.

Request body:

```json
{
  "query": "What do we know about this user?",
  "limit": 10,
  "namespace": "demo"
}
```

### `POST /api/remember/manual`

Register an encrypted payload plus precomputed vector.
In the current backend contract, this route expects `encrypted_data`, not a pre-existing `blob_id`.

### `POST /api/recall/manual`

Search with a precomputed vector and receive `{ blob_id, distance }` hits back.

### `POST /api/analyze`

Extract memorable facts from text and store them as memories.

### `POST /api/ask`

Recall memories, inject them into an LLM prompt, and return an answer.

### `POST /api/restore`

Incrementally restore missing vector entries for an owner and namespace by discovering blobs
from chain metadata, downloading them, decrypting them, and re-indexing them.

Request body:

```json
{
  "namespace": "demo",
  "limit": 50
}
```

## Signed Request Headers

The SDK signs requests and sends headers such as:

- `x-public-key`
- `x-signature`
- `x-timestamp`

The current default SDK client also sends `x-delegate-key` for flows that may require
delegate-key-backed decrypt or restore behavior on the backend.
