# Migrations

## How this works

There is no migrations table. Every file in this directory is listed
explicitly in `VectorDb::new()` (`services/server/src/storage/db.rs`) via
`include_str!`, and every listed file re-runs, unconditionally, on every
server boot, in the order it's listed. Each statement therefore has to be
idempotent — `IF NOT EXISTS`, `IF EXISTS`, or an explicit guard query —
since it will execute again on every future restart, not just once.

Files are numbered in the order they must run, but a plain `ADD COLUMN`
and an expensive backfill or index build are deliberately kept in
**separate** files even when they touch the same table: `sqlx::raw_sql`
runs everything in one file as a single implicit transaction, and
`CREATE INDEX CONCURRENTLY` in particular cannot run inside a
transaction block at all. Splitting also keeps whatever lock a
migration briefly needs (ACCESS EXCLUSIVE for a plain `ALTER TABLE`,
SHARE UPDATE EXCLUSIVE for `VALIDATE CONSTRAINT`) short and isolated
instead of held for the duration of a slow operation elsewhere in the
same file. See each file's own header comment for its specific
reasoning — migrations 010/012/013/016 walk through a full example of
this pattern for one column.

## The `updated_at` backfill

Migrations 010, 012, 013, and 016 add and finalize
`vector_entries.updated_at` (the cursor column the owner-scoped read
API's keyset pagination depends on). Backfilling that column for
existing rows — copying `created_at` into `updated_at` wherever it's
still `NULL` — is **not** one of those SQL files. It runs as Rust code:
`backfill_updated_at()` in `services/server/src/storage/db.rs`, called
from `VectorDb::new()` right after migration 010 and before migration
012.

It has to be Rust rather than SQL because the backfill needs to commit
in batches, and Postgres has no way to `COMMIT` partway through a
single statement or `DO $$ ... $$` block. A plain
`UPDATE vector_entries SET updated_at = created_at WHERE updated_at IS
NULL` is one atomic statement — on a real-sized table it can run long
enough to hit a statement/idle timeout, and Postgres rolls the *entire*
update back on timeout (no partial commit). Under Railway's restart
policy that becomes a crash-loop with zero net progress: restart →
reconnect → same unbatched UPDATE → same timeout, forever. This was
live-confirmed against the dev DB (113k rows): the single-statement
version could not complete under a short timeout, while the batched
version (5000 rows/iteration) completed in ~281s.

Each batch is its own bare statement against the pool — not wrapped in
an explicit transaction — so it commits independently. If the process
restarts mid-backfill, the next boot resumes near where the last
successful batch left off, because already-backfilled rows no longer
match `WHERE updated_at IS NULL`.

**Operational note:** `VectorDb::new()` awaits the backfill before the
server starts accepting traffic, so the first boot after this column
lands (on any environment with existing rows) has a startup delay
roughly proportional to table size — budget for it against
health-check / deploy-timeout windows. Once every row has a non-NULL
`updated_at`, later boots pay only the cost of one `SELECT` per file
that finds nothing left to update.

There is no `011_*.sql` file. An earlier version of this backfill lived
there as the plain unbatched `UPDATE` described above; once it moved
into Rust, migration 011 became a permanent no-op. Rather than leave a
dead file around or renumber every migration after it, the number was
removed and left unused — see `backfill_updated_at()`'s doc comment for
the full history.
