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

These three endpoints run on their own router (`read_api_routes` in
`main.rs`), separate from the write path's `protected_routes`, behind
`read_api_rate_limit_middleware` (`services/server/src/rate_limit.rs`)
instead of the write path's `rate_limit_middleware`. They do **not** share
the write path's budget — a routine pagination loop over this API can no
longer trip, or contend with, the 30/min per-delegate-key budget that
exists to bound the write path's spend-risk (Walrus upload, LLM calls,
gas).

There is a single sliding-window layer, keyed by delegate key under its
own Redis prefix (`rate:read:dk:{public_key}`, distinct from the write
path's `rate:dk:{public_key}`) — no separate per-account burst/sustained
tiers on top. Default limit is **200 weighted-requests/min per delegate
key** (`ReadApiRateLimitConfig::per_delegate_key_per_minute`), overridable
via the `READ_API_RATE_LIMIT_PER_MINUTE` env var. Weights for this API:

| Endpoint | Weight | Why |
|---|---|---|
| `GET /v1/owners/{owner}/namespaces` | 1 | DB read only |
| `GET /v1/owners/{owner}/memories` | 1 | DB read only |
| `GET /v1/owners/{owner}/agents` | 2 | Makes a live on-chain `sui_getObject` RPC call (short-TTL cached, but uncached on a cold/expired cache entry) |

Exceeding the limit returns `429 Too Many Requests`:

```json
{
  "error": "Rate limit exceeded",
  "layer": "read_delegate_key",
  "limit": "200 weighted-requests/min",
  "retry_after_seconds": 60
}
```

with a `Retry-After: 60` header. If the rate limiter itself is
unavailable (Redis unreachable), requests fail closed with `503 Service
Unavailable` and a `Retry-After: 30` header rather than being allowed
through unmetered — there is no in-memory fallback for this middleware,
unlike the write path's deliberately-fallback-enabled limiter.

## GET /v1/owners/{owner}/namespaces?updated_after=<cursor>&limit=100

`updated_after` — like `memories`' below — must be the opaque `next_cursor`
value returned by a previous call, not a raw timestamp or namespace name;
omit it for the first page. It base64 (URL-safe, unpadded) encodes the
last-seen namespace name, used as a keyset pagination cursor (`namespace`
has no separate id column to tie-break on the way `memories` uses
`(updated_at, id)`). `limit` defaults to 100, max 500, `400` for
non-positive/non-integer values — same convention as `memories`.

Note: `updated_after` in this endpoint is a pure pagination continuation
token, not an independent "namespaces touched since this timestamp" filter
— it does not narrow results to recently-changed namespaces the way the
name might suggest. See the design spec for the open gap this simplifies.

Response:
```json
{
  "namespaces": [
    { "id": "work", "name": "work", "memory_count": 12, "storage_used": 48213 }
  ],
  "next_cursor": "d29yaw",
  "snapshot_version": 1
}
```

`next_cursor` is `null` once the last page has been returned.

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
      "status": "active",
      "end_epoch": 900,
      "expires_at": "2026-09-15T00:00:00Z"
    }
  ],
  "next_cursor": "eyJ1cGRhdGVkX2F0IjouLi59",
  "snapshot_version": 1
}
```

`status` is `"expired"` if `expires_at` is in the past, `"active"`
otherwise — including when `end_epoch`/`expires_at` are still `null` (not
yet synced; a background sweep populates them within roughly 5 minutes of
a memory being written, sooner for the primary upload path).

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
  "snapshot_version": 1
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
