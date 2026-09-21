// The wait path only exists when there IS a wait, so this file keeps the
// default budget rather than the accept-and-continue knob the deadline tests
// use. Without that, `memwal_remember` returns at accept and never reaches the
// code under test — which is exactly how the first version of this test came
// to pass against the bug it was written for.
process.env.MEMWAL_MCP_REMEMBER_WAIT_MS = "5000";

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MemWalSession } from "../auth.js";

const { createMcpServer } = await import("../server.js");
const { REMEMBER_WAIT_MS } = await import("../tools/remember-wait.js");

function textOf(result: unknown): string {
    return (result as { content: Array<{ text: string }> }).content
        .map((c) => c.text)
        .join("\n");
}

async function clientFor(session: MemWalSession, t: TestContext): Promise<Client> {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(session);
    const client = new Client({ name: "wait-hang", version: "1.0.0" });
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(st);
    await client.connect(ct);
    return client;
}

test("this file actually exercises the wait path", () => {
    // Guards the mistake above: if the budget is ever 0 here, every test below
    // passes without running the code it targets.
    assert.notEqual(REMEMBER_WAIT_MS, 0);
});

test("a relayer that goes quiet mid-wait still hands back the job_id", async (t) => {
    // The write was accepted — it is a row in remember_jobs and still running.
    // Our wait deadline firing means the relayer stopped answering US. The
    // job_id is the only way to settle it, and carrying it is the entire
    // reason the pending result exists; the deadline error used to fall
    // through to `throw` and discard it.
    const client = await clientFor({
        oauthScope: "memwal:read memwal:write",
        namespace: "default",
        memwal: {
            async rememberAsync() {
                return { job_id: "job-live", status: "pending" };
            },
            async waitForRememberJob() {
                // What withWaitDeadline raises once the relayer goes silent.
                const err = new Error("Walrus Memory stopped responding while waiting");
                err.name = "MemWalRelayerUnresponsive";
                throw err;
            },
        },
    } as unknown as MemWalSession, t);

    const res = await client.callTool({
        name: "memwal_remember",
        arguments: { text: "a durable fact" },
    });
    const text = textOf(res);

    assert.match(text, /job_id=job-live/, `job_id was dropped: ${text}`);
    assert.doesNotMatch(text, /^Saved to Walrus Memory/m, "must not read as stored");
});

test("a job that genuinely failed is still an error, not a pending result", async (t) => {
    // The counterpart: a 500 means the write is dead, so it must NOT be
    // laundered into "still uploading" by the same branch.
    const client = await clientFor({
        oauthScope: "memwal:read memwal:write",
        namespace: "default",
        memwal: {
            async rememberAsync() {
                return { job_id: "job-dead", status: "pending" };
            },
            async waitForRememberJob() {
                const err = new Error("remember job failed: walrus upload rejected");
                Object.assign(err, { status: 500 });
                throw err;
            },
        },
    } as unknown as MemWalSession, t);

    const res = await client.callTool({
        name: "memwal_remember",
        arguments: { text: "a durable fact" },
    });
    assert.equal((res as { isError?: boolean }).isError, true);
    assert.match(textOf(res), /failed/i);
});

test("a relayer that goes quiet mid-wait still hands back every bulk job_id", async (t) => {
    // Same hole as the single-write case, on the path where it costs most: a
    // batch loses N job_ids at once, and `waitForRememberJobs` reporting
    // stragglers per item does not help — the throw comes from the deadline
    // wrapper around it, before any per-item result exists.
    const client = await clientFor({
        oauthScope: "memwal:read memwal:write",
        namespace: "default",
        memwal: {
            async rememberBulkAsync() {
                return { job_ids: ["bulk-1", "bulk-2"], total: 2, status: "accepted" };
            },
            async waitForRememberJobs() {
                const err = new Error("Walrus Memory stopped responding while waiting");
                err.name = "MemWalRelayerUnresponsive";
                throw err;
            },
        },
    } as unknown as MemWalSession, t);

    const text = textOf(
        await client.callTool({
            name: "memwal_remember_bulk",
            arguments: { facts: ["first fact", "second fact"] },
        }),
    );
    assert.match(text, /bulk-1/, `job_ids were dropped: ${text}`);
    assert.match(text, /bulk-2/, `job_ids were dropped: ${text}`);
    assert.doesNotMatch(text, /^Saved \d+\/\d+/m, "must not read as stored");
});

test("a relayer that goes quiet mid-wait keeps analyze's job_ids AND its facts", async (t) => {
    // Analyze pays an LLM extraction before the writes are queued. Throwing
    // away the wait discarded both the job_ids and that extraction, so the
    // caller could neither settle the running writes nor recover the facts
    // without paying for them again.
    const client = await clientFor({
        oauthScope: "memwal:read memwal:write",
        namespace: "default",
        memwal: {
            async analyze() {
                return {
                    job_ids: ["an-1", "an-2"],
                    facts: [{ text: "drinks oat milk" }, { text: "ships on Fridays" }],
                    status: "accepted",
                };
            },
            async waitForRememberJobs() {
                const err = new Error("Walrus Memory stopped responding while waiting");
                err.name = "MemWalRelayerUnresponsive";
                throw err;
            },
        },
    } as unknown as MemWalSession, t);

    const text = textOf(
        await client.callTool({
            name: "memwal_analyze",
            arguments: { text: "a transcript worth extracting from" },
        }),
    );
    assert.match(text, /an-1/, `job_ids were dropped: ${text}`);
    assert.match(text, /drinks oat milk/, `extracted facts were dropped: ${text}`);
});
