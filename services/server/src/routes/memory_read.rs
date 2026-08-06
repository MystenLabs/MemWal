//! GET /v1/owners/{owner}/namespaces|memories|agents — owner-scoped,
//! cursor-paginated read API (WALM-295). See docs/superpowers/specs/
//! 2026-08-04-memory-read-api-design.md.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use base64::Engine as _;
use serde::Serialize;
use sqlx::PgPool;
use std::sync::Arc;

use crate::types::*;

#[derive(Debug, Serialize)]
pub struct NamespaceSummary {
    pub id: String,
    pub name: String,
    pub memory_count: i64,
    pub storage_used: i64,
    /// `MAX(updated_at)` across the namespace's rows — the same value the
    /// keyset cursor is built from. Exposed (not just baked into the opaque
    /// cursor) so Console can tell *what* changed, not merely that its
    /// watermark moved.
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
pub struct NamespacesResponse {
    pub namespaces: Vec<NamespaceSummary>,
    pub next_cursor: Option<String>,
    /// Explicit end-of-data signal. A page shorter than the requested
    /// `limit` does NOT reliably mean "no more data" — the server silently
    /// clamps `limit` to `MAX_NAMESPACES_LIMIT`, so a caller that asked for
    /// more than the cap and got exactly the cap back would wrongly
    /// conclude it was done. Use this field, not page length, to decide
    /// whether to keep paginating.
    pub has_more: bool,
    pub snapshot_version: u32,
}

#[derive(Debug, Serialize)]
pub struct MemoryItem {
    pub memory_id: String,
    pub namespace_id: String,
    pub blob_id: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// The row's `updated_at` — the same value this page's keyset cursor is
    /// built from. It was already being fetched purely to encode the cursor;
    /// surfacing it lets Console diff by row instead of trusting an opaque
    /// token.
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub size: i64,
    pub agent_id: Option<String>,
    pub package_id: Option<String>,
    pub status: &'static str,
}

#[derive(Debug, Serialize)]
pub struct MemoriesResponse {
    pub memories: Vec<MemoryItem>,
    pub next_cursor: Option<String>,
    /// Explicit end-of-data signal — see `NamespacesResponse::has_more`'s
    /// doc comment; same reasoning applies (`limit` is silently clamped to
    /// `MAX_MEMORIES_LIMIT`).
    pub has_more: bool,
    pub snapshot_version: u32,
}

/// Bumped 1 -> 2: the `/namespaces` cursor changed wire format (bare
/// namespace name -> `(updated_at, namespace)` watermark, so a v1 cursor is
/// not decodable as a v2 one) and both `/namespaces` and `/memories` rows
/// gained an `updated_at` field.
pub const SNAPSHOT_VERSION: u32 = 2;

const DEFAULT_NAMESPACES_LIMIT: i64 = 100;
const MAX_NAMESPACES_LIMIT: i64 = 500;

/// Keyset watermark over the namespace rollup, mirroring `MemoriesCursor`'s
/// `(updated_at, id)` shape with the rollup's `(MAX(updated_at), namespace)`.
///
/// The previous cursor was the bare namespace name, ordered by `namespace`
/// alone. That is a valid *traversal* cursor but a useless *sync* cursor: a
/// namespace that sorts before the cursor can never reappear, so a later
/// write that changes its `memory_count`/`storage_used` stays invisible to
/// a polling client forever. Ordering by the rollup's own recency instead
/// means any namespace touched after the client's watermark sorts after it
/// and is returned on the next poll, however early its name sorts.
/// `namespace` remains as the tie-break (it is unique per `GROUP BY` row)
/// so equal `MAX(updated_at)` values still paginate without gaps or repeats.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct NamespacesCursor {
    updated_at: chrono::DateTime<chrono::Utc>,
    namespace: String,
}

fn encode_namespaces_cursor(updated_at: chrono::DateTime<chrono::Utc>, namespace: &str) -> String {
    let json = serde_json::to_vec(&NamespacesCursor {
        updated_at,
        namespace: namespace.to_string(),
    })
    .expect("cursor serializes");
    // Same URL_SAFE_NO_PAD rationale as `encode_cursor` below — this value is
    // echoed back verbatim as `next_cursor` and used in a URL query string.
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
}

fn decode_namespaces_cursor(raw: &str) -> Result<NamespacesCursor, AppError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| AppError::BadRequest("invalid cursor".to_string()))?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::BadRequest("invalid cursor".to_string()))
}

/// `updated_after`/`cursor` here is the opaque `next_cursor` a previous call
/// returned (never a raw timestamp or namespace name), mirroring how
/// `memories`' `updated_after` behaves. Unlike the previous namespace-name
/// cursor it is a genuine incremental-sync watermark: rows are ordered and
/// filtered by the rollup's `(MAX(updated_at), namespace)`, so a namespace
/// whose contents changed after the client's last poll comes back even
/// though it was already synced once — see `NamespacesCursor`.
///
/// The recency half of the keyset predicate has to stay in `HAVING`: it
/// filters on `MAX(updated_at)`, an aggregate, which by definition cannot be
/// evaluated before the `GROUP BY`. Note this is the opposite of the usual
/// advice to push a `HAVING` predicate down into `WHERE` (which the previous
/// `HAVING namespace > $2` should have followed, since `namespace` is a
/// grouping key and needs no aggregation): rewriting *this* one as
/// `WHERE updated_at > $cursor` would drop individual *rows* before
/// aggregation, so `memory_count`/`storage_used` would then cover only each
/// namespace's recently-touched subset — wrong totals, not merely a
/// different plan.
pub(crate) async fn query_owner_namespaces(
    pool: &PgPool,
    owner: &str,
    cursor: Option<String>,
    limit: i64,
) -> Result<NamespacesResponse, AppError> {
    let limit = limit.clamp(1, MAX_NAMESPACES_LIMIT);

    // Peek one row past `limit` to get an explicit has_more signal — a page
    // shorter than `limit` is NOT a reliable "no more data" signal on its
    // own, because `limit` is silently clamped to MAX_NAMESPACES_LIMIT: a
    // caller that asked for more than the cap and got exactly the cap back
    // would otherwise wrongly conclude it was done.
    let mut rows: Vec<(String, i64, i64, chrono::DateTime<chrono::Utc>)> =
        if let Some(raw_cursor) = cursor {
            let c = decode_namespaces_cursor(&raw_cursor)?;
            sqlx::query_as(
                "SELECT namespace, COUNT(*) AS memory_count, COALESCE(SUM(blob_size_bytes), 0)::BIGINT AS storage_used, MAX(updated_at) AS last_updated_at
                 FROM vector_entries
                 WHERE owner = $1
                 GROUP BY namespace
                 HAVING (MAX(updated_at), namespace) > ($2, $3)
                 ORDER BY MAX(updated_at), namespace
                 LIMIT $4",
            )
            .bind(owner)
            .bind(c.updated_at)
            .bind(c.namespace)
            .bind(limit + 1)
            .fetch_all(pool)
            .await
        } else {
            sqlx::query_as(
                "SELECT namespace, COUNT(*) AS memory_count, COALESCE(SUM(blob_size_bytes), 0)::BIGINT AS storage_used, MAX(updated_at) AS last_updated_at
                 FROM vector_entries
                 WHERE owner = $1
                 GROUP BY namespace
                 ORDER BY MAX(updated_at), namespace
                 LIMIT $2",
            )
            .bind(owner)
            .bind(limit + 1)
            .fetch_all(pool)
            .await
        }
        .map_err(|e| AppError::Internal(format!("Failed to query namespaces: {}", e)))?;

    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);

    // Always hand back a watermark built from the LAST ROW EMITTED (never
    // the peeked extra row above), whether or not more pages follow.
    // Returning `None` on the final page left a client that had just
    // finished syncing with no checkpoint to poll from next time — which is
    // the entire point of the cursor. The only cursor-less case is an empty
    // page: there is no row to take a watermark from, so the client keeps
    // the one it already has.
    let next_cursor = rows
        .last()
        .map(|(name, _, _, last_updated_at)| encode_namespaces_cursor(*last_updated_at, name));

    let namespaces = rows
        .into_iter()
        .map(
            |(name, memory_count, storage_used, updated_at)| NamespaceSummary {
                id: name.clone(),
                name,
                memory_count,
                storage_used,
                updated_at,
            },
        )
        .collect();

    Ok(NamespacesResponse {
        namespaces,
        next_cursor,
        has_more,
        snapshot_version: SNAPSHOT_VERSION,
    })
}

/// GET /v1/owners/{owner}/namespaces?updated_after=<cursor>&limit=100
pub async fn list_owner_namespaces(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(path_owner): Path<String>,
    params: MemoriesQuery,
) -> Result<Json<NamespacesResponse>, AppError> {
    if auth.owner != path_owner {
        return Err(AppError::Forbidden("owner mismatch".to_string()));
    }
    let limit = params.limit.unwrap_or(DEFAULT_NAMESPACES_LIMIT);
    if limit < 1 {
        return Err(AppError::BadRequest("limit must be positive".to_string()));
    }
    let result =
        query_owner_namespaces(state.db.pool(), &auth.owner, params.updated_after, limit).await?;
    Ok(Json(result))
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct MemoriesCursor {
    updated_at: chrono::DateTime<chrono::Utc>,
    id: String,
}

fn encode_cursor(updated_at: chrono::DateTime<chrono::Utc>, id: &str) -> String {
    let json = serde_json::to_vec(&MemoriesCursor {
        updated_at,
        id: id.to_string(),
    })
    .expect("cursor serializes");
    // URL_SAFE_NO_PAD (not STANDARD): next_cursor is used verbatim in a URL
    // query string per the contract doc. STANDARD emits `+`, `/`, `=`, which
    // corrupt or require percent-encoding most clients won't apply.
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
}

fn decode_cursor(raw: &str) -> Result<MemoriesCursor, AppError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| AppError::BadRequest("invalid cursor".to_string()))?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::BadRequest("invalid cursor".to_string()))
}

const DEFAULT_MEMORIES_LIMIT: i64 = 100;
const MAX_MEMORIES_LIMIT: i64 = 500;

pub(crate) async fn query_owner_memories(
    pool: &PgPool,
    owner: &str,
    cursor: Option<String>,
    limit: i64,
) -> Result<MemoriesResponse, AppError> {
    let limit = limit.clamp(1, MAX_MEMORIES_LIMIT);

    // Peek one row past `limit` for an explicit has_more signal — see
    // query_owner_namespaces's identical comment on why page-length alone
    // (vs. the clamped limit) isn't a reliable end-of-data signal.
    #[allow(clippy::type_complexity)]
    let mut rows: Vec<(
        String,
        String,
        String,
        chrono::DateTime<chrono::Utc>,
        chrono::DateTime<chrono::Utc>,
        i64,
        Option<String>,
        Option<String>,
    )> = if let Some(raw_cursor) = cursor {
        let c = decode_cursor(&raw_cursor)?;
        sqlx::query_as(
            "SELECT id, namespace, blob_id, created_at, updated_at, blob_size_bytes, agent_id, package_id
             FROM vector_entries
             WHERE owner = $1 AND (updated_at, id) > ($2, $3)
             ORDER BY updated_at, id
             LIMIT $4",
        )
        .bind(owner)
        .bind(c.updated_at)
        .bind(c.id)
        .bind(limit + 1)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query_as(
            "SELECT id, namespace, blob_id, created_at, updated_at, blob_size_bytes, agent_id, package_id
             FROM vector_entries
             WHERE owner = $1
             ORDER BY updated_at, id
             LIMIT $2",
        )
        .bind(owner)
        .bind(limit + 1)
        .fetch_all(pool)
        .await
    }
    .map_err(|e| AppError::Internal(format!("Failed to query memories: {}", e)))?;

    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);

    // Same watermark rule as `query_owner_namespaces`: the cursor always
    // comes from the last row emitted (never the peeked extra row above), so
    // the final (or only) page still checkpoints the client for its next
    // incremental poll. Only an empty page has no cursor, because it has no
    // row to build one from.
    let next_cursor = rows.last().map(|r| encode_cursor(r.4, &r.0));

    let memories = rows
        .into_iter()
        .map(
            |(id, namespace, blob_id, created_at, updated_at, size, agent_id, package_id)| {
                MemoryItem {
                    memory_id: id,
                    namespace_id: namespace,
                    blob_id,
                    created_at,
                    updated_at,
                    size,
                    agent_id,
                    package_id,
                    // Always "active" until Plan B (WALM-296) adds expires_at
                    // and derives this from it.
                    status: "active",
                }
            },
        )
        .collect();

    Ok(MemoriesResponse {
        memories,
        next_cursor,
        has_more,
        snapshot_version: SNAPSHOT_VERSION,
    })
}

#[derive(Debug, serde::Deserialize)]
pub struct MemoriesQuery {
    pub updated_after: Option<String>,
    pub limit: Option<i64>,
}

// A plain `axum::extract::Query<MemoriesQuery>` param would reject an
// unparseable `limit` (e.g. `limit=abc`) with Axum's own default
// QueryRejection — a plain-text 400, not this API's `{"error": ...}`
// JSON envelope, and invisible to `record_app_error` metrics. The
// codebase already has a precedent for exactly this problem
// (`SdQuery<T>` in `services/server/src/security_delete_error.rs`,
// mapping `QueryRejection` to that module's own error type) — this
// mirrors the same idea, mapped to `AppError` instead.
impl<S> axum::extract::FromRequestParts<S> for MemoriesQuery
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        axum::extract::Query::<MemoriesQuery>::from_request_parts(parts, state)
            .await
            .map(|axum::extract::Query(q)| q)
            .map_err(|_| AppError::BadRequest("invalid query parameters".to_string()))
    }
}

/// GET /v1/owners/{owner}/memories?updated_after=<cursor>&limit=100
pub async fn list_owner_memories(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(path_owner): Path<String>,
    params: MemoriesQuery,
) -> Result<Json<MemoriesResponse>, AppError> {
    if auth.owner != path_owner {
        return Err(AppError::Forbidden("owner mismatch".to_string()));
    }
    let limit = params.limit.unwrap_or(DEFAULT_MEMORIES_LIMIT);
    if limit < 1 {
        return Err(AppError::BadRequest("limit must be positive".to_string()));
    }
    let result =
        query_owner_memories(state.db.pool(), &auth.owner, params.updated_after, limit).await?;
    Ok(Json(result))
}

#[derive(Debug, Serialize)]
pub struct DelegateKeyResponse {
    pub label: String,
    pub sui_address: String,
}

#[derive(Debug, Serialize)]
pub struct AgentsResponse {
    pub agents: Vec<DelegateKeyResponse>,
    pub snapshot_version: u32,
}

/// GET /v1/owners/{owner}/agents
pub async fn list_owner_agents(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(path_owner): Path<String>,
) -> Result<Json<AgentsResponse>, AppError> {
    if auth.owner != path_owner {
        return Err(AppError::Forbidden("owner mismatch".to_string()));
    }
    // Short-TTL cached read (WALM-295 design spec: "Cached with the same
    // short TTL pattern as walrus_epoch() ... rather than left uncached") —
    // repeated /agents calls for the same account within the TTL window
    // don't re-hit the chain.
    let keys = crate::storage::sui::list_delegate_keys_cached(
        &state.delegate_keys_cache,
        &state.http_client,
        &state.config.sui_rpc_url,
        state.sui_grpc_client.as_ref(),
        &auth.account_id,
        &state.config.package_id,
    )
    .await
    .map_err(|e| AppError::Internal(format!("Failed to list delegate keys: {}", e)))?;

    let agents = keys
        .into_iter()
        .map(|k| DelegateKeyResponse {
            label: k.label,
            sui_address: k.sui_address,
        })
        .collect();

    Ok(Json(AgentsResponse {
        agents,
        snapshot_version: SNAPSHOT_VERSION,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgPoolOptions;
    use std::sync::OnceLock;

    // Guards concurrent test threads in THIS module from racing on
    // `CREATE EXTENSION IF NOT EXISTS vector` (001_init.sql) — Postgres
    // does not make that statement safe under concurrent execution
    // despite IF NOT EXISTS (two sessions can both pass the existence
    // check before either commits, then collide on the unique index on
    // pg_extension). Mirrors the same pattern already used in
    // `services/server/src/jobs.rs` (`DB_SETUP_LOCK`) and
    // `services/server/src/storage/db.rs` (`VECTOR_SCHEMA_SETUP_LOCK`).
    static DB_SETUP_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

    fn test_database_url() -> String {
        std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgresql://memwal:memwal_secret@localhost:5432/memwal".into())
    }

    async fn test_pool() -> PgPool {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&test_database_url())
            .await
            .unwrap();
        let _guard = DB_SETUP_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        for migration in [
            include_str!("../../migrations/001_init.sql"),
            include_str!("../../migrations/002_add_namespace.sql"),
            include_str!("../../migrations/003_rate_limiter.sql"),
            include_str!("../../migrations/008_benchmark_plaintext.sql"),
            include_str!("../../migrations/009_importance_signal.sql"),
            include_str!("../../migrations/010_memory_read_api_columns.sql"),
            include_str!("../../migrations/011_memory_read_api_backfill_updated_at.sql"),
            include_str!("../../migrations/012_memory_read_api_updated_at_not_null.sql"),
            include_str!("../../migrations/013_memory_read_api_index.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }
        pool
    }

    /// `next_cursor` is used verbatim in a URL query string per the contract
    /// doc (`?updated_after=<cursor>`) — it must never contain `+`, `/`, or
    /// `=`, which `base64::engine::general_purpose::STANDARD` emits and most
    /// clients won't percent-encode automatically. Search over ids/timestamps
    /// until we find a byte sequence that STANDARD would have encoded with at
    /// least one of those characters, then assert our actual `encode_cursor`
    /// (URL_SAFE_NO_PAD) output round-trips through `decode_cursor` and is
    /// clean of all three.
    #[test]
    fn encode_cursor_is_url_safe_and_round_trips() {
        use base64::Engine as _;

        let mut found_standard_unsafe_case = false;
        for i in 0..500 {
            let id = format!("memory-id-{i}-{}", uuid::Uuid::new_v4());
            let updated_at =
                chrono::DateTime::from_timestamp(1_700_000_000 + i, (i as u32) * 137).unwrap();

            // Sanity check: prove this fixture would have been unsafe under
            // the old STANDARD engine, so the test is actually exercising the
            // bug, not just trivially passing on inputs that never collide.
            let json = serde_json::to_vec(&MemoriesCursor {
                updated_at,
                id: id.clone(),
            })
            .expect("cursor serializes");
            let standard_encoded = base64::engine::general_purpose::STANDARD.encode(&json);
            if standard_encoded.contains('+')
                || standard_encoded.contains('/')
                || standard_encoded.contains('=')
            {
                found_standard_unsafe_case = true;
            }

            let encoded = encode_cursor(updated_at, &id);
            assert!(
                !encoded.contains('+') && !encoded.contains('/') && !encoded.contains('='),
                "encoded cursor must be URL-safe with no padding, got: {}",
                encoded
            );

            let decoded = decode_cursor(&encoded).expect("round-trips");
            assert_eq!(decoded.id, id);
            assert_eq!(decoded.updated_at, updated_at);
        }

        assert!(
            found_standard_unsafe_case,
            "fixture sweep never produced a STANDARD-unsafe cursor — test would not \
             have caught the regression this fix addresses"
        );
    }

    fn ts(offset_secs: i64) -> chrono::DateTime<chrono::Utc> {
        // Whole seconds only: Postgres `timestamptz` keeps microseconds, so a
        // sub-microsecond chrono value would not survive the round trip and
        // exact-equality assertions below would be flaky.
        chrono::DateTime::from_timestamp(1_700_000_000 + offset_secs, 0).unwrap()
    }

    async fn seed_entry(
        pool: &PgPool,
        owner: &str,
        id: &str,
        namespace: &str,
        size: i64,
        updated_at: chrono::DateTime<chrono::Utc>,
    ) {
        sqlx::query(
            "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(format!("{}-{}", owner, id))
        .bind(owner)
        .bind(namespace)
        .bind(format!("blob-{}", id))
        .bind(pgvector::Vector::from(vec![0.0_f32; 1536]))
        .bind(size)
        .bind(updated_at)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn cleanup(pool: &PgPool, owner: &str) {
        let _ = sqlx::query("DELETE FROM vector_entries WHERE owner = $1")
            .bind(owner)
            .execute(pool)
            .await;
    }

    #[tokio::test]
    async fn query_owner_namespaces_rolls_up_counts_bytes_and_max_updated_at() {
        let pool = test_pool().await;
        let owner = format!("0xtest-{}", uuid::Uuid::new_v4());

        // `work`'s two rows deliberately straddle `personal`'s single row in
        // time, so `updated_at` on the summary can only be right if it is the
        // group's MAX (not its first, last-inserted, or min row).
        seed_entry(&pool, &owner, "m1", "work", 100, ts(0)).await;
        seed_entry(&pool, &owner, "m3", "personal", 50, ts(60)).await;
        seed_entry(&pool, &owner, "m2", "work", 200, ts(120)).await;

        let result = query_owner_namespaces(&pool, &owner, None, 100)
            .await
            .unwrap();

        // Emission order is the keyset order — (MAX(updated_at), namespace) —
        // so `personal` (t+60) precedes `work` (t+120) despite sorting after
        // it alphabetically.
        assert_eq!(
            result
                .namespaces
                .iter()
                .map(|n| n.name.as_str())
                .collect::<Vec<_>>(),
            vec!["personal", "work"],
        );

        let mut sorted = result.namespaces;
        sorted.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(sorted.len(), 2);
        assert_eq!(sorted[0].name, "personal");
        assert_eq!(sorted[0].memory_count, 1);
        assert_eq!(sorted[0].storage_used, 50);
        assert_eq!(sorted[0].updated_at, ts(60));
        assert_eq!(sorted[1].name, "work");
        assert_eq!(sorted[1].memory_count, 2);
        assert_eq!(sorted[1].storage_used, 300);
        assert_eq!(
            sorted[1].updated_at,
            ts(120),
            "namespace updated_at must be MAX(updated_at) over the group"
        );

        // A result that fits in one page is exactly the case that most needs a
        // checkpoint: the client is caught up and its next poll has nothing
        // else to anchor on.
        let cursor = result
            .next_cursor
            .expect("a non-empty page must always hand back a watermark");
        let decoded = decode_namespaces_cursor(&cursor).unwrap();
        assert_eq!(decoded.namespace, "work");
        assert_eq!(decoded.updated_at, ts(120));

        cleanup(&pool, &owner).await;
    }

    /// The bug this whole cursor redesign exists for: under the old
    /// namespace-name cursor (`ORDER BY namespace` / `HAVING namespace >
    /// $cursor`), a namespace that sorts *before* the cursor could never be
    /// returned again — so a later write that changed its rollup was
    /// invisible to a polling client forever. Here `alpha` sorts before the
    /// cursor's `zulu` but is updated after the cursor's watermark, and must
    /// come back. A regression test that only checked ordering/no-duplicates
    /// would pass against the old buggy code.
    #[tokio::test]
    async fn query_owner_namespaces_cursor_resurfaces_earlier_name_updated_after_watermark() {
        let pool = test_pool().await;
        let owner = format!("0xtest-{}", uuid::Uuid::new_v4());

        seed_entry(&pool, &owner, "a1", "alpha", 10, ts(0)).await;
        seed_entry(&pool, &owner, "z1", "zulu", 20, ts(60)).await;

        // First sync: client sees both, checkpoints at (t+60, "zulu").
        let first = query_owner_namespaces(&pool, &owner, None, 100)
            .await
            .unwrap();
        assert_eq!(
            first
                .namespaces
                .iter()
                .map(|n| n.name.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "zulu"],
        );
        let watermark = first.next_cursor.expect("first page must checkpoint");
        assert_eq!(decode_namespaces_cursor(&watermark).unwrap().namespace, "zulu");

        // Now `alpha` — already synced, and alphabetically *before* the
        // cursor's namespace — grows a second memory after that checkpoint.
        seed_entry(&pool, &owner, "a2", "alpha", 90, ts(120)).await;

        let second = query_owner_namespaces(&pool, &owner, Some(watermark), 100)
            .await
            .unwrap();

        assert_eq!(
            second
                .namespaces
                .iter()
                .map(|n| n.name.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha"],
            "a namespace changed after the watermark must reappear even though \
             its name sorts before the cursor's; unchanged namespaces must not"
        );
        assert_eq!(second.namespaces[0].memory_count, 2);
        assert_eq!(second.namespaces[0].storage_used, 100);
        assert_eq!(second.namespaces[0].updated_at, ts(120));

        let next = second
            .next_cursor
            .expect("the follow-up page must checkpoint too");
        let decoded = decode_namespaces_cursor(&next).unwrap();
        assert_eq!(decoded.namespace, "alpha");
        assert_eq!(decoded.updated_at, ts(120));

        // And polling from that fresh watermark with nothing else changed
        // yields an empty page — the one and only cursor-less case.
        let third = query_owner_namespaces(&pool, &owner, Some(next), 100)
            .await
            .unwrap();
        assert!(third.namespaces.is_empty());
        assert!(third.next_cursor.is_none());

        cleanup(&pool, &owner).await;
    }

    #[test]
    fn encode_namespaces_cursor_is_url_safe_and_round_trips() {
        for i in 0..200 {
            let namespace = format!("ns/{i}+{}", uuid::Uuid::new_v4());
            let updated_at =
                chrono::DateTime::from_timestamp(1_700_000_000 + i, (i as u32) * 137).unwrap();

            let encoded = encode_namespaces_cursor(updated_at, &namespace);
            assert!(
                !encoded.contains('+') && !encoded.contains('/') && !encoded.contains('='),
                "encoded cursor must be URL-safe with no padding, got: {}",
                encoded
            );

            let decoded = decode_namespaces_cursor(&encoded).expect("round-trips");
            assert_eq!(decoded.namespace, namespace);
            assert_eq!(decoded.updated_at, updated_at);
        }

        // A v1 cursor (bare base64 of the namespace name) is not a v2 cursor —
        // hence the SNAPSHOT_VERSION bump. It must be rejected as a 400, never
        // silently mis-decoded.
        let v1_cursor = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b"work");
        assert!(matches!(
            decode_namespaces_cursor(&v1_cursor),
            Err(AppError::BadRequest(_))
        ));
    }

    #[tokio::test]
    async fn query_owner_namespaces_empty_for_unknown_owner() {
        let pool = test_pool().await;
        let result = query_owner_namespaces(&pool, "0xnobody-here", None, 100)
            .await
            .unwrap();
        assert!(result.namespaces.is_empty());
        assert!(result.next_cursor.is_none());
    }

    /// Mirrors `query_owner_memories_paginates_by_updated_at_and_id`'s style:
    /// seed multiple namespaces for one owner, walk them with a small limit,
    /// and assert the union of all pages equals the full set exactly once (no
    /// gaps, no duplicates). Update times are deliberately scrambled relative
    /// to name order so the expected sequence is the recency order, not the
    /// alphabetical one.
    #[tokio::test]
    async fn query_owner_namespaces_paginates_by_updated_at_and_namespace_cursor() {
        let pool = test_pool().await;
        let owner = format!("0xtest-{}", uuid::Uuid::new_v4());

        for (ns, offset) in [
            ("alpha", 40),
            ("bravo", 10),
            ("charlie", 50),
            ("delta", 20),
            ("echo", 30),
        ] {
            seed_entry(&pool, &owner, ns, ns, 10, ts(offset)).await;
        }

        let mut all_names: Vec<String> = Vec::new();
        let mut cursor = None;
        // Bounded: with an always-present watermark the traversal now ends on
        // an empty page, so an unbounded `while cursor.is_some()` would spin
        // forever if the keyset predicate ever stopped advancing.
        for _ in 0..10 {
            let page = query_owner_namespaces(&pool, &owner, cursor.clone(), 2)
                .await
                .unwrap();
            assert!(page.namespaces.len() <= 2);
            if page.namespaces.is_empty() {
                assert!(
                    page.next_cursor.is_none(),
                    "an empty page is the only case with no watermark"
                );
                break;
            }
            all_names.extend(page.namespaces.iter().map(|n| n.name.clone()));
            cursor = Some(
                page.next_cursor
                    .expect("every non-empty page must hand back a watermark"),
            );
        }

        assert_eq!(
            all_names,
            vec!["bravo", "delta", "echo", "alpha", "charlie"],
            "pages must follow (MAX(updated_at), namespace) order with no gaps \
             or duplicates"
        );

        cleanup(&pool, &owner).await;
    }

    /// Bug 2 for `/namespaces`, isolated: a page that exactly fills `limit`
    /// (so the old `has_more` peek would have said "no more") still has to
    /// return the watermark, and re-polling from it yields the empty page.
    #[tokio::test]
    async fn query_owner_namespaces_exactly_fitting_page_still_returns_watermark() {
        let pool = test_pool().await;
        let owner = format!("0xtest-{}", uuid::Uuid::new_v4());

        seed_entry(&pool, &owner, "n1", "one", 10, ts(0)).await;
        seed_entry(&pool, &owner, "n2", "two", 10, ts(60)).await;

        let page = query_owner_namespaces(&pool, &owner, None, 2).await.unwrap();
        assert_eq!(page.namespaces.len(), 2);
        let cursor = page
            .next_cursor
            .expect("an exactly-full final page must still checkpoint the client");
        assert_eq!(decode_namespaces_cursor(&cursor).unwrap().namespace, "two");

        let empty = query_owner_namespaces(&pool, &owner, Some(cursor), 2)
            .await
            .unwrap();
        assert!(empty.namespaces.is_empty());
        assert!(empty.next_cursor.is_none());

        cleanup(&pool, &owner).await;
    }

    /// Reproduces a real bug found in review: `limit` is silently clamped
    /// to `MAX_NAMESPACES_LIMIT` (500), so a caller asking for more than
    /// that gets exactly 500 rows back — a page SHORTER than the `limit`
    /// it requested, which a client using "short page = done" as its only
    /// signal would wrongly treat as end-of-data even though a 501st
    /// namespace exists. `has_more` must say `true` here.
    #[tokio::test]
    async fn query_owner_namespaces_has_more_true_when_limit_is_clamped() {
        let pool = test_pool().await;
        let owner = format!("0xtest-{}", uuid::Uuid::new_v4());

        for i in 0..(MAX_NAMESPACES_LIMIT + 1) {
            seed_entry(
                &pool,
                &owner,
                &format!("n{i}"),
                &format!("ns-{i:04}"),
                10,
                ts(i),
            )
            .await;
        }

        let page = query_owner_namespaces(&pool, &owner, None, 10_000)
            .await
            .unwrap();
        assert_eq!(
            page.namespaces.len(),
            MAX_NAMESPACES_LIMIT as usize,
            "limit=10000 must be clamped to MAX_NAMESPACES_LIMIT"
        );
        assert!(
            page.has_more,
            "a clamped-short page must still report has_more=true — page length alone is not a reliable end-of-data signal"
        );
        assert!(page.next_cursor.is_some());

        cleanup(&pool, &owner).await;
    }

    #[tokio::test]
    async fn query_owner_memories_paginates_by_updated_at_and_id() {
        let pool = test_pool().await;
        let owner = format!("0xtest-{}", uuid::Uuid::new_v4());

        for i in 0..5 {
            sqlx::query(
                "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes, agent_id, package_id)
                 VALUES ($1, $2, 'default', $3, $4, $5, $6, $7)",
            )
            .bind(format!("{}-m{}", owner, i))
            .bind(&owner)
            .bind(format!("blob-{}", i))
            .bind(pgvector::Vector::from(vec![0.0_f32; 1536]))
            .bind(10_i64)
            .bind(format!("agent-{}", i))
            .bind("0xpkg")
            .execute(&pool)
            .await
            .unwrap();
        }

        let page1 = query_owner_memories(&pool, &owner, None, 2).await.unwrap();
        assert_eq!(page1.memories.len(), 2);
        assert!(page1.next_cursor.is_some());

        let page2 = query_owner_memories(&pool, &owner, page1.next_cursor.clone(), 2)
            .await
            .unwrap();
        assert_eq!(page2.memories.len(), 2);

        let page3 = query_owner_memories(&pool, &owner, page2.next_cursor.clone(), 2)
            .await
            .unwrap();
        assert_eq!(page3.memories.len(), 1);
        // Short final page: still a checkpoint, not `None` — that is the
        // client's anchor for its next incremental poll.
        let terminal = page3
            .next_cursor
            .clone()
            .expect("the last page of a traversal must still hand back a watermark");
        let decoded = decode_cursor(&terminal).unwrap();
        assert_eq!(decoded.id, page3.memories[0].memory_id);
        assert_eq!(decoded.updated_at, page3.memories[0].updated_at);

        // Polling again from that watermark with nothing new written is the
        // only case that legitimately has no cursor.
        let page4 = query_owner_memories(&pool, &owner, Some(terminal), 2)
            .await
            .unwrap();
        assert!(page4.memories.is_empty());
        assert!(page4.next_cursor.is_none());

        let mut all_ids: Vec<String> = page1
            .memories
            .iter()
            .chain(page2.memories.iter())
            .chain(page3.memories.iter())
            .map(|m| m.memory_id.clone())
            .collect();
        all_ids.sort();
        all_ids.dedup();
        assert_eq!(
            all_ids.len(),
            5,
            "pagination must not skip or duplicate rows"
        );

        assert_eq!(page1.memories[0].agent_id.as_deref(), Some("agent-0"));
        assert_eq!(page1.memories[0].status, "active");

        cleanup(&pool, &owner).await;
    }

    /// Bug 2 for `/memories`, isolated: an exactly-`limit`-sized result set
    /// (the old peek-based `has_more` would have reported "no more") still
    /// returns a watermark, and that watermark is built from the last EMITTED
    /// row. Also pins the newly exposed `updated_at` field to the row's real
    /// value.
    #[tokio::test]
    async fn query_owner_memories_exactly_fitting_page_still_returns_watermark() {
        let pool = test_pool().await;
        let owner = format!("0xtest-{}", uuid::Uuid::new_v4());

        seed_entry(&pool, &owner, "e1", "default", 10, ts(0)).await;
        seed_entry(&pool, &owner, "e2", "default", 10, ts(60)).await;

        let page = query_owner_memories(&pool, &owner, None, 2).await.unwrap();
        assert_eq!(page.memories.len(), 2);
        assert_eq!(page.memories[0].updated_at, ts(0));
        assert_eq!(page.memories[1].updated_at, ts(60));

        let cursor = page
            .next_cursor
            .expect("an exactly-full final page must still checkpoint the client");
        let decoded = decode_cursor(&cursor).unwrap();
        assert_eq!(
            decoded.id, page.memories[1].memory_id,
            "watermark must come from the last emitted row"
        );
        assert_eq!(decoded.updated_at, ts(60));

        let empty = query_owner_memories(&pool, &owner, Some(cursor), 2)
            .await
            .unwrap();
        assert!(empty.memories.is_empty());
        assert!(empty.next_cursor.is_none());

        cleanup(&pool, &owner).await;
    }

    #[tokio::test]
    async fn query_owner_memories_handles_updated_at_tie_via_id_tiebreak() {
        let pool = test_pool().await;
        let owner = format!("0xtest-{}", uuid::Uuid::new_v4());

        for i in 0..3 {
            sqlx::query(
                "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes)
                 VALUES ($1, $2, 'default', $3, $4, $5)",
            )
            .bind(format!("{}-t{}", owner, i))
            .bind(&owner)
            .bind(format!("blob-t{}", i))
            .bind(pgvector::Vector::from(vec![0.0_f32; 1536]))
            .bind(10_i64)
            .execute(&pool)
            .await
            .unwrap();
        }

        // Force all 3 rows to the exact same updated_at — a real tie,
        // not just three inserts close in time.
        let tied_at = chrono::Utc::now();
        sqlx::query("UPDATE vector_entries SET updated_at = $1 WHERE owner = $2")
            .bind(tied_at)
            .bind(&owner)
            .execute(&pool)
            .await
            .unwrap();

        let mut seen = Vec::new();
        let mut cursor = None;
        for _ in 0..5 {
            let page = query_owner_memories(&pool, &owner, cursor.clone(), 1)
                .await
                .unwrap();
            if page.memories.is_empty() {
                break;
            }
            seen.push(page.memories[0].memory_id.clone());
            cursor = page.next_cursor.clone();
            if cursor.is_none() {
                break;
            }
        }

        seen.sort();
        seen.dedup();
        assert_eq!(
            seen.len(),
            3,
            "all 3 tied rows must appear exactly once across pages, got {:?}",
            seen
        );

        let _ = sqlx::query("DELETE FROM vector_entries WHERE owner = $1")
            .bind(&owner)
            .execute(&pool)
            .await;
    }
}
