---
"@mysten-incubation/memwal": patch
---

Give every relayer request a deadline. `fetch` has none of its own, and the SDK passed an abort signal on exactly one method (`recall`, 15s) — so the accept POST, every job-status read, and the `/version` and `/config` handshake calls that run before any of them could stay pending for as long as the socket stayed open.

That was not merely untidy. A poll loop checks its budget at the *top* of each iteration, which bounds when the next request starts, not how long one takes — so a single stalled read ran straight past `timeoutMs`. A `memwal_remember` documented as capping at 90s was observed by an MCP client still running after 120s, with the stdio bridge's orphan sweeper the first thing to fire, minutes later.

Requests now default to a 30s deadline, matching the relayer's own outbound HTTP client: any call that depends on the relayer reaching the sidecar, Walrus or OpenAI has already failed upstream by the time it fires. Configure it with `requestTimeoutMs` on `MemWal.create`; a non-positive or non-finite value falls back to the default rather than disabling the bound. The two endpoints that legitimately run longer carry their own: `restore` (60s — the route bounds itself at 55s server-side and answers rather than going quiet) and `analyze` (60s — it runs the extractor LLM inline before accepting). `recall` keeps its 15s, now as a named constant rather than a hand-rolled `AbortController`.

Inside the wait loops each poll is bounded by the client deadline clamped to the remaining budget. Both directions matter: the remaining budget stops a poll outliving the wait it belongs to, and the client deadline stops one stalled poll swallowing the whole budget, so the loop still gets to retry. An expired request raises `MemWalRequestTimeout` carrying `status: 504`, which `isTransientPollingStatus` already treats as retryable — so a stalled poll is retried against what is left rather than failing the wait outright. A caller's own abort, and any other transport error, propagates unchanged.
