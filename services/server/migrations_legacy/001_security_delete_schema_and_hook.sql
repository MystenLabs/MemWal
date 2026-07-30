-- Security-delete subsystem. LEGACY DB ONLY.
DO $$ BEGIN
    IF to_regclass('vector_entries') IS NULL THEN
        RAISE EXCEPTION 'security-delete migrations require the old-V1 schema (vector_entries missing)';
    END IF;
END $$;

CREATE TABLE deletion_batches (
    id UUID PRIMARY KEY,
    owner TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN
        ('awaiting_signature','executing','completed','failed','rolled_back')),
    digest TEXT,
    tx_bytes BYTEA,
    input_blob_ids BYTEA,
    blob_count INT NOT NULL DEFAULT 0,
    nonce BIGINT NOT NULL DEFAULT 0 CHECK (nonce BETWEEN 0 AND 4294967295),
    expire_epoch BIGINT NOT NULL DEFAULT 0,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    signatures BYTEA,
    executing_at TIMESTAMPTZ,
    last_submit_at TIMESTAMPTZ,
    submit_attempts INT NOT NULL DEFAULT 0,
    resolved_at TIMESTAMPTZ
);
CREATE INDEX idx_active_batches_owner ON deletion_batches (owner)
    WHERE state IN ('awaiting_signature', 'executing');
CREATE UNIQUE INDEX idx_deletion_nonce_epoch ON deletion_batches (expire_epoch, nonce)
    WHERE tx_bytes IS NOT NULL;
CREATE INDEX idx_deletion_batches_retry
    ON deletion_batches ((COALESCE(last_submit_at, executing_at, claimed_at)), id)
    WHERE state = 'executing';

-- Resolver scans reserve a value from the same sequence used by tracked
-- rows. The reserved value is a fence: rows captured before it sort below
-- the fence, while rows captured after it sort above the fence.
CREATE SEQUENCE delete_blobs_tracking_resolver_seq AS BIGINT;

CREATE TABLE delete_blobs_tracking (
    owner TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    object_id TEXT,
    state TEXT NOT NULL DEFAULT 'deletable' CHECK (state IN
        ('deletable','deleting','deleted','deleted_external','not_owner','expired')),
    batch_id UUID REFERENCES deletion_batches(id),
    created_at TIMESTAMPTZ NOT NULL,
    tracked_seq BIGINT NOT NULL DEFAULT nextval('delete_blobs_tracking_resolver_seq')
        CHECK (tracked_seq > 0),
    tracked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner, blob_id)
);
CREATE INDEX idx_tracking_owner_state_created
    ON delete_blobs_tracking (owner, state, created_at, blob_id);
CREATE INDEX idx_tracking_batch ON delete_blobs_tracking (batch_id)
    WHERE batch_id IS NOT NULL;
CREATE INDEX idx_tracking_resolver_pending
    ON delete_blobs_tracking (owner, tracked_seq)
    WHERE state = 'deletable' AND object_id IS NULL;

ALTER SEQUENCE delete_blobs_tracking_resolver_seq
    OWNED BY delete_blobs_tracking.tracked_seq;

CREATE TABLE deletion_job_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Append-preserving claim lineage. delete_blobs_tracking.batch_id is only
-- the current-claim pointer; these rows retain every claim and outcome.
CREATE TABLE deletion_batch_members (
    batch_id UUID NOT NULL REFERENCES deletion_batches(id),
    owner TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    object_id TEXT,
    outcome TEXT NOT NULL DEFAULT 'claimed' CHECK (outcome IN
        ('claimed','deleted','deleted_external','not_owner','expired','released')),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    PRIMARY KEY (batch_id, owner, blob_id),
    FOREIGN KEY (owner, blob_id) REFERENCES delete_blobs_tracking (owner, blob_id),
    CONSTRAINT deletion_batch_members_resolution_check
        CHECK ((outcome = 'claimed') = (resolved_at IS NULL))
);
CREATE INDEX idx_members_owner_blob ON deletion_batch_members (owner, blob_id);
CREATE UNIQUE INDEX idx_members_one_active_claim
    ON deletion_batch_members (owner, blob_id) WHERE outcome = 'claimed';
CREATE INDEX idx_members_outcome_audit
    ON deletion_batch_members (outcome, owner, blob_id);

CREATE FUNCTION canonical_sui_address(raw TEXT) RETURNS TEXT AS $$
BEGIN
    IF raw !~ '^0x[0-9a-fA-F]{1,64}$' THEN
        RAISE EXCEPTION 'invalid Sui owner in legacy vector_entries';
    END IF;
    RETURN '0x' || lpad(lower(substr(raw, 3)), 64, '0');
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE FUNCTION track_deletable() RETURNS trigger AS $$
DECLARE
    canonical_owner TEXT;
BEGIN
    canonical_owner := canonical_sui_address(NEW.owner);
    -- Namespace 21316 (ASCII "SD") isolates this per-owner coordination
    -- from the subsystem's other advisory locks. Shared locks are compatible
    -- across inserts and live only until the vector_entries transaction ends.
    PERFORM pg_advisory_xact_lock_shared(
        21316,
        hashtext(TG_TABLE_SCHEMA || ':' || canonical_owner)
    );
    INSERT INTO delete_blobs_tracking (owner, blob_id, created_at, state)
    VALUES (canonical_owner, NEW.blob_id, NEW.created_at, 'deletable')
    ON CONFLICT (owner, blob_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_track_deletable
AFTER INSERT ON vector_entries FOR EACH ROW EXECUTE FUNCTION track_deletable();
