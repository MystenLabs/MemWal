-- Keep this standalone: CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_remember_jobs_owner_namespace_idempotency_key
    ON remember_jobs (owner, namespace, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
