---
title: "API Reference"
---

The current Rust server exposes these routes from `services/server/src/main.rs`.

See also:

- [Environment Variables](/reference/environment-variables)
- [Configuration](/reference/configuration)

## Public

### `GET /health`

- Use for a simple service check

Example response:

```json
{
  "status": "ok",
  "version": "..."
}
```

## Protected

### `POST /api/remember`

- Store text for the authenticated owner and namespace

```json
{
  "text": "User prefers dark mode",
  "namespace": "demo"
}
```

### `POST /api/recall`

- Search and return plaintext results

```json
{
  "query": "What do we know about this user?",
  "limit": 10,
  "namespace": "demo"
}
```

### `POST /api/remember/manual`

- Register encrypted payload plus precomputed vector
- Current backend expects `encrypted_data`, not a pre-existing `blob_id`

### `POST /api/recall/manual`

- Search with a precomputed vector
- Returns `{ blob_id, distance }` hits

### `POST /api/analyze`

- Extract facts from text and store them as memories

### `POST /api/ask`

- Recall memories, inject them into an LLM prompt, and return an answer

### `POST /api/restore`

- Rebuild missing vector entries for one owner and namespace
- Uses chain metadata plus blob discovery

```json
{
  "namespace": "demo",
  "limit": 50
}
```

## Signed Headers

The SDK signs requests and sends headers such as:

- `x-public-key`
- `x-signature`
- `x-timestamp`

The default SDK also sends `x-delegate-key` for backend flows that may require delegate-key-backed
decrypt or restore behavior.
