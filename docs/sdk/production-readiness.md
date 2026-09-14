---
title: Production Readiness for Agent Storage
description: >-
  Patterns for running Walrus Memory in a production agent: idempotent writes, retries with exponential backoff, confirming write durability, bounding cost with batching and budgets, key custody best practices, and graceful degradation when memory is unavailable.
keywords:
  - production readiness
  - idempotent writes
  - retries
  - cost management
  - Walrus Memory
  - MemWal
goal:
  description: "Harden a Walrus Memory integration for production: add idempotent writes, configure retry and timeout logic, cap costs, secure key custody, and add graceful degradation when the relayer is unreachable."
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 300
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - How do I make Walrus Memory writes idempotent?
  - How do I handle retries and failures in a production MemWal agent?
  - How do I control costs when using Walrus Memory in production?
answer: >-
  Production-harden a Walrus Memory agent by making writes idempotent with content hashing, retrying only transient failures with exponential backoff, confirming write durability before acting on memories, batching with rememberBulkAndWait to reduce costs, capping writes per cycle, loading keys from a secret manager, and degrading gracefully when the memory layer is unavailable.
---

The SDK gives you the storage primitives. Running them in a long-lived agent, where there is no human to retry a failed write or notice a runaway bill, takes a few patterns on top. This guide collects the ones that matter most.

Several of these are patterns you implement around the client today. Where a capability is on the roadmap as a native feature, this guide says so, so you know which code is permanent and which is a stopgap.

## Make writes idempotent

Every write carries an idempotency key. Pass your own through `idempotencyKey` and
a repeat submission returns the original job instead of minting a second blob,
which you would also pay for. Omit it and the SDK generates one per call, which
still covers its own internal retries but gives you nothing to replay with later.

```ts
import { createHash } from "crypto";

function writeKey(text: string, namespace = "default") {
  return createHash("sha256").update(`${namespace}:${text}`).digest("hex");
}

async function rememberOnce(memwal: MemWal, text: string, namespace?: string) {
  return memwal.rememberAndWait(text, namespace, {
    idempotencyKey: writeKey(text, namespace),
  });
}

// job.idempotency_key echoes the key back, so a fire-and-forget caller can
// persist it alongside job.job_id.
const job = await memwal.remember(text, namespace, { idempotencyKey: writeKey(text, namespace) });
```

Derive the key from the content, as above. It is then stable across processes, so
a replay after a restart lands on the original job. Reusing one key for
*different* content is rejected with a `409`.

<Note>
Persist the key outside the process (Redis, a database row, a Sui object), not in
memory. An in-memory map resets on restart, which is exactly when a retry storm
is most likely.
</Note>

## Recover an unknown outcome

When `rememberAndWait()` exhausts its poll budget, the write is **unknown, not
failed**. The relayer accepted the job before the budget expired and usually
finishes it seconds later. Retrying that call blindly is what stores the memory
twice.

`isRememberJobTimeoutError()` separates the two cases, and the error carries both
handles you need to settle the write:

```ts
import { isRememberJobTimeoutError } from "@mysten-incubation/memwal";

try {
  await memwal.rememberAndWait(text, namespace);
} catch (err) {
  if (!isRememberJobTimeoutError(err)) throw err; // a real failure

  // Option A: settle the job that already exists. No second write.
  const settled = await memwal.waitForRememberJob(err.jobId, { timeoutMs: 120_000 });
  console.log(settled.blob_id);

  // Option B: hand err.jobId and err.idempotencyKey to a durable queue and
  // resume later, even from another process:
  //   await memwal.rememberAndWait(text, err.namespace, {
  //     idempotencyKey: err.idempotencyKey,
  //   });
}
```

Prefer option A while the process is still up: it is a read. Option B is for a
worker that picks the write back up after a restart. The replay collapses onto
the original job, so it settles the same blob rather than paying for a new one.

## Retry with backoff, but only retryable failures

The client does not retry for you. Wrap calls in exponential backoff, and be careful to retry only failures that a retry can fix. A transient network error is worth retrying. A `401 AUTH_REJECTED` is a configuration problem that fails identically on every attempt, so retrying it just delays the real fix.

A write that timed out while polling is the case to be careful with. It is not a failure, so re-running the write is not a retry: it is a second write. Treat `isRememberJobTimeoutError(err)` the way you treat a 4xx and stop, then recover through the job id or the key as shown above.

```ts
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      // A poll timeout is an unknown outcome, not a failure. Retrying the
      // write here is what stores the memory twice.
      if (isRememberJobTimeoutError(err)) throw err;
      const status = (err as { status?: number }).status;
      // Do not retry auth or client errors; they will not succeed on a retry.
      if (status === 401 || (status && status >= 400 && status < 500)) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2 ** i * 500 + Math.random() * 250));
    }
  }
  throw lastErr;
}

await withRetry(() => rememberOnce(memwal, "Observed: deploy at 14:03 UTC."));
```

Pairing retry with the idempotency key above is deliberate: a retry that fires after the write actually succeeded server-side stays safe, because the relayer returns the original job for that key instead of minting a second blob.

<Note>
Built-in retry and backoff inside the client is on the roadmap. When it ships, you can drop the wrapper for the calls it covers and keep only the idempotency guard.
</Note>

## Confirm durability before acting on a memory

An autonomous agent should not make a decision that assumes a write persisted until it confirms the write reached a terminal state. The `*AndWait` helpers block until each job reports `done`; when you write without blocking, capture the job IDs and wait on them before depending on the data.

```ts
const accepted = await memwal.rememberBulkAsync(items);
const settled = await memwal.waitForRememberJobs(accepted.job_ids);

if (settled.failed > 0) {
  const bad = settled.results.filter((r) => r.status !== "done");
  throw new Error(`${settled.failed} writes did not persist: ${bad.map((b) => b.status).join(", ")}`);
}
```

<Warning>
A job reaching `done` confirms that the relayer stored the memory, but the vector index can briefly lag behind that signal, so a `recall` fired in the same instant might not return the memory yet. For read-after-write critical paths, tolerate a short delay or re-query rather than treating an empty first result as a missing memory.
</Warning>

For the full write, confirm, and recall sequence in context, see [Agent Storage Loop](/sdk/agent-storage-loop).

## Bound cost

Every write registers storage on Walrus and costs gas and WAL. An agent in a tight loop can run up spend quickly, so put ceilings in the agent, not just in your head.

- **Batch with Quilt.** `rememberBulkAndWait` (up to 20 items) collapses many small writes into far fewer transactions. Buffer small state blobs and flush them as a batch instead of writing one at a time.
- **Do not store what you never recall.** Ephemeral scratch state that never feeds a future `recall` does not belong in durable storage. Keep it in process memory.
- **Cap writes per cycle.** Give the agent loop a budget, for example a maximum number of memories per run or per hour, and have it drop or summarize past the cap rather than write unbounded.

```ts
let writesThisCycle = 0;
const MAX_WRITES_PER_CYCLE = 50;

async function budgetedRemember(memwal: MemWal, text: string) {
  if (writesThisCycle >= MAX_WRITES_PER_CYCLE) return false;
  await rememberOnce(memwal, text);
  writesThisCycle++;
  return true;
}
```

## Custody the agent's keys

A headless agent holds secrets no human rotates by hand, so treat them with production discipline.

- The **delegate key** authenticates the agent to the relayer.
- For client-managed encryption, the **Sui key** signs the Seal and Walrus operations. See [holding your own keys](/sdk/usage/memwal-manual#agent-state-holding-your-own-keys).

Load both from a secret manager, never from source or logs. Scope each agent to its own delegate key so you can revoke one without taking down the rest, and rotate through the dashboard if a key might be exposed. If the Sui key behind client-managed encryption is lost, you cannot recover the encrypted memories, so back it up with the same care as any data-encryption key.

## Degrade gracefully when memory is unavailable

A memory layer that is down should slow your agent, not stop it. Check reachability at startup and guard the memory paths so the agent keeps serving when the relayer is unreachable for a cycle.

```ts
let memory: MemWal | null = null;
try {
  memory = MemWal.create({ key, accountId, serverUrl, namespace });
  await memory.health();
} catch (err) {
  console.log("Memory unavailable, continuing without it this cycle:", err);
  memory = null;
}

// Guard every read and write on memory being live.
if (memory) {
  await budgetedRemember(memory, "...");
}
```

This is the same defensive pattern the [Cloudflare Workers guide](/sdk/cloudflare-workers) uses to keep a Worker healthy when the memory dependency has a bad moment.

## Mind the recall result cap

`recall` returns up to `limit` results, defaulting to `10`. When more memories match than the cap, the relayer does not return the extra results, with no signal that it truncated the set. If a decision depends on seeing every match, set `limit` explicitly to a value above what you expect, and treat a result count equal to `limit` as a sign there might be more.

```ts
const result = await memwal.recall({ query: "open incidents", limit: 50 });
if (result.results.length === 50) {
  console.warn("Recall hit the limit; there may be more matches than returned.");
}
```

## Next steps

- [Agent Storage Loop](/sdk/agent-storage-loop): the write, confirm, and recall loop these patterns harden
- [MemWalManual](/sdk/usage/memwal-manual): client-managed encryption and key custody
- [Troubleshooting](/troubleshooting/overview): auth, timeout, and read-after-write symptoms
- [Public relayer](/relayer/public-relayer): managed Mainnet and Testnet endpoints
