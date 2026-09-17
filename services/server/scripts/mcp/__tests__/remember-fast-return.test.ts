// Opt into accept-and-continue for this file. It is NOT the default — D1 kept
// the wait, so a plain call blocks and returns a blob_id — but the path stays
// reachable via this knob, and it is the path these tests cover.
process.env.MEMWAL_MCP_REMEMBER_WAIT_MS = "0";

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MemWalSession } from "../auth.js";

// Dynamic: static imports hoist above the assignment above, so the module
// would read the real default before the line that overrides it ever runs.
const { createMcpServer } = await import("../server.js");
const { REMEMBER_WAIT_MS, parseWaitBudget, MAX_REMEMBER_WAIT_MS } =
    await import("../tools/remember-wait.js");

/**
 * `memwal_remember` blocks to terminal by default, so a result carries a real
 * blob_id — D1 settled that, and returning at accept is its own product
 * ticket. What this file covers is the accept-and-continue path an operator
 * opts into with `MEMWAL_MCP_REMEMBER_WAIT_MS=0`.
 *
 * The risk that path buys is an agent reading "accepted" as "saved", so these
 * tests pin what keeps it honest: an accepted result must never read as
 * success or carry a blob_id, and `memwal_remember_status` — the only thing
 * that can observe a job failing after acceptance — must report that failure
 * as an error rather than as a write still in flight.
 */

interface FakeJob {
    /** Calls to waitForRememberJob before the job reports done. */
    pendingPolls: number;
    blobId?: string;
    /** When set, the job fails with this message instead of completing. */
    failWith?: string;
}

function sessionWith(job: FakeJob, calls: string[] = []): MemWalSession {
    let polls = 0;
    return {
        oauthScope: "memwal:read memwal:write",
        memwal: {
            async rememberAsync(text: string, namespace?: string) {
                calls.push(`rememberAsync:${text}:${namespace ?? ""}`);
                return { job_id: "job-1", status: "running" };
            },
            async waitForRememberJob(jobId: string) {
                calls.push(`wait:${jobId}`);
                if (job.failWith) {
                    throw Object.assign(
                        new Error(`remember job failed: ${job.failWith}`),
                        { status: 500, jobId }
                    );
                }
                if (polls++ < job.pendingPolls) {
                    throw Object.assign(
                        new Error(`remember job timed out (job_id=${jobId})`),
                        { status: 504, jobId }
                    );
                }
                return {
                    id: jobId,
                    job_id: jobId,
                    blob_id: job.blobId ?? "blob-abc",
                    owner: "0xowner",
                    namespace: "default",
                };
            },
            async getRememberStatus(jobId: string) {
                calls.push(`status:${jobId}`);
                if (job.failWith) {
                    return { job_id: jobId, status: "failed", error: job.failWith };
                }
                return polls++ < job.pendingPolls
                    ? { job_id: jobId, status: "running" }
                    : {
                        job_id: jobId,
                        status: "done",
                        blob_id: job.blobId ?? "blob-abc",
                        namespace: "default",
                    };
            },
        },
    } as unknown as MemWalSession;
}

async function clientFor(session: MemWalSession, t: TestContext): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(session);
    const client = new Client({ name: "remember-fast-return-test", version: "1.0.0" });
    t.after(async () => {
        await client.close();
        await server.close();
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
}

function textOf(result: unknown): string {
    return (result as { content: Array<{ text: string }> }).content
        .map((c) => c.text)
        .join("\n");
}

test("the default returns at accept, and blocking is opt-in", () => {
    // Reverses D1. A full-ceiling call runs ACCEPT_DEADLINE_MS + 90_000 +
    // WAIT_OVERSHOOT_GRACE_MS = 115s against the MCP SDK's 60s default
    // tools/call timeout, so it could not honour "a result means it landed"
    // anyway — it aborted mid-wait and the retry wrote the fact twice. Every
    // budget that fits under 60s (<=35_000) is the in-between to avoid.
    assert.equal(parseWaitBudget(undefined), 0);
    assert.equal(parseWaitBudget(""), 0);
    assert.equal(REMEMBER_WAIT_MS, 0);
    assert.equal(parseWaitBudget("0"), 0);
    // An operator who wants the old behaviour still has it.
    assert.equal(parseWaitBudget("90000"), MAX_REMEMBER_WAIT_MS);
});

test("a typo'd budget falls back to the default instead of picking one nobody asked for", () => {
    // Number("10s") is NaN, and every NaN comparison is false — an unvalidated
    // parse would sail past a range check.
    assert.equal(parseWaitBudget("10s"), 0);
    assert.equal(parseWaitBudget("abc"), 0);
    assert.equal(parseWaitBudget("-1"), 0);
});

test("a budget past the ceiling is clamped, not honoured", () => {
    assert.equal(parseWaitBudget("90000"), 90_000);
    assert.equal(parseWaitBudget("600000"), 90_000);
});

test("memwal_remember returns at accept and never reads as saved", async (t) => {
    const calls: string[] = [];
    const client = await clientFor(sessionWith({ pendingPolls: 0 }, calls), t);
    const result = await client.callTool({
        name: "memwal_remember",
        arguments: { text: "a durable fact" },
    });

    // Accepted is the expected path, not a failure — the job is a durable row
    // the relayer drives, and keeps going after the tool returns.
    assert.equal(result.isError, undefined);

    const text = textOf(result);
    assert.match(text, /ACCEPTED, NOT YET SAVED/);
    assert.match(text, /job_id=job-1/);
    assert.match(text, /memwal_remember_status/);
    // The whole point of the wording: an agent must not be able to read this
    // as a completed write.
    assert.doesNotMatch(text, /Saved to Walrus Memory/);
    assert.ok(!text.includes("blob_id="), "an accepted result must not carry a blob_id");

    // A zero budget must not poll at all — the job was accepted, and waiting
    // zero milliseconds for it is not a thing worth a round trip.
    assert.deepEqual(calls, ["rememberAsync:a durable fact:"]);
});

test("the accepted message does not claim a duration it never waited", async (t) => {
    const client = await clientFor(sessionWith({ pendingPolls: 0 }), t);
    const result = await client.callTool({
        name: "memwal_remember",
        arguments: { text: "a fact" },
    });
    assert.doesNotMatch(textOf(result), /after 0\.0s/);
});

test("memwal_remember_status reports the blob_id once the job lands", async (t) => {
    const client = await clientFor(sessionWith({ pendingPolls: 0, blobId: "blob-late" }), t);
    const result = await client.callTool({
        name: "memwal_remember_status",
        arguments: { job_id: "job-1" },
    });

    assert.equal(result.isError, undefined);
    const text = textOf(result);
    assert.match(text, /Saved to Walrus Memory/);
    assert.match(text, /blob_id=blob-late/);
});

test("memwal_remember_status with waitMs=0 reads state without waiting", async (t) => {
    const calls: string[] = [];
    const client = await clientFor(sessionWith({ pendingPolls: 5 }, calls), t);
    const result = await client.callTool({
        name: "memwal_remember_status",
        arguments: { job_id: "job-1", waitMs: 0 },
    });

    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /STILL UPLOADING/);
    // A zero budget must be a single GET — waitForRememberJob sleeps before
    // its first poll, so routing it there would report "still running"
    // without ever asking the relayer.
    assert.deepEqual(calls, ["status:job-1"]);
});

test("memwal_remember_status surfaces a failed job as an error", async (t) => {
    const client = await clientFor(
        sessionWith({ pendingPolls: 0, failWith: "walrus upload rejected" }, []),
        t
    );
    const result = await client.callTool({
        name: "memwal_remember_status",
        arguments: { job_id: "job-1", waitMs: 0 },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /Walrus Memory job failed/);
    assert.match(textOf(result), /walrus upload rejected/);
});
