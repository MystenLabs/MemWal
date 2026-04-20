# Code Review: BENCHMARK_MODE Toggle

> **Purpose**: Verify the `BENCHMARK_MODE=true` toggle correctly isolates blockchain interactions without distorting retrieval quality results.
>
> **Scope**: All code paths touching SEAL encryption or Walrus storage.
>
> **Verdict**: **Safe for the benchmark we ran (LOCOMO via `/api/analyze` + `/api/recall`). Incomplete for other endpoints. One minor cosmetic issue. No correctness issues affecting benchmark results.**

---

## 1. Complete SEAL/Walrus Call Site Audit

I found 18 SEAL/Walrus call sites in `routes.rs`. Here's every one, its endpoint, and whether it's branched for benchmark mode:

| Line | Endpoint | Purpose | Branched? |
|---|---|---|---|
| 193 | `remember` | SEAL encrypt on write | ✅ Yes |
| 319 | `recall` | Walrus download | ✅ Yes |
| 333 | `recall` | SEAL decrypt | ✅ Yes |
| **492** | **`remember_manual`** | **Walrus upload** | **❌ No** |
| **508** | **`remember_manual`** | **Walrus download** | **❌ No** |
| 702 | `analyze` | Walrus download (Stage 4 decrypt) | ✅ Yes |
| 703 | `analyze` | SEAL decrypt (Stage 4) | ✅ Yes |
| 839 | `analyze` | SEAL encrypt (write) | ✅ Yes |
| 1476 | `analyze` → `store_memory_with_transaction` | Walrus upload | ✅ Yes (branched at caller) |
| **1621** | **`consolidate` (standalone)** | **Walrus download** | **❌ No** |
| **1622** | **`consolidate` (standalone)** | **SEAL decrypt** | **❌ No** |
| 1739 | `consolidate` (UPDATE path) | SEAL encrypt | ✅ Yes |
| 1850 | `consolidate` (ADD path) | SEAL encrypt | ✅ Yes |
| **1985** | **`ask`** | **Walrus download** | **❌ No** |
| **1998** | **`ask`** | **SEAL decrypt** | **❌ No** |
| **2151** | **`restore`** | **Walrus query_blobs** | **❌ No** |
| **2213** | **`restore`** | **Walrus download** | **❌ No** |
| **2266** | **`restore`** | **SEAL decrypt** | **❌ No** |

### Summary

**Fully branched endpoints (safe in benchmark mode)**:
- `POST /api/analyze` — all 4 call sites branched ✅
- `POST /api/recall` — both call sites branched ✅
- `POST /api/remember` — fully branched ✅
- `POST /api/consolidate` — partially branched (write paths yes, standalone decrypt no)

**NOT branched (will fail in benchmark mode if hit)**:
- `POST /api/remember/manual` — 2 call sites
- `POST /api/consolidate` — 2 call sites in the standalone decrypt stage (line 1621-1622)
- `POST /api/ask` — 2 call sites
- `POST /api/restore` — 3 call sites

### Impact on our benchmark

Our LOCOMO run only hit `POST /api/analyze` (ingestion) and `POST /api/recall` (evaluation). Both are fully branched. **The benchmark results are valid — no SEAL/Walrus code was executed during the run.**

Verification from run logs:
```
272 POST http://localhost:3001/api/analyze   (ingestion, earlier run)
499 POST http://localhost:3001/api/recall    (partial eval, earlier run)
5958 POST http://localhost:3001/api/recall   (3 presets × 1986 queries, successful run)
```

---

## 2. Data Isolation Verification

### Schema-level isolation

Benchmark rows are distinguishable by:
- `blob_id` prefix: `bench:{uuid}` vs Walrus CIDs (which never start with "bench:")
- `plaintext` column populated (NULL for production rows)

### Query-level isolation

Every query in `db.rs` filters by `(owner, namespace)`. Verified by grep:

```
Line 365: AND namespace = $3
Line 415: WHERE owner = $2 AND namespace = $3
Line 445: WHERE owner = $1 AND namespace = $2 AND content_hash = $3
... (11 total namespace-filtered queries)
```

Benchmark data uses namespaces prefixed `bench-locomo-*`. Production data uses user-chosen namespaces (typically `default`). No cross-contamination possible unless a production caller deliberately sets `namespace = "bench-*"` — which would be abnormal.

### Unique constraints

The content-hash unique index is scoped to `(owner, namespace)`:

```sql
CREATE UNIQUE INDEX idx_ve_content_hash_active
    ON vector_entries (owner, namespace, content_hash)
    WHERE content_hash IS NOT NULL AND valid_until IS NULL AND superseded_by IS NULL;
```

So benchmark rows can have the same content_hash as production rows for the same owner, as long as the namespace differs. This is correct — `bench-locomo-conv-26-*` and `production` are different namespaces.

---

## 3. Scoring Correctness Under Benchmark Mode

**The critical question**: does BENCHMARK_MODE alter the retrieval scoring in any way that would invalidate the benchmark results?

**Answer: no.** Here's why:

The composite scoring formula in `recall` at `routes.rs:381`:
```rust
let composite = (scoring.semantic as f64) * semantic_score
    + (scoring.importance as f64) * importance_score
    + (scoring.recency as f64) * recency_score
    + (scoring.frequency as f64) * freq_score;
```

Inputs:
- `distance` (→ `semantic_score`): from pgvector cosine query — **identical in both modes**
- `importance`: column value from DB — **identical in both modes**
- `created_at`: column value from DB — **identical in both modes** (both paths use `NOW()` at insert)
- `access_count`: column value from DB — **identical in both modes**

**The only difference between benchmark and production recall paths is HOW the plaintext is fetched** (DB column vs Walrus+SEAL). The scoring, ranking, and order of results are computed on identical data.

This means the J-scores we reported (52 baseline, 51 default, 50 recency_heavy) accurately reflect MemWal's retrieval quality. They would be the same if we'd run the full production stack, just slower.

---

## 4. Startup Flow Review

From `main.rs:45-98`:

```rust
if config.benchmark_mode {
    tracing::warn!("BENCHMARK_MODE=true — blockchain layer DISABLED");
    ...
}

// Sidecar is only needed for SEAL + Walrus. Skip entirely in benchmark mode.
let sidecar_child_opt: Option<tokio::process::Child> = if config.benchmark_mode {
    tracing::info!("  sidecar: SKIPPED (benchmark mode)");
    None
} else {
    // ... spawn sidecar, wait for health check
    Some(sidecar_child)
};
```

**Good**: Sidecar startup (the ~15 second wait for the TS SEAL/Walrus server) is correctly skipped.

**Concern (minor)**: `walrus_client` is still constructed in benchmark mode (line 106):

```rust
let walrus_client = walrus_rs::WalrusClient::new(
    &config.walrus_aggregator_url,
    &config.walrus_publisher_url,
).expect("Failed to initialize Walrus client (invalid URL?)");
```

This is idempotent (just URL parsing) but would panic at startup if benchmark_mode=true is set with bogus Walrus URLs. Not a correctness issue for our benchmark because we kept real URLs. Could be tightened — wrap `walrus_client` in `Option` and skip construction in benchmark mode.

**Good**: Cleanup on shutdown correctly handles the `Option<Child>` for sidecar.

---

## 5. Behavioral Differences Worth Noting

### Quota consumption uses plaintext size, not encrypted size

In `remember` line 161-162:
```rust
let text_bytes = text.as_bytes().len() as i64;
rate_limit::check_storage_quota(&state, owner, text_bytes).await?;
```

This runs in both modes — but in production, the actual stored size is the **encrypted** size (always larger than plaintext due to SEAL overhead). So:
- Benchmark quota consumption: accurate (matches stored plaintext size)
- Production quota consumption: under-reports by ~20-40% (text_bytes < encrypted_bytes)

This is a pre-existing inconsistency, not introduced by benchmark mode. Just observing it.

### Dedup in Stage 4 is less efficient in benchmark mode

Production (branched):
```rust
let mut blob_to_ids: HashMap<String, Vec<String>> = HashMap::new();
// ... dedup by blob_id, fetch once per unique blob
```

Benchmark:
```rust
for (id, _blob_id) in &unique_old_memories {
    state.db.fetch_plaintext(id).await;
}
// N DB queries instead of M deduped queries
```

In benchmark mode, each memory has a unique `bench:{uuid}` blob_id — no actual duplicates to dedup across. So the production dedup optimization is moot here, but the benchmark path does N individual queries. This is a tiny performance wart (~1ms per query × 5 queries per fact = negligible), not a correctness issue.

### No cleanup_expired_blob in benchmark mode

In production recall, if Walrus returns "blob expired," the row is reactively soft-deleted:
```rust
Err(AppError::BlobNotFound(msg)) => {
    cleanup_expired_blob(db, &blob_id).await;
    return None;
}
```

In benchmark mode, a missing plaintext column results in just a warning:
```rust
Ok(None) => {
    tracing::warn!("Benchmark row missing plaintext: {}", blob_id);
    None
}
```

This is correct behavior — there's no "expiration" concept for benchmark rows. They either have plaintext (happy path) or don't (something went wrong, but deleting them would be premature).

---

## 6. Safety Analysis

### What happens if BENCHMARK_MODE=true is accidentally set in production?

1. Server starts, logs warning banner: `BENCHMARK_MODE=true — blockchain layer DISABLED`
2. Sidecar doesn't start
3. First real write to `/api/analyze` or `/api/remember` writes plaintext to DB
4. No SEAL encryption, no Walrus upload
5. Production data sits decrypted in Postgres

**This is bad but observable**:
- The warning banner is hard to miss in logs
- The blob_id column shows `bench:*` prefixes (immediately visible in any DB inspection)
- Recall on those rows would work but skip encryption/decryption

The banner is the primary defense. We could add a second layer: refuse to start benchmark mode if `SUI_NETWORK=mainnet`. Would you like that?

### What happens if BENCHMARK_MODE=false but production DB has bench:* rows?

Recall on those rows would try `walrus::download_blob("bench:uuid")`, which Walrus would reject (invalid blob ID format). The recall task returns `None` for that hit. Other hits work normally. Graceful degradation.

### What happens if a benchmark run is aborted mid-ingestion?

The DB has partial benchmark rows. No corruption — rows are complete (they're atomic DB inserts, no reserve-then-upload dance in benchmark mode). Rerun with `--skip-ingest --run-id <same>` correctly reuses them.

---

## 7. Recommendations

### Must-fix before shipping this feature
None. The benchmark ran correctly end-to-end.

### Should-fix before someone else uses benchmark mode
1. **Branch the remaining endpoints** (`ask`, `restore`, `remember_manual`, standalone consolidate decrypt). Currently they'd fail loudly if hit with `bench:*` data, which is not a data-corruption concern but is a poor developer experience.
2. **Add a refusal check in `main.rs`**: if `BENCHMARK_MODE=true` and `SUI_NETWORK=mainnet`, panic at startup. Belt-and-braces against accidents.

### Nice-to-have
3. Skip `walrus_client` construction in benchmark mode (wrap in `Option`).
4. Clean up the indentation on the `recall` branch (lines 356-395 have leftover nested indentation from the old nested match).

---

## 8. Verdict

**The toggle works correctly for the LOCOMO benchmark we ran.** All code paths exercised during the run are properly branched. The scoring formula receives identical inputs in both modes — so the J-scores reported are a faithful measure of MemWal's retrieval quality.

**The toggle is incomplete for endpoints outside our benchmark scope.** Four endpoints (`ask`, `restore`, `remember_manual`, standalone `consolidate` decrypt) still reference SEAL/Walrus unconditionally. They'd fail if someone tried to use them on benchmark data. This is fixable with ~20 more lines in routes.rs.

**Data isolation is tight.** Namespace-scoped queries + `bench:*` blob_id prefix + nullable plaintext column give three independent ways to distinguish benchmark from production data. A production server switched to benchmark mode wouldn't corrupt existing data — it would just start writing new plaintext rows alongside.

**No correctness concerns for the benchmark results.** The 52/51/50 J-scores accurately represent the retrieval quality of MemWal's memory pipeline. The gap to Mem0 (55-73) is real, and the finding that composite scoring underperforms baseline on LOCOMO is valid.
