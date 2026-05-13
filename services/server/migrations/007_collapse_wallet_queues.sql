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
-- Running rows may be re-enqueued after an interrupted deploy, so migrate them
-- too instead of stranding them on a queue with no worker.
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
        WHERE job_type LIKE 'wallet-%' AND status IN ('Pending', 'Failed', 'Running');
    END IF;
END $$;
