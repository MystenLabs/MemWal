import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MemWalSession } from "../auth.js";
import { registerRememberTool } from "../tools/remember.js";
import { registerRememberStatusTool } from "../tools/remember-status.js";

/** The SDK throws a plain Error carrying a `status` — 504 when the wait ran out
 * with the job still going, 500 when the job itself failed. It ships no named
 * error classes for these, so the stubs must reproduce that exact shape:
 * stubbing a nicely-named class here is what let a constructor-name check pass
 * in tests and fail against the real SDK. */
const jobStillRunning = (msg = "remember job timed out after 1000ms") =>
    Object.assign(new Error(msg), { status: 504 });
const jobFailed = (msg: string) =>
    Object.assign(new Error(`remember job failed: ${msg}`), { status: 500 });

function sessionWith(memwal: unknown): MemWalSession {
    return { memwal, accountId: "acct-test" } as unknown as MemWalSession;
}

async function callTool(
    session: MemWalSession,
    register: (s: McpServer, sess: MemWalSession) => void,
    name: string,
    args: Record<string, unknown>,
    t: { after: (fn: () => Promise<void>) => void }
) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "test", version: "1.0.0" });
    register(server, session);
    const client = new Client({ name: "remember-test", version: "1.0.0" });
    t.after(async () => {
        await client.close();
        await server.close();
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
    };
}

test("memwal_remember returns the blob_id when the write finishes inside the wait", async (t) => {
    const session = sessionWith({
        rememberAsync: async () => ({ job_id: "job-1", status: "running" }),
        waitForRememberJob: async () => ({
            blob_id: "blob-abc",
            namespace: "ns-1",
        }),
    });

    const res = await callTool(session, registerRememberTool, "memwal_remember", { text: "a fact" }, t);

    assert.equal(res.isError ?? false, false);
    assert.match(res.content[0].text, /^Saved to Walrus Memory\./);
    assert.match(res.content[0].text, /blob_id=blob-abc/);
});

test("memwal_remember hands back a job_id instead of blocking when the write runs long", async (t) => {
    let waited = false;
    const session = sessionWith({
        rememberAsync: async () => ({ job_id: "job-2", status: "running" }),
        waitForRememberJob: async () => {
            waited = true;
            throw jobStillRunning();
        },
    });

    const res = await callTool(session, registerRememberTool, "memwal_remember", { text: "a slow fact" }, t);

    assert.ok(waited, "should have waited before giving up on the blob_id");
    // Still in flight is not an error — the write was accepted and is running.
    assert.equal(res.isError ?? false, false);
    assert.match(res.content[0].text, /still writing/i);
    assert.match(res.content[0].text, /job_id=job-2/);
    // The agent must not report this as saved, and must be told how to confirm.
    assert.match(res.content[0].text, /Do not tell the user it is saved/);
    assert.match(res.content[0].text, /memwal_remember_status/);
    assert.doesNotMatch(res.content[0].text, /blob_id=/);
});

test("memwal_remember still surfaces a genuinely failed job as an error", async (t) => {
    const session = sessionWith({
        rememberAsync: async () => ({ job_id: "job-3", status: "running" }),
        waitForRememberJob: async () => {
            throw jobFailed("Memory encryption backend is unavailable");
        },
    });

    const res = await callTool(session, registerRememberTool, "memwal_remember", { text: "doomed" }, t);

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /encryption backend is unavailable/);
});

test("memwal_remember_status reports the blob_id once the job lands", async (t) => {
    const session = sessionWith({
        waitForRememberJob: async () => ({ blob_id: "blob-xyz", namespace: "ns-2" }),
    });

    const res = await callTool(session, registerRememberStatusTool, "memwal_remember_status", { job_id: "job-4" }, t);

    assert.equal(res.isError ?? false, false);
    assert.match(res.content[0].text, /^Stored\./);
    assert.match(res.content[0].text, /blob_id=blob-xyz/);
});

test("memwal_remember_status reports a failed job as an error so the fact is not assumed saved", async (t) => {
    const session = sessionWith({
        waitForRememberJob: async () => {
            throw jobFailed("walrus upload failed");
        },
    });

    const res = await callTool(session, registerRememberStatusTool, "memwal_remember_status", { job_id: "job-5" }, t);

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Walrus Memory job failed/);
});

test("memwal_remember_status says still writing while the job is running", async (t) => {
    const session = sessionWith({
        waitForRememberJob: async () => {
            throw jobStillRunning();
        },
    });

    const res = await callTool(session, registerRememberStatusTool, "memwal_remember_status", { job_id: "job-6", wait_seconds: 1 }, t);

    assert.equal(res.isError ?? false, false);
    assert.match(res.content[0].text, /Still writing/);
    assert.match(res.content[0].text, /job_id=job-6/);
});

test("memwal_remember_status never asks the SDK for a deadline shorter than one poll", async (t) => {
    let seenTimeout: number | undefined;
    const session = sessionWith({
        waitForRememberJob: async (_id: string, opts: { timeoutMs: number }) => {
            seenTimeout = opts.timeoutMs;
            throw jobStillRunning();
        },
    });

    await callTool(session, registerRememberStatusTool, "memwal_remember_status", { job_id: "job-7", wait_seconds: 0 }, t);

    assert.ok(
        seenTimeout !== undefined && seenTimeout >= 250,
        `wait_seconds=0 must still allow one status read, got ${seenTimeout}`
    );
});
