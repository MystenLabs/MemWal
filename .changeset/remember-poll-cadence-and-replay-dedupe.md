---
"@mysten-incubation/memwal": patch
---

Cut the dead time a `remember` spends waiting to be told it finished, and stop a reconnect replay from minting a second paid write.

Job polling backed off as `min(10s, base * 1.5^min(attempt, 6))` from a 1500ms base, so status checks landed at roughly 1.5/3.75/7.1/12.2/19.8/29.8s. Real writes finish in the 15–35s band — a Walrus sliver upload plus three sequential Sui transactions — which is exactly where those gaps are widest, so a write that truly completed at 20.5s was not reported to the caller until 29.8s. That lag is pure observation cost: the job was done, nobody had asked yet. The backoff now caps at 2s and the base default drops to 600ms, putting average dead time near 1s instead of ~5s. Polling is a single indexed row read, so a 30s write costs ~17 checks instead of ~6.

`waitForRememberJob` and `waitForRememberJobs` also slept *before* their first status check, so an idempotent replay of a write the relayer had already finished still paid a full poll interval for a result that was ready on arrival. Both now check first and sleep second.

Generated idempotency keys are derived from the content (`sha256` over a 30-minute time bucket plus namespace and text) instead of `crypto.randomUUID()`. `pendingRememberKeys` only ever dedupes retries that reuse one client instance, and the MCP sidecar builds a fresh `MemWal` per transport session — so when a stdio bridge reconnects a dropped stream and the agent re-issues the same `memwal_remember`, the map is empty and a random key reads as a brand-new write. The relayer would then mint a second paid Walrus blob for a write already in flight, doubling queue load exactly when the queue was already slow enough to have caused the drop. The bucket bounds the collapse: `remember_jobs` rows are never pruned, so an unbucketed key would dedupe against a job from any point in history and a re-save of a since-deleted fact would return the old blob id instead of storing it again.

Callers passing an explicit `idempotencyKey` are unaffected, and distinct text or namespaces still get distinct keys.
