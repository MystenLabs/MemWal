---
"@mysten-incubation/memwal": patch
---

Add memory deletion + listing to the SDK: `clearNamespace(namespace)`, `forget(id)`, and `list(namespace, { limit, cursor })`.

- `clearNamespace` soft-deletes every memory in a namespace so it stops surfacing in `recall()` — the reset primitive for iteration/dev loops (replaces namespace rotation).
- `forget` soft-deletes a single memory by the `id` returned from `list()` (per-memory; identical-text memories stored separately are unaffected).
- `list` enumerates a namespace as metadata only (id, blob_id, created_at, importance — no decrypted text), cursor-paginated via `has_more` / `next_cursor`.

Soft-delete clears *retrievability*, not the underlying Walrus blob (user-owned, persists until on-chain deletion / storage-epoch expiry). All owner-scoped.
