# Memory Read API (WALM-295)

Owner-scoped, cursor-based, read-only. All three endpoints require the
same signature-verified auth `/api/restore` uses; the `{owner}` path
segment must equal the authenticated identity or the request is rejected
with 403.

## GET /v1/owners/{owner}/namespaces

Response:
```json
{
  "namespaces": [
    { "id": "work", "name": "work", "memory_count": 12, "storage_used": 48213 }
  ],
  "snapshot_version": 1
}
```

## GET /v1/owners/{owner}/memories?updated_after=<cursor>&limit=100

`updated_after` must be the opaque `next_cursor` value returned by a
previous call, not a raw timestamp. `limit` defaults to 100, max 500.

Response:
```json
{
  "memories": [
    {
      "memory_id": "abc123",
      "namespace_id": "work",
      "blob_id": "blob-xyz",
      "created_at": "2026-08-04T10:00:00Z",
      "size": 2048,
      "agent_id": "agent-abc",
      "package_id": "0xpkg",
      "status": "active"
    }
  ],
  "next_cursor": "eyJ1cGRhdGVkX2F0IjouLi59",
  "snapshot_version": 1
}
```

`end_epoch`/`expires_at` fields are added by WALM-296 (see that plan) —
not present yet in this Phase 1 response.

## GET /v1/owners/{owner}/agents

Response:
```json
{
  "agents": [
    { "label": "cli", "sui_address": "0xdelegate1" }
  ],
  "snapshot_version": 1
}
```

## Errors

All errors: `{ "error": "<message>" }`. `403` on owner/path mismatch,
`400` on invalid cursor or limit, `500` on internal/on-chain failure.
