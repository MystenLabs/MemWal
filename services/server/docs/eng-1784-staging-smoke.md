# ENG-1784 — Staging smoke test procedure

Reviewer requirement #9: force a Permanent remember job failure on
staging and verify the Slack message + DB status.

## Prerequisites

- Staging relayer deployed with this branch (commit a6eb4d2 or newer).
- `SLACK_WEBHOOK_URL` set in staging Railway env (channel of your choice).
- `MEMWAL_ENV=staging` set so the alert footer reads `env staging`.
- Access to the staging Postgres instance via `psql` or a saved client.
- A working Python SDK client (`pip install memwal`) with credentials
  registered on staging.

## Procedure

Pick ONE of the three forcing methods below; they target different
code paths.

### Method A — Force a Permanent classification (cleanest)

The most reliable way to land in `update_remember_job_after_wallet_error`
with `WalletJobError::Permanent` is to make the sidecar return an error
string that classifies as Permanent. The classifier treats any
`MoveAbort(... :: split, 2)` that is NOT preceded by `balance::split`
context as Permanent (see `WalletJobError::classify_sidecar_error`).

1. Temporarily set the staging sidecar's Walrus publisher URL to a
   path that returns a permanent-looking error. The simplest:
   `WALRUS_PUBLISHER_URL=https://httpbin.org/status/418` so the sidecar
   gets a 4xx-class response on every upload.
2. From the Python SDK client:
   ```python
   from memwal import MemWal
   m = MemWal.create(env="staging", key=..., account_id=...)
   await m.remember_and_wait("ENG-1784 staging smoke test " + str(uuid.uuid4()))
   ```
3. Wait ~10 seconds for the Apalis retry budget (`MAX_ATTEMPTS = 3`)
   to burn through.

### Method B — Direct DB injection (skip-the-stack)

If method A is too disruptive, you can call the function path
directly by inserting a row that will be picked up by the worker as
already-failed-permanent. This is brittler but doesn't require
touching staging config.

1. Create a remember job row directly via `psql`:
   ```sql
   INSERT INTO remember_jobs (id, owner, namespace, status)
   VALUES ('staging-smoke-eng1784', '0xstaging-test-owner', 'smoke-test', 'running');
   ```
2. Force an Apalis WalletJob with a payload that the sidecar will
   reject permanently. (Out of scope for this doc — coordinate with
   eng-on-call to issue the right shape.)

### Method C — Live demo of the Slack alerter (bypasses DB)

This verifies the Slack format end-to-end without inducing a real
failure. It does NOT verify the DB persistence side.

```bash
# In a checkout of the eng-1784 branch
cd services/server
SLACK_WEBHOOK_URL=$STAGING_SLACK_WEBHOOK \
  cargo test slack::tests::live_demo_walks_every_alert_scenario \
  --bin memwal-server -- --ignored --nocapture
```

Verifies all 6 scenarios (terminal wallet failure, queue handoff,
dedup, sanitization, multi-byte, global rate cap) land in the channel
without a real relayer needed.

## Verification

### Slack channel

The alert must:

- Start with `🔴 MemWal — Remember Job Failed (terminal wallet failure)`
  in the header for method A.
- Body field "Failure mode" must read `permanent wallet failure after
  3 retry attempts`.
- Must NOT contain the phrase "all wallets exhausted" or "wallet
  retries exhausted" (those are the old, misleading wordings).
- Owner field must be the truncated form `0xstagi…ownr` of whatever
  delegate key was used.
- Namespace field must match the namespace in the python call.
- Footer must read `server commit <sha> · env staging`.
- Error block must NOT contain any password / token / connection
  string — sanitizer must have run.

### Postgres

```sql
SELECT id, status, error_msg, updated_at
  FROM remember_jobs
 WHERE id = '<job_id>';
```

The row must show:

- `status = 'failed'`
- `error_msg` containing the upstream error verbatim (this is what
  on-call needs to triage; sanitization runs ONLY for the Slack
  message, the DB keeps the original).
- `updated_at` newer than the time we triggered the call.

### Suppression behavior

Repeat method A two more times within 5 minutes with the SAME error
message. Slack channel must show only the FIRST alert (dedup window).
Wait 5 minutes, trigger again — should alert.

## Rollback

If method A: restore the original `WALRUS_PUBLISHER_URL` in Railway.

If method B: delete the synthetic row:
```sql
DELETE FROM remember_jobs WHERE id = 'staging-smoke-eng1784';
```

## Sign-off

Record the test in the ENG-1784 ticket with:

- Job ID and timestamp
- Screenshot of Slack alert
- `psql` output showing `status = 'failed'`
- Confirmation that dedup suppressed the repeat alert
