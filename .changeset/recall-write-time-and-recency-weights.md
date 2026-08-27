---
"@mysten-incubation/memwal": patch
---

Expose each memory's write-time on `recall()`, and let callers ask for recency-weighted ranking (#621).

`RecallMemory` now carries `created_at` (RFC3339, the time the fact was stored), and `RecallOptions` accepts `scoringWeights` — which the relayer's composite ranker has always supported but which only the manual bring-your-own-embedding paths could reach.

`created_at` is the piece a "newest wins" protocol was missing: previously the only date available was whatever the memory text happened to mention, so callers could neither order nor verify by write-time.

Note that `scoringWeights` re-ranks the candidates the vector search already returned — it does not widen the search. A record that fell outside the cosine top-`limit` cannot be recovered by any weighting, so raise `limit` when the record you need might not be in the window. A dedicated recency mode that over-fetches server-side is still open (WALM-383).

Fully backward-compatible: omitting `scoringWeights` leaves the request byte-identical to a plain cosine sort, and `created_at` is optional so relayers that don't send it behave exactly as before.
