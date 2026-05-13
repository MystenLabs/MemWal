-- MEM-35: Collapse per-wallet Apalis queues into a single `wallet_jobs` queue.
--
-- Background: the server used to create N queues named `wallet-{i}` (one per
-- pool key) to side-step Sui coin-object equivocation locks. Per Will Bradley
-- (Mysten, 2026-05-12 Slack callout): coin-object locking is no longer a
-- practical concern on Sui. A single queue + concurrent workers + retry
-- handling at the Apalis layer (Transient/Permanent classification) is
-- sufficient.
--
-- Retryable rows from old per-wallet queues need their `job_type` (Apalis
-- namespace = queue name) rewritten so the new single worker can pick them up.
-- Terminal rows (Done / Killed) keep their old name as historical record.
-- Running rows can otherwise remain locked by old `wallet-{i}` workers after
-- an interrupted deploy. Requeue them explicitly on the new namespace.
--
-- The DO block guards against the case where this migration is applied
-- before the Apalis `setup()` runs and the `apalis.jobs` table doesn't exist
-- yet (e.g., on a brand-new database). In that case there's nothing to
-- migrate; Apalis will create the table later with the new queue name.
DO $$
BEGIN
    IF to_regclass('apalis.jobs') IS NOT NULL THEN
        UPDATE apalis.jobs
        SET job_type = 'wallet_jobs'
        WHERE job_type LIKE 'wallet-%' AND status IN ('Pending', 'Failed');

        UPDATE apalis.jobs
        SET job_type = 'wallet_jobs',
            status = 'Pending',
            lock_by = NULL,
            lock_at = NULL,
            done_at = NULL,
            last_error = COALESCE(last_error, 'Requeued during wallet queue migration')
        WHERE job_type LIKE 'wallet-%' AND status = 'Running';
    END IF;
END $$;
