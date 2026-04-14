# MemWal Readiness — Experiment Results

**Date**: 2026-04-07
**Experimenter**: Claude Code (Opus 4.6) executing the protocol in `docs/MEMWAL_EXPERIMENT.md`
**Working directory**: `/Users/echeng/cadru/experiments/memwal/`

## TL;DR

**Not ready for Cadru.** MemWal exists, the SDK works end-to-end against the public testnet relayer, and SEAL access control is wired natively into the on-chain Move contract — but the package is 15 days old (`@mysten-incubation/memwal@0.0.1`, first published 2026-03-23), exposes only `remember`/`recall`/`analyze`/`restore` (no `delete`/`forget`/`update`), and is fundamentally a **semantic-search store with a hard ~32 KiB ceiling per memory** because the relayer embeds the entire payload with `text-embedding-3-small`. Cadru's customer memory is structured JSON in the 200–500 KiB range; that does not fit a `remember(text)` API even after chunking, and the missing delete primitive is a GDPR blocker.

**Recommendation: Fallback (a) — raw Walrus + Seal with a thin custom memory layer — and revisit MemWal in ~9 months once it ships a 1.x with delete/update support and a non-relayer-required path for structured data.** We should adopt MemWal's *delegate-key + on-chain-account pattern* immediately even though we're not adopting the SDK, because it's exactly the right shape for our custodial-wallet model.

## SDK status

- **Package name**: `@mysten-incubation/memwal` (note: also published as `@mysten/memwal`, but the docs and blog announcement point to the `@mysten-incubation` namespace as canonical)
- **Latest version**: `0.0.1` (8 versions total: `0.0.1-dev.0` through `0.0.2`, all published in a 2-day window 2026-03-23 to 2026-03-24)
- **Source**: https://github.com/MystenLabs/MemWal — Apache 2.0, public, ~290 commits on `dev` branch, 7 contributors, TypeScript 89% / Rust 5% / Move 1%
- **Last published**: 2026-03-24 (15 days ago at time of writing)
- **Production/experimental label**: explicitly **beta**, "actively evolving", "no SLA guarantees" (per https://docs.memwal.ai/relayer/public-relayer)
- **Documentation quality**: surprisingly good for a 15-day-old project. Quick-start, API reference, contract overview, and self-hosting guides all exist at https://docs.memwal.ai/. Code examples run as written.
- **Funding model**: relayer storage fees absorbed by Walrus Foundation during beta — "the server wallet covers Walrus storage fees". This means we cannot benchmark real per-write cost from the SDK alone; cost is artificially zero for users today.

## API shape

### Primitives (default `MemWal` client)

| Method | Purpose | Cadru fit |
|---|---|---|
| `remember(text, namespace?)` | Embed → SEAL encrypt → Walrus upload → register vector. Returns `{id, blob_id, owner, namespace}` | partial — text only, ≤32 KiB |
| `recall(query, limit?, namespace?)` | Query embed → vector search → Walrus download → SEAL decrypt. Returns `{results: [{blob_id, text, distance}]}` | good — fast (<1s warm) |
| `analyze(text, namespace?)` | LLM extracts facts from text, stores each as a separate memory | not relevant |
| `restore(namespace, limit?)` | Re-index missing blobs from Walrus | maintenance only |
| `embed(text)` | Generate embedding without storing | not relevant |
| `health()` | Relayer ping | useful |

### Lower-level (`MemWalManual`)

Bypasses the relayer's embedding step. Caller provides their own embedding (OpenAI/OpenRouter API key required), runs SEAL encryption locally with `@mysten/seal`, uploads to Walrus directly, then registers `(blob_id, vector)` with the relayer for vector search. This is the only way to store payloads larger than the embedding-model context window — but the **store ceiling becomes whatever you can encode in a single embedding vector**, which still doesn't help for raw blob storage.

### Account / delegate management (`@mysten-incubation/memwal/account`)

| Method | Purpose |
|---|---|
| `generateDelegateKey()` | Random Ed25519 keypair, returns `{privateKey, publicKey, suiAddress}` |
| `createAccount({packageId, registryId, ...})` | Deploys a `MemWalAccount` shared object on Sui. **One per Sui address** (contract-enforced) |
| `addDelegateKey({accountId, publicKey, label, ...})` | Authorize a delegate key. Max 20 per account |
| `removeDelegateKey({accountId, publicKey, ...})` | Revoke a delegate |

This is the cleanest part of the SDK. The delegate-key model maps directly onto Cadru's custodial wallet design: one MemWalAccount per customer, the Cadru backend holds the delegate key, customers authenticate via email and never see crypto. **Worth adopting this pattern even if we don't use the rest of the SDK.**

### Structured data support

**None.** The API is `remember(text: string)`. To store structured data you `JSON.stringify` and pass it as text. There is no key-value access, no field-level update, no schema. Recall is by semantic similarity only — there is no `getById`, no `list`, no filter-by-namespace-and-key.

### Partial updates supported

**No.** Memories are immutable. The documented "update" flow is to call `remember()` again with the new content; this creates a *second* entry with a new id and blob_id while the original remains.

### Delete / forget supported

**No.** I read every public method on `MemWal`, `MemWalManual`, and the account-management entry point. There is no `delete`, `forget`, `revoke`, `expunge`, or equivalent. The only way data leaves the system is when the underlying Walrus blob's epoch lease expires (default ~1 year on mainnet). This is a **GDPR blocker** — Cadru cannot honor an account-deletion request within the regulatory window.

### Seal integration

**Native.** Confirmed by reading the source and querying the deployed Move contract via `src/seal.ts`:

- Every memory is encrypted with `@mysten/seal` before reaching Walrus. There is no plaintext-on-Walrus mode.
- The decryption policy is the on-chain Move function `0xcf6a…29c6::account::seal_approve(id, MemWalAccount, TxContext)`. Only Sui addresses listed as delegates of the `MemWalAccount` can decrypt.
- Threshold = 1 (single Mysten-operated SEAL key server per network). Not multi-sig.
- Adding/removing delegates is an on-chain transaction signed by the account owner.

Cadru does **not** need to layer SEAL on top — it's already wired all the way through. The only choice is whether plaintext touches the relayer (default mode) or stays on the client (manual mode).

## Results from Steps 3-5

All measurements taken 2026-04-07 against `https://relayer.staging.memwal.ai` (testnet) from a residential connection in California. Beta service, no SLA. Sui testnet RPC was flaky on first attempt (one 503), retry logic resolved it.

### Hello-world (single round-trip, ~120-byte text)

| Operation | Latency |
|---|---|
| `health()` | 484 ms |
| `remember()` first call | **19.64 s** |
| `recall()` first call | 2.62 s |

### Size-bound probe (`src/sizebound.ts`)

The default `remember()` call has a hard ceiling because the relayer pipes the whole text through an embedding model (looks like `text-embedding-3-small`, 8192 token context).

| Payload | Result | Latency |
|---|---|---|
| 1 KiB | ✅ ok | 16.58 s |
| 2 KiB | ✅ ok | 18.33 s |
| 4 KiB | ✅ ok | 16.96 s |
| 8 KiB | ✅ ok | 18.09 s |
| 16 KiB | ✅ ok | 18.41 s |
| 24 KiB | ✅ ok | 16.37 s |
| 32 KiB | ✅ ok | 19.29 s |
| **48 KiB** | ❌ **fail** | 1.07 s (server rejects in <2 s with `Failed to parse embedding response`) |
| 64 KiB | ❌ fail | 593 ms |
| 96 KiB | ❌ fail | 679 ms |

**Practical upper bound: ~32 KiB per `remember()` call.** Latency is essentially flat across the working range — payload size has near-zero effect; the cost is the relayer pipeline (embed → encrypt → Walrus → Sui tx) and the constant Walrus write floor.

### Cadru payload test (`src/payload.ts`, 250 KiB target)

| Step | Result |
|---|---|
| 1. `remember(250 KiB JSON)` | ❌ FAIL in 2.42 s — `MemWal API error (500): Failed to parse embedding response: error decoding response body` |
| 2. `recall("portfolio for cust_test_001…")` | ✅ ok in 670 ms, 0 results (write failed, nothing to find) |
| 3. `remember(updated 250 KiB JSON)` | ❌ FAIL — same embedding error |
| 4. `delete(memory)` | ❌ method does not exist in the SDK |
| 5. `recall("Lee Krasner Untitled inquiry")` | ✅ ok in 641 ms, 0 results |

**The native shape of Cadru customer memory does not fit MemWal's default API.** Even with chunking into 8× ~32 KiB pieces, we'd still face write latency of ~17 s × 8 = ~136 s per customer memory snapshot, no in-place update, and no GDPR delete.

### Benchmark (`src/benchmark.ts`, 5 writes + 5 reads, 16 KiB payload)

| Operation | Mean | p50 | p95 | min | max | Wall total |
|---|---|---|---|---|---|---|
| Write 16 KiB | **18.09 s** | 18.39 s | 18.83 s | 16.22 s | 18.87 s | 90.46 s |
| Recall (top-3) | **1.36 s** | 909 ms | 1.19 s | 731 ms | 3.06 s | 6.79 s |

5/5 writes ok, 5/5 reads ok, no failures or retries needed during the benchmark window.

**Important read finding**: the first recall took 3.06 s; subsequent recalls were 731 ms – 1.19 s. The relayer keeps an in-memory vector index and only the Walrus blob fetch + SEAL decrypt run on each call. **This is meaningfully faster than raw Walrus reads** (~3 s flat in our prior `walrus-seal` benchmark) for warm reads. The improvement comes from the vector index avoiding a per-call lookup transaction and the relayer's HTTP path to Walrus aggregators.

### Cost (testnet gas)

Bootstrap consumed:
- `createAccount` — 1 Sui transaction, ~3.5 s wall
- `addDelegateKey` — 1 Sui transaction, ~3.5 s wall
- Starting balance: 2.3553 SUI; ending: 2.3514 SUI → **~0.0039 SUI total** for one-time account setup

Per-memory writes during the benchmark consumed no measurable SUI from the user wallet — the relayer's TEE wallet pays for the Walrus PUT and the indexing transaction. **This is a beta subsidy, not a stable cost model.** When Mysten unwinds the subsidy, every `remember()` will cost: 1 Walrus blob write (~$0.0004 at current rates for ~16 KiB × 1 year) + 1 Sui tx (~$0.005 at SUI ≈ $5) + relayer compute (TBD). Conservative projection: **$0.005–0.01 per remember at scale.**

### Projected mainnet costs (rough order-of-magnitude)

The success criteria asks for $0.01/refresh max and <$5/customer/year. Using the back-of-envelope above:

- **Per refresh** (1 chunk): ~$0.005 — meets the criterion *if the beta subsidy were lifted today and our model held*. With chunking (8 chunks per 250 KiB customer memory), it's $0.04 per refresh. Borderline.
- **Per customer per year** (1000 refreshes/month, 8 chunks each, ~12-month retention): $0.04 × 1000 × 12 = $480/year/customer. **Far exceeds** the $5/year target.

The cost criterion **fails badly under chunked storage**. Cadru would have to either store per-customer memory as one ≤32 KiB blob (impossible — the structured data is bigger) or switch to MemWalManual (where we control embedding and would still pay Walrus writes per chunk).

## Success criteria checklist

| Criterion | Status | Notes |
|---|---|---|
| SDK published on npm with non-prerelease 1.x.x, OR 0.x.x with >6 months stable history | ❌ | `0.0.1`, 15 days old, 8 versions in 2 days |
| CRUD a memory blob in <30 lines of TS (excluding imports) | ⚠️ partial | C+R+U yes (~10 lines), D not supported at all |
| Round-trip 200 KB JSON in <10 s on testnet | ❌ | 200 KB cannot be written at all (embedding ceiling). Even 16 KiB writes take 18 s, well over 10 s |
| Per-customer write cost <$0.01/refresh on mainnet (1000 refreshes/mo) | ❌ | ~$0.04/refresh under chunked storage, ignoring relayer compute |
| Per-customer storage cost <$5/year for 500 KB / 1 year | ❌ | $480/year/customer projected under chunked storage |
| Seal integration documented and works (built-in or layerable) | ✅ | Native, on-chain enforced, source-verified |
| Source code accessible | ✅ | https://github.com/MystenLabs/MemWal, Apache 2.0 |

**3 of 7 criteria fail outright; one is partial (delete missing).** MemWal does not meet the success bar.

It is **not ready** because it triggers these explicit "not ready" conditions from the protocol:
- ✗ API is still in flux (8 versions in 48 hours, 0.0.x, "actively evolving")
- ✗ Round-trip > 30 seconds (250 KiB outright fails; 16 KiB writes 18 s but the cumulative chunked-write story for our actual payload size is well over 30 s)
- ✗ Storage cost > $20/customer/year (projected $480/year under chunking; even unsubsidized single-blob storage of one 16 KiB chunk × 1000 writes/month × 12 months ≈ $60/year/customer)

## Fallback evaluation

### (a) Raw Walrus + Seal with a thin custom memory layer

- **Eng time**: ~3–5 weeks for a production-ready v1
  - Week 1: Sui Move policy contract (mirror the MemWal `account.move` shape — `MemWalAccount`-equivalent + `seal_approve`-equivalent; ~200 lines of Move)
  - Week 2: TS server library — `customerId → blobId` index (Postgres or Sui object), serialization, chunking strategy, Seal session-key handling
  - Week 3: CRUD API, integration tests against the existing `walrus-seal` experiment, retry/idempotency
  - Week 4–5: hardening, key rotation, GDPR delete (which on Walrus means key destruction + epoch expiry + index removal)
- **Op cost at 100 customers**: ~$50–80/month
  - Walrus storage: 500 KB × 100 customers × 26 epochs/year × $0.025/GB/epoch ≈ $4/year. Effectively zero.
  - Sui transactions: ~2 per customer per month × 100 × $0.005 ≈ $1/month
  - Compute: small Node service ~$30/month
  - Postgres for index: ~$15/month minimum
- **Custodial wallet fit**: Excellent. We control the entire delegate-key lifecycle and can copy MemWal's pattern verbatim.
- **Migration story to MemWal later**: Easy. Same primitives (Sui, Walrus, Seal). The `MemWalAccount` shape is open source — we could adopt it directly when ready, then point our existing code at the MemWal SDK with minimal refactor.
- **Verdict**: **Recommended.**

### (b) Postgres with column-level encryption (per-customer KMS-managed key)

- **Eng time**: ~1–2 weeks for production
  - Day 1–2: schema, key-per-customer KMS integration (AWS KMS or Tink)
  - Day 3–5: encryption helpers, migrations, RLS policies
  - Week 2: integration with the rest of Cadru, audit logging, key rotation
- **Op cost at 100 customers**: ~$30/month
  - Aurora Serverless v2: ~$25/month minimum
  - KMS: $1/customer-key/month → $100/month at scale, but typically negligible at 100
- **Custodial wallet fit**: N/A — no wallets, no decentralization. Cadru is the single trust point.
- **Migration story to MemWal later**: Hard. The schema and key model don't translate to a memory-blob system. Migration would mean exporting JSON, re-encrypting under SEAL, and re-uploading — feasible but ugly.
- **Verdict**: Cheapest and fastest, but **abandons the data-sovereignty story** that motivates the Walrus track in the first place.

### (c) Per-customer SQLite + SQLCipher

- **Eng time**: ~2–3 weeks
  - Week 1: SQLCipher build, Node bindings, file-per-customer storage (S3 or local NVMe)
  - Week 2: connection pooling, locking, write-through to durable storage
  - Week 3: backup, key derivation, test harness
- **Op cost at 100 customers**: ~$20/month
  - S3 for the .db files: cents
  - Compute: a small Node service
- **Custodial wallet fit**: N/A
- **Migration story to MemWal later**: Hard. Same problem as Postgres.
- **Verdict**: Worse than Postgres in almost every dimension (concurrency, HA, queryability). Don't pick this.

### (d) Hybrid: Postgres for indexable fields + Walrus+Seal for free-form blobs

- **Eng time**: ~4–5 weeks
  - Postgres half: per fallback (b)
  - Walrus half: a subset of fallback (a) for the blob types only (advisor notes, conversation history, full-portfolio JSON snapshot)
  - Integration: split-brain prevention, single source of truth for which fields go where
- **Op cost at 100 customers**: ~$50–70/month (Postgres + Walrus + Sui)
- **Custodial wallet fit**: Walrus side fits; Postgres side does not — sensitive structured data still sits in our database.
- **Migration story to MemWal later**: Possible for the Walrus portion only. The Postgres portion has the same migration problem as fallback (b).
- **Verdict**: Reasonable middle path *if performance constraints force it*, but introduces split-brain risk. The performance pressure isn't there yet — Cadru's reads are infrequent and writes are background.

### Comparison summary

| Option | Eng | Op cost (100 cust) | Custodial fit | Decentralization | Migration to MemWal |
|---|---|---|---|---|---|
| (a) Raw Walrus+Seal | 3–5 wk | ~$50/mo | ✅ excellent | ✅ full | ✅ easy |
| (b) Postgres + KMS | 1–2 wk | ~$30/mo | ❌ N/A | ❌ none | ❌ hard |
| (c) SQLite + SQLCipher | 2–3 wk | ~$20/mo | ❌ N/A | ❌ none | ❌ hard |
| (d) Hybrid | 4–5 wk | ~$50–70/mo | ⚠️ partial | ⚠️ partial | ⚠️ partial |

## Recommendation

**Fallback (a) — raw Walrus + Seal with a thin custom memory layer — and revisit MemWal in ~9 months.**

### Why not MemWal now

1. **Maturity**: 15 days old, 0.0.x, 8 versions in 48 hours, beta with no SLA. Putting customer memory on a service this young is a production-stability risk we shouldn't take.
2. **API mismatch**: `remember(text)` is a semantic-search store, not a customer-memory store. Cadru's data is structured JSON in the 200–500 KiB range; MemWal forces a 32 KiB chunking strategy plus an embedding model in the hot path that gives us nothing useful for portfolio reads.
3. **No delete**: GDPR requires us to honor account-deletion requests. MemWal's only deletion path is "wait for the Walrus epoch lease to expire," which is on the order of a year. That's not compliant.
4. **Cost ceiling under realistic chunking**: projected $480/customer/year if the beta subsidy lifts. Far above the $5/year target.
5. **Hidden trust boundary**: the default relayer sees plaintext during embedding and encryption. Even though it runs in a TEE, "the relayer sees plaintext during encryption and embedding" is in the official docs as a caveat. For collector financial data this is the wrong boundary to make implicit.

### Why fallback (a)

1. **Same primitives**: Walrus + Seal + Sui — exactly the architecture we already validated in `experiments/walrus-seal/`.
2. **Migration path**: copying MemWal's `MemWalAccount` Move shape gives us a forward-compatible identity model. When MemWal hits 1.x and adds delete + structured data, we can swap our memory layer for theirs without changing the on-chain identity model.
3. **Cost**: ~$50/month at 100 customers is genuinely cheap and we control the cost curve.
4. **Honesty about trust**: Cadru's backend holds the delegate keys, which is the same trust posture we'd have with the MemWal relayer. We're not pretending to be more decentralized than we are.

### What to copy from MemWal even though we're not using the SDK

- **Delegate-key model**: Ed25519 delegate keys, on-chain account that lists authorized delegates, `seal_approve` Move function gating decryption. This is the right abstraction. We should write a Move module that mirrors MemWal's `account.move`, deploy it, and use it.
- **Account-per-customer**: one shared object on Sui per customer is the natural unit. Cadru's backend creates them on signup.
- **One-account-per-Sui-address constraint** (or its equivalent): keeps the model clean. We'd derive a per-customer Sui address from a deterministic HKDF of a backend master key + customerId, so account creation is reproducible if we lose state.

### What to revisit MemWal for in ~9 months (target: 2027-Q1)

- 1.x release with stable API
- A `forget()` / `delete()` method, or documented epoch-truncation for early deletion
- Either a structured-data API or an explicit "this is for short text only" positioning
- Production SLA from Mysten or Walrus Foundation
- Real cost data (post-subsidy)
- Multi-key-server SEAL threshold > 1

If those land, the migration from fallback (a) to MemWal is straightforward because we'd already be on the same on-chain primitives.

## Code artifacts

All in `experiments/memwal/`:

| File | Purpose |
|---|---|
| `src/config.ts` | Shared constants — testnet contract addresses, relayer URL, env helpers |
| `src/bootstrap.ts` | One-shot setup: generate delegate key, create `MemWalAccount` on testnet, register delegate. Idempotent and resumable from a half-complete `.env` |
| `src/hello.ts` | Minimal `health → remember → recall` round-trip |
| `src/sizebound.ts` | Probe the `remember()` payload size ceiling (1–96 KiB sweep) |
| `src/payload.ts` | Realistic Cadru customer memory test (~250 KiB JSON) — confirms the failure mode |
| `src/benchmark.ts` | 5 writes + 5 reads of a 16 KiB payload, mean/p95 metrics |
| `src/seal.ts` | Read-only inspection of the on-chain `MemWalAccount` and `seal_approve` Move function |
| `package.json` | npm scripts for each above (`hello`, `payload`, `benchmark`, `seal`, `typecheck`) |
| `tsconfig.json` | Mirrors `experiments/walrus-seal` |
| `.env` | Funded testnet `SUI_PRIVATE_KEY`, `MEMWAL_ACCOUNT_ID`, `MEMWAL_DELEGATE_KEY` (gitignored) |
| `.gitignore` | Excludes `node_modules`, `dist`, `.env*` |

Run order for a fresh checkout:

```bash
cd experiments/memwal
cp ../walrus-seal/.env .env   # or set SUI_PRIVATE_KEY manually
npm install
npx tsx src/bootstrap.ts      # one-time, creates on-chain account
npx tsx src/hello.ts          # smoke test
npx tsx src/sizebound.ts      # probe the embedding ceiling
npx tsx src/benchmark.ts      # 5+5 metrics run
npx tsx src/seal.ts           # on-chain inspection
```

### Reusable artifacts on testnet

These are persisted in the `.env` file and live on Sui testnet — a future session can resume against the same account without burning gas:

- **MemWalAccount object**: `0x765cb8aa2bf03e3269441bbe866bfe5d9b0e2e16f174be9d5406e0dc2c6c0b8b`
- **Owner address**: `0x05b1db5fe3521c1e570b9bad6af80a26bba0399100466d9f95621ea027d0047d`
- **Delegate public key**: `7fe9d519c7bd935424d64254c2a489bdd789c7f69dfa167e57d03437b0fc5e71`
- **Account create digest**: `2rtnxfbNkJV262h8NkBgDMf59obqVnbUGyaQr3gz9gL6`
- **Add delegate digest**: `8sdC8J6WwyMXJv9D7en8qECQPsc3RZpQky9FHK3apt4D`

## Open questions

Things I could not determine in the time budget that might affect the decision:

1. **Real cost post-subsidy.** The relayer absorbs Walrus + Sui fees during beta. Mysten has not published a price model for what happens when the subsidy ends. Our $480/customer/year projection is back-of-envelope from our `walrus-seal` cost data; the actual number depends on Mysten's pricing and on whether they offer self-host parity.

2. **MemWalManual end-to-end performance.** I did not run the manual flow because it requires an OpenAI/OpenRouter API key (we'd need to stand up keys in `.env`, pay for embeddings, deal with rate limits). The manual flow is the only path for payloads larger than 32 KiB, so this is the right thing to test next if MemWal becomes a serious candidate. Expected behavior: similar latency, similar per-write Walrus cost, but with a controllable embedding strategy and the ability to skip the embedding step for blobs that don't need search.

3. **Self-hosted relayer feasibility.** The docs describe self-hosting at https://docs.memwal.ai/relayer/self-hosting. I did not stand one up. Self-hosting would address the trust boundary concern (no third-party plaintext) and the SLA gap, but adds a Rust service to our ops surface.

4. **Token-level limit, not byte-level.** The 32 KiB ceiling is empirical. The real limit is probably around 7000 input tokens to `text-embedding-3-small`. Different content (denser tokenization, e.g. all uppercase or non-English) could shift the byte threshold up or down. Realistic Cadru content (English JSON) probably sits near the 32 KiB observation, but I didn't characterize the distribution.

5. **Tail latency at scale.** 5 samples is enough to see "writes are 17–19 s, reads are 700 ms – 1.2 s" but not enough to characterize p99 or behavior under sustained load. The relayer's vector index could degrade as it grows.

6. **Behavior when delegate key is rotated mid-flight.** Important for our key-rotation story. Untested.

7. **Move contract upgradeability.** If Mysten ships a new `MemWalAccount` shape with a different `seal_approve` signature, do existing accounts continue to work? Affects forward compatibility of any pattern we copy.

8. **Geographic latency.** Tested from California; the relayer URL doesn't reveal where it's hosted. EU/APAC numbers may differ materially.

9. **SDK breaking-change cadence.** 8 versions in 48 hours during the launch sprint. What does the steady-state cadence look like? GitHub commit history would tell us, but I didn't quantify it.

10. **Whether `@mysten/memwal` (the *non*-incubation namespace) is dead, deprecated, or meant for something different.** Both packages exist on npm with similar shapes. The docs only reference `@mysten-incubation/memwal`. Worth a direct question to Mysten before we commit to either name.

## Sources

- [MemWal launch announcement (Walrus blog)](https://blog.walrus.xyz/memwal-long-term-memory-for-ai-agents/)
- [MemWal docs](https://docs.memwal.ai/)
- [MemWal contract overview (testnet/mainnet IDs)](https://docs.memwal.ai/contract/overview)
- [MemWal public relayer](https://docs.memwal.ai/relayer/public-relayer)
- [`@mysten-incubation/memwal` on npm](https://www.npmjs.com/package/@mysten-incubation/memwal)
- [MystenLabs/MemWal on GitHub](https://github.com/MystenLabs/MemWal)
- [Walrus pitches MemWal (Blocks and Files, 2026-03-31)](https://www.blocksandfiles.com/ai-ml/2026/03/31/walrus-pitches-memwal-as-decentralized-storage-for-ai-agent-memory/5213479)
- [Cadru Walrus performance analysis (prior experiment)](./WALRUS_PERFORMANCE_ANALYSIS.md)
