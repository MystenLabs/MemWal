---
"@mysten-incubation/memwal": minor
---

Add trustless `MemWal.verify()` / `verifyMemory()` — confirm a memory's provenance from public inputs only (on-chain `Blob` metadata, delegate-key binding, and public Walrus aggregator retrievability) with no private key and no relayer. `@mysten/sui` is loaded dynamically so the default entry point stays dependency-light. Includes a "verify a memory" guide.
