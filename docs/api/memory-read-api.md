# Memory Read API (WALM-295)

Owner-scoped, cursor-based, read-only. All three endpoints require the
same signature-verified auth `/api/restore` uses; the `{owner}` path
segment must equal the authenticated identity or the request is rejected
with 403.

> This document covers response shapes, auth mechanics, and error/rate-limit
> behavior for the three endpoints below. A formal OpenAPI/JSON-Schema spec
> is a follow-up, not included in this pass.

## Authentication

Every request must carry an Ed25519-signed set of headers — the same
`verify_signature` middleware `/api/restore` and every other protected route
use (`services/server/src/auth.rs`). There is no separate token model for
this API (see the design spec's open question about a future owner-scoped
token ticket).

### Required headers

| Header | Description |
|---|---|
| `x-public-key` | Hex-encoded Ed25519 public key (32 bytes) |
| `x-signature` | Hex-encoded Ed25519 signature (64 bytes) over the canonical message below |
| `x-timestamp` | Unix timestamp in seconds. Must be within ±300s (5 minutes) of server time |
| `x-nonce` | UUID v4, used once for replay protection (tracked in Redis for 10 minutes) |
| `x-account-id` | Walrus Memory account object ID. Effectively required: it is signed into the canonical message, so omitting it signs an empty string and will not match a real account on testnet |

### Canonical signing string

The client signs (Ed25519) the following pipe-free, dot-joined string and
sends the signature in `x-signature`:

```
{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}
```

- `timestamp` — the exact value sent in `x-timestamp`.
- `method` — HTTP method, e.g. `GET`.
- `path_and_query` — the request's path plus query string exactly as sent,
  e.g. `/v1/owners/0xabc.../memories?limit=50`. Mismatched query params
  (including a tampered `updated_after` cursor) invalidate the signature.
- `body_sha256` — hex-encoded SHA-256 of the request body. For these
  GET-only, bodyless endpoints this is the hash of an empty byte string.
- `nonce` — the `x-nonce` value.
- `account_id` — the `x-account-id` value (empty string if omitted, which
  will not match a real signed request).

Server-side verification flow (`auth.rs::verify_signature`): validate the
Ed25519 signature against the canonical string → check the nonce hasn't
been seen before (Redis, fail-closed on Redis outage) → resolve the account
(cache, then the `x-account-id` hint, then a bounded on-chain registry scan
as a last resort) → verify the public key is a registered delegate key on
that account's on-chain `MemWalAccount.delegate_keys` (cached in
`delegate_key_cache`, revoked entries evicted).

### 401 responses

Any of the following returns a bare `401 Unauthorized` (no JSON body,
constant ~100ms delay on signature/timestamp/nonce failures to prevent
timing side-channels distinguishing failure reasons):

- Missing/malformed `x-public-key`, `x-signature`, or `x-timestamp`.
- `x-timestamp` outside the ±300s window.
- Ed25519 signature verification failure (including a tampered path, query
  string, or body).
- Nonce already seen (replay) — or the Redis nonce check itself failing
  (fail-closed).
- Public key not found among the resolved account's on-chain delegate keys,
  or the account is deactivated.

A request missing `x-nonce` entirely gets `426 Upgrade Required` instead of
`401` — signaling an unsupported legacy SDK version rather than an auth
failure.

Once authenticated, the three endpoints below additionally return `403`
if the `{owner}` path segment does not equal the resolved `auth.owner`.

## Rate limiting

Requests are weighted and checked against three sliding-window layers
(`services/server/src/rate_limit.rs`): per-delegate-key (30 weighted-req/min),
per-account burst (60 weighted-req/min), per-account sustained
(500 weighted-req/hour). Weights for this API:

| Endpoint | Weight | Why |
|---|---|---|
| `GET /v1/owners/{owner}/namespaces` | 1 | DB read only |
| `GET /v1/owners/{owner}/memories` | 1 | DB read only |
| `GET /v1/owners/{owner}/agents` | 2 | Makes a live on-chain `sui_getObject` RPC call (short-TTL cached, but uncached on a cold/expired cache entry) |

Exceeding any layer returns `429 Too Many Requests`:

```json
{
  "error": "Rate limit exceeded",
  "layer": "per-account-burst",
  "limit": "60 weighted-requests/min",
  "retry_after_seconds": 12
}
```

with a `Retry-After` header (seconds) set to match `retry_after_seconds`.
If the rate limiter itself is unavailable (Redis unreachable and the
in-memory fallback can't be used), requests fail closed with `503 Service
Unavailable` and a `Retry-After: 30` header rather than being allowed
through unmetered.

## GET /v1/owners/{owner}/namespaces?updated_after=<cursor>&limit=100

`updated_after` — like `memories`' below — must be the opaque `next_cursor`
value returned by a previous call, not a raw timestamp or namespace name;
omit it for the first page. It base64 (URL-safe, unpadded) encodes the
JSON watermark `{"updated_at": ..., "namespace": ...}`: rows are ordered
and filtered by the rollup's `(MAX(updated_at), namespace)`, mirroring
`memories`' `(updated_at, id)` keyset. `limit` defaults to 100, max 500,
`400` for non-positive/non-integer values — same convention as `memories`.

**Breaking change from an earlier version of this endpoint:** namespaces
are now returned ordered by recency (`(MAX(updated_at), namespace)`), not
alphabetically by name. A client that wants an alphabetical list needs to
buffer and sort every page itself rather than relying on response order.

Because the cursor is a recency watermark rather than a name, it is a real
incremental-sync token: a namespace you already synced comes back on the
next poll if any of its memories were **created or updated** after that
watermark, however early its name sorts. Namespaces untouched since the
watermark are not re-sent.

**Deletions are reflected via soft delete.** Forgetting a memory
(`POST /api/forget`) or the reactive Walrus-404 cleanup no longer removes
the row outright — it stamps `deleted_at` and bumps `updated_at` like any
other change. That means: the namespace's `updated_at` watermark still
advances on a deletion, so a namespace whose only change since your last
sync was a deletion **is** resurfaced by `updated_after` — but
`memory_count`/`storage_used` exclude deleted memories, so the rollup you
see reflects only what's still live. The individual deleted memory itself
also resurfaces in `GET /v1/owners/{owner}/memories` with
`status: "deleted"` (see below) — that is your positive signal to drop it
from your local index, rather than the row simply disappearing.

Response:
```json
{
  "namespaces": [
    {
      "id": "work",
      "name": "work",
      "memory_count": 12,
      "storage_used": 48213,
      "updated_at": "2026-08-04T10:00:00Z"
    }
  ],
  "next_cursor": "eyJ1cGRhdGVkX2F0IjouLi4sIm5hbWVzcGFjZSI6IndvcmsifQ",
  "has_more": false,
  "snapshot_version": 2
}
```

`updated_at` is `MAX(updated_at)` across the namespace's memories — the same
value the cursor is built from.

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
      "updated_at": "2026-08-04T11:30:00Z",
      "size": 2048,
      "agent_id": "agent-abc",
      "package_id": "0xpkg",
      "status": "active"
    }
  ],
  "next_cursor": "eyJ1cGRhdGVkX2F0IjouLi59",
  "has_more": false,
  "snapshot_version": 2
}
```

`updated_at` is the row's own last-modified time — the same value this
page's cursor is built from.

`status` is `"deleted"` if the memory was forgotten (or its blob was
reactively cleaned up after a Walrus 404) — treat this as a tombstone and
remove the memory from your local index. Otherwise `"active"` for Phase 1.
(`end_epoch`/`expires_at` fields, and the `active`/`expired` split, are
added by WALM-296 — see that plan — and are not present yet in this
Phase 1 response.)

### Cursor semantics (both paginated endpoints)

`next_cursor` is **always** returned for a non-empty page — including the
final page of a traversal and a result that fits entirely in one page. It
is the watermark of the last row in that page, and it is what you pass as
`updated_after` on your next poll. It is `null` only for an empty page,
which has no row to take a watermark from; in that case keep the cursor you
already had.

So `next_cursor: null` does **not** mean "end of data" — use the separate
`has_more` boolean for that instead. Keep paginating (pass back the latest
`next_cursor`) while `has_more` is `true`; stop once you see `has_more:
false`.

**Do not infer end-of-data from page length.** `limit` is silently clamped
to each endpoint's max (500) — a request for `limit=1000` that happens to
match exactly 500 real rows returns a page exactly as long as the (clamped)
`limit`, and a request for more than the actual remaining data returns a
page shorter than `limit` while more data still exists elsewhere for that
owner. `has_more` is correct in both cases; page-length heuristics are not.

### `snapshot_version` and full reconciliation

`snapshot_version` is a small integer describing the *wire contract* these
endpoints currently speak — the cursor's binary/JSON format and the set of
fields on each item. It is not per-account or per-sync state; it changes
only when we ship a breaking contract change (e.g. `1 -> 2` here, when the
`/namespaces` cursor changed from a bare name to a `(updated_at,
namespace)` watermark and both endpoints gained `updated_at`/`has_more`).

**Client contract:** store the `snapshot_version` you last saw alongside
your cursor. On every response, compare it to the stored value:

- **Unchanged** — your stored cursor is still valid; keep polling with it
  as normal.
- **Different (including "you have none stored yet")** — treat your
  existing cursor as unusable. Discard it, perform one full (cursor-less)
  sync of everything from the start, and store the new `snapshot_version`
  alongside the fresh cursor you get back.

You do not need to inspect the value itself (e.g. detect "did it go up or
down") — any difference from what you have stored means "do a full
resync," full stop.

**In practice, a version bump is self-enforcing for cursors specifically:**
a cursor encoded under an old contract version is not valid JSON/shape
under the new one and is rejected with `400 { "error": "invalid cursor" }`
rather than silently mis-decoded — see `decode_namespaces_cursor`'s
rejection of a pre-`snapshot_version: 2` bare-name cursor
(`encode_namespaces_cursor_is_url_safe_and_round_trips` in
`memory_read.rs`'s test module). Comparing `snapshot_version` remains the
right thing to do regardless, since not every contract change necessarily
breaks cursor decoding (e.g. a version bump purely for a new response
field would decode an old cursor just fine while still meaning "your
locally cached item shapes are stale").

## GET /v1/owners/{owner}/agents

Live on-chain read of `MemWalAccount.delegate_keys`, short-TTL cached
per-account (same 30s window `sui/client.rs::walrus_epoch()` uses) so
repeated calls within the TTL window don't re-hit the chain.

Response:
```json
{
  "agents": [
    { "label": "cli", "sui_address": "0xdelegate1" }
  ],
  "snapshot_version": 2
}
```

## Errors

All errors from these three endpoints (except the shared auth middleware's
bare `401`/`426`, and the shared rate limiter's `429`/`503` — see
Authentication and Rate limiting above) use the envelope
`{ "error": "<message>" }`:

| Status | Cause |
|---|---|
| `401` | Auth failed (see Authentication) |
| `403` | `{owner}` path segment does not match the authenticated identity |
| `400` | Invalid/malformed cursor, or non-positive/non-integer `limit` |
| `429` | Rate limit exceeded (see Rate limiting) |
| `500` | Internal error, including an on-chain RPC failure on `/agents` |

An empty list (owner with no memories/namespaces, or no delegate keys) is
a valid `200`, not a `404`.
