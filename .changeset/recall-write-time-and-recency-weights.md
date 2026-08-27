---
"@mysten-incubation/memwal": patch
---

Expose each memory's write-time on `recall()`, and let callers ask for recency-weighted ranking (#621).

`RecallMemory` now carries `created_at` (RFC3339, the time the fact was stored), and `RecallOptions` accepts `scoringWeights` — which the relayer's composite ranker has always supported but which only the manual bring-your-own-embedding paths could reach.

Together these make a "newest wins" protocol correct by construction. Previously the only way to order by date was to sort `results` client-side, which cannot work: ranking happens server-side before `limit` truncates, so a newer record that matched the query less literally than an older one was dropped before the caller ever saw it. Pass `scoringWeights: { semantic: 0.3, recency: 0.7 }` to rank on write-time instead.

Fully backward-compatible: omitting `scoringWeights` leaves the request byte-identical to a plain cosine sort, and `created_at` is optional so relayers that don't send it behave exactly as before.
