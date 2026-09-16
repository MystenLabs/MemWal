// Same opt-in as remember-fast-return: the wait is the default, this file
// covers the accept-and-continue path behind the knob.
process.env.MEMWAL_MCP_REMEMBER_WAIT_MS = "0";

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MemWalSession } from "../auth.js";

const { createMcpServer } = await import("../server.js");

/**
 * `memwal_remember_bulk` used to block until every job in the batch reached a
 * terminal state, on a fixed 120s budget. That made it the slowest tool while
 * the server instructions steer an agent to it for any multi-fact turn, and a
 * batch is N separate Walrus writes contending for one upload slot per wallet
 * — so a five-fact batch could burn the whole budget and return nothing but
 * timeouts.
 *
 * It now mirrors `memwal_remember`: accept, then hand back the job_ids. These
 * tests pin the two things that keeps honest — an accepted batch must never
 * read as saved, and every job_id must come back paired with its fact so a
 * later partial failure is actionable.
 */

interface BulkBehaviour {
    /** Per-job terminal state, in input order. */
    states: Array<"done" | "failed" | "timeout">;
}

function sessionWith(b: BulkBehaviour, calls: string[] = []): MemWalSession {
    const jobIds = b.states.map((_, i) => `job-${i + 1}`);
    return {
        oauthScope: "memwal:read memwal:write",
        namespace: "default",
        memwal: {
            async rememberBulkAsync(items: Array<{ text: string }>) {
                calls.push(`bulkAsync:${items.map((i) => i.text).join("|")}`);
                return { job_ids: jobIds, total: jobIds.length, status: "accepted" };
            },
            async rememberBulkAndWait() {
                calls.push("bulkAndWait");
                throw new Error("bulk must not block to terminal any more");
            },
            async waitForRememberJobs(ids: string[]) {
                calls.push(`waitJobs:${ids.join(",")}`);
                return {
                    results: b.states.map((status, i) => ({
                        id: jobIds[i],
                        blob_id: status === "done" ? `blob-${i + 1}` : "",
                        status,
                        namespace: "default",
                        error: status === "failed" ? "walrus upload rejected" : undefined,
                    })),
                    total: b.states.length,
                    succeeded: b.states.filter((s) => s === "done").length,
                    failed: b.states.filter((s) => s !== "done").length,
                };
            },
            async getRememberBulkStatus(ids: string[]) {
                calls.push(`bulkStatus:${ids.join(",")}`);
                return {
                    results: ids.map((id, i) => ({
                        job_id: id,
                        status: b.states[i] === "timeout" ? "running" : b.states[i],
                        blob_id: b.states[i] === "done" ? `blob-${i + 1}` : undefined,
                        error: b.states[i] === "failed" ? "walrus upload rejected" : undefined,
                    })),
                };
            },
        },
    } as unknown as MemWalSession;
}

async function clientFor(session: MemWalSession, t: TestContext): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(session);
    const client = new Client({ name: "remember-bulk-fast-return-test", version: "1.0.0" });
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

test("memwal_remember_bulk returns at accept and never reads as saved", async (t) => {
    const calls: string[] = [];
    const client = await clientFor(
        sessionWith({ states: ["done", "done"] }, calls),
        t,
    );

    const text = textOf(
        await client.callTool({
            name: "memwal_remember_bulk",
            arguments: { facts: ["likes espresso", "works in Hanoi"] },
        }),
    );

    // Accepted, not stored — and it must not have blocked on the batch.
    assert.match(text, /ACCEPTED, NOT YET SAVED/);
    assert.ok(calls.some((c) => c.startsWith("bulkAsync:")), "should accept via rememberBulkAsync");
    assert.ok(!calls.includes("bulkAndWait"), "must not block to terminal");
    assert.ok(
        !calls.some((c) => c.startsWith("waitJobs:")),
        "a zero budget must not enter the wait loop",
    );
    // No blob_id may appear — that is the token an agent reads as "stored".
    assert.ok(!/blob_id=/.test(text), `accepted batch leaked a blob_id: ${text}`);
});

test("every job_id comes back paired with its fact", async (t) => {
    const client = await clientFor(sessionWith({ states: ["done", "done", "done"] }), t);

    const text = textOf(
        await client.callTool({
            name: "memwal_remember_bulk",
            arguments: { facts: ["alpha fact", "beta fact", "gamma fact"] },
        }),
    );

    // "one of these failed" is only actionable if the agent can tell which.
    assert.match(text, /job_id=job-1 — alpha fact/);
    assert.match(text, /job_id=job-2 — beta fact/);
    assert.match(text, /job_id=job-3 — gamma fact/);
});

test("the accepted batch tells the agent how to settle it and not to re-send", async (t) => {
    const client = await clientFor(sessionWith({ states: ["done"] }), t);

    const text = textOf(
        await client.callTool({
            name: "memwal_remember_bulk",
            arguments: { facts: ["a durable fact"] },
        }),
    );

    assert.match(text, /memwal_remember_status/);
    assert.match(text, /job_ids=/);
    // Re-sending queues a second paid copy behind the first.
    assert.match(text, /[Dd]o not re-send/);
});

test("memwal_remember_status settles a whole batch in one call", async (t) => {
    const calls: string[] = [];
    const client = await clientFor(
        sessionWith({ states: ["done", "failed", "timeout"] }, calls),
        t,
    );

    const text = textOf(
        await client.callTool({
            name: "memwal_remember_status",
            arguments: { job_ids: ["job-1", "job-2", "job-3"], waitMs: 1000 },
        }),
    );

    // A mixed batch must report every outcome rather than throwing on the
    // first failure — otherwise the blob_ids that DID land are lost.
    assert.match(text, /1\/3 saved/);
    assert.match(text, /blob_id=blob-1/);
    assert.match(text, /NOT STORED/);
    assert.match(text, /still uploading/);
    // And it must name which ids still need chasing, and which need re-sending.
    assert.match(text, /job_ids=\[job-3\]/);
    assert.match(text, /must be sent again/);
    assert.ok(calls.some((c) => c.startsWith("waitJobs:")), "should use the batch wait");
});

test("memwal_remember_status with waitMs=0 reads a batch without waiting", async (t) => {
    const calls: string[] = [];
    const client = await clientFor(sessionWith({ states: ["done", "timeout"] }, calls), t);

    const text = textOf(
        await client.callTool({
            name: "memwal_remember_status",
            arguments: { job_ids: ["job-1", "job-2"], waitMs: 0 },
        }),
    );

    assert.ok(
        calls.some((c) => c.startsWith("bulkStatus:")),
        "a zero budget must be a single batched read",
    );
    assert.ok(!calls.some((c) => c.startsWith("waitJobs:")), "must not enter the wait loop");
    assert.match(text, /1\/2 saved/);
});

test("memwal_remember_status rejects job_id and job_ids together", async (t) => {
    const client = await clientFor(sessionWith({ states: ["done"] }), t);

    const result = await client.callTool({
        name: "memwal_remember_status",
        arguments: { job_id: "job-1", job_ids: ["job-2"] },
    });

    // They would describe different writes; guessing which one the caller
    // meant would report the wrong fact's fate.
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textOf(result), /not both/);
});

test("memwal_remember_status requires one of job_id or job_ids", async (t) => {
    const client = await clientFor(sessionWith({ states: ["done"] }), t);

    const result = await client.callTool({
        name: "memwal_remember_status",
        arguments: { waitMs: 0 },
    });

    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textOf(result), /job_id.*job_ids/s);
});
