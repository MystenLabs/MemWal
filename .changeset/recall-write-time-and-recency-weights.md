---
"@mysten-incubation/memwal": patch
---

Expose each memory's write-time on `recall()`, and let callers ask for a newest-first ordering (#621).

`RecallMemory` now carries `created_at` (RFC3339, the time the fact was stored). `RecallOptions` accepts `sort: "relevance" | "recent"`, and `scoringWeights` — which the relayer's composite ranker has always supported but which only the manual bring-your-own-embedding paths could reach.

`created_at` is the piece a "newest wins" protocol was missing: previously the only date available was whatever the memory text happened to mention, so callers could neither order nor verify by write-time.

`sort: "recent"` is the newest-wins mode: the relayer over-fetches semantic candidates (5x `limit`, capped at 50), orders them by write-time descending, then truncates to `limit`. `scoringWeights` does something narrower — it re-ranks the candidates the vector search already returned and does not widen the search, so a record that fell outside the cosine top-`limit` cannot be recovered by any weighting.

Fully backward-compatible: omitting `sort` and `scoringWeights` leaves the request byte-identical to a plain cosine sort, and `created_at` is optional so relayers that don't send it behave exactly as before.
