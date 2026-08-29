---
"@mysten-incubation/memwal": patch
---

Add `listNamespaces()` so an agent can discover which namespaces an account holds memories in (#634).

Recall is similarity-ranked and needs a namespace to search. Without this, an agent connecting to an unfamiliar account had to guess names or fall back to `"default"`, which undercuts cross-session memory portability.

`listNamespaces({ cursor?, limit? })` returns `{ namespaces, next_cursor, has_more, snapshot_version }` over the relayer's existing `GET /v1/owners/{owner}/namespaces`. Each entry carries `id`, `name`, `memory_count`, `storage_used` and `updated_at`. Metadata only — no blob fetch, no decryption, and no SEAL session is built or transmitted.

Paginate on `has_more`, not on page length: the relayer clamps `limit`, so a caller asking for more than the cap gets exactly the cap back and would wrongly conclude it was done.

The owner-scoped read routes take the address in the path and reject a mismatch, but `MemWalConfig` carries only the delegate key and account id — so the client resolves its own owner address once, memoised, and callers never supply it.

`MemWalMock` implements the same method, aggregating seeded memories by namespace with deterministic timestamps derived from insertion order.
