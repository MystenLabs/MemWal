import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Minimal env for booting the default-mode sidecar app. The find-blob-by-job
// validation path returns 400 before touching the chain, so no client mocking
// is needed here (end-to-end reconcile behavior is covered by the live script).
const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
process.env.SERVER_SUI_PRIVATE_KEYS = new Ed25519Keypair().getSecretKey();
process.env.SIDECAR_AUTH_TOKEN = "find-blob-test-token";
process.env.SUI_NETWORK = "testnet";
process.env.SUI_GRPC_URL = "https://find-blob.testnet.example";
process.env.WALRUS_PACKAGE_ID = `0x${"a".repeat(64)}`;

const { createSidecarApp } = await import("../sidecar/app.js");
const { sanitizeRequestId } = await import("../sidecar/log.js");
const { MEMWAL_JOB_TAG_KEY } = await import("../sidecar/util.js");

// The reconcile correctness hinges on the register-side tag value
// (sanitizeRequestId(jobId)) equaling the query-side value (also
// sanitizeRequestId(jobId)). For the production key space — server-minted UUIDs
// — that must be an identity, or the tag would never match and every retry would
// silently re-mint. Pin it.
test("a remember-job UUID survives sanitizeRequestId unchanged (tag == query)", () => {
    for (let i = 0; i < 50; i++) {
        const uuid = crypto.randomUUID();
        assert.equal(sanitizeRequestId(uuid), uuid, `UUID must round-trip: ${uuid}`);
    }
    // And a non-conforming id sanitizes to null on BOTH sides (no silent mismatch).
    assert.equal(sanitizeRequestId("has spaces"), null);
    assert.equal(sanitizeRequestId("x".repeat(129)), null);
});

// Regression: the durable upload path (walrus-upload-journal.ts) once wrote
// the crash-recovery job tag under a different key (`memwal_migration_job`,
// an unrelated dead-code constant from the V1->V2 migration feature) than
// the one scanOwnerForJobBlob() actually searches for (`memwal_job_id`) — so
// the tag written by every real /api/remember call could never be found by
// reconcile, and a crash right after mint-but-before-journal would mint a
// second paid blob on retry, silently. Both the write sites (durable +
// legacy) and the read site now import the same MEMWAL_JOB_TAG_KEY constant
// from util.ts instead of each hardcoding the string, so this can't drift
// again without deliberately un-importing the shared constant. This test
// pins the constant's value and confirms no file in sidecar/ hardcodes a
// competing literal for job-tag purposes.
test("register (write) and reconcile (read) use the identical job-tag key — no hardcoded drift", () => {
    assert.equal(MEMWAL_JOB_TAG_KEY, "memwal_job_id");

    const here = path.dirname(fileURLToPath(import.meta.url));
    const sidecarDir = path.join(here, "..", "sidecar");
    const filesToCheck = [
        path.join(sidecarDir, "routes", "walrus-upload-journal.ts"),
        path.join(sidecarDir, "routes", "walrus-upload.ts"),
        path.join(sidecarDir, "routes", "walrus-query.ts"),
    ];

    for (const file of filesToCheck) {
        const src = readFileSync(file, "utf8");
        assert.ok(
            src.includes("MEMWAL_JOB_TAG_KEY"),
            `${path.basename(file)} must reference the shared MEMWAL_JOB_TAG_KEY constant, not a hardcoded literal`
        );
        // The only other job-shaped tag key in this codebase is the distinct,
        // separately-purposed `memwal_migration_job` (findOwnedBlobObjects in
        // walrus-query.ts) — a hardcoded `"memwal_job_id"` string literal
        // anywhere in these files would mean someone reintroduced the drift.
        assert.ok(
            !src.includes('"memwal_job_id"') && !src.includes("'memwal_job_id'"),
            `${path.basename(file)} must not hardcode the "memwal_job_id" string literal — import MEMWAL_JOB_TAG_KEY instead`
        );
    }
});

async function listen(): Promise<{ server: Server; baseUrl: string }> {
    return await new Promise((resolve) => {
        const server = createSidecarApp().listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") throw new Error("no port");
            resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
        });
    });
}

const headers = {
    authorization: "Bearer find-blob-test-token",
    "content-type": "application/json",
};

test("find-blob-by-job validates owner and jobId", async () => {
    const { server, baseUrl } = await listen();
    try {
        // missing owner → 400
        const noOwner = await fetch(`${baseUrl}/walrus/find-blob-by-job`, {
            method: "POST",
            headers,
            body: JSON.stringify({ jobId: "job-1" }),
        });
        assert.equal(noOwner.status, 400);

        // missing jobId → 400
        const noJob = await fetch(`${baseUrl}/walrus/find-blob-by-job`, {
            method: "POST",
            headers,
            body: JSON.stringify({ owner: `0x${"1".repeat(64)}` }),
        });
        assert.equal(noJob.status, 400);

        // empty body → 400
        const empty = await fetch(`${baseUrl}/walrus/find-blob-by-job`, {
            method: "POST",
            headers,
            body: "{}",
        });
        assert.equal(empty.status, 400);

        // a jobId that can't be a tag value (fails sanitizeRequestId) → 400, so
        // the query can never silently diverge from the stored tag value.
        const badJob = await fetch(`${baseUrl}/walrus/find-blob-by-job`, {
            method: "POST",
            headers,
            body: JSON.stringify({ owner: `0x${"1".repeat(64)}`, jobId: "has spaces & symbols!" }),
        });
        assert.equal(badJob.status, 400);
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((e) => (e ? reject(e) : resolve()))
        );
    }
});
