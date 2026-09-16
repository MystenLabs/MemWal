// Bound the SDK calls that have no deadline of their own. Set before the
// module under test is imported — ACCEPT_DEADLINE_MS is read once at load.
process.env.MEMWAL_MCP_ACCEPT_DEADLINE_MS = "150";

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MemWalSession } from "../auth.js";

// Dynamic, not static: ESM hoists every static import above the assignment
// above, so the module would read the real 15s default before the line that
// shortens it ever runs — and each tool test would then take 15 seconds.
const { createMcpServer } = await import("../server.js");
const { ACCEPT_DEADLINE_MS, withDeadline } = await import("../tools/remember-wait.js");

/**
 * The SDK's `signedRequest` aborts a request only when the caller passes a
 * signal, and of the memory methods only `recall()` does. `rememberAsync`,
 * `rememberBulkAsync` and every job-status poll call it with none, so `fetch`
 * runs with no deadline. `timeoutMs` is checked at the top of the poll loop, so
 * it bounds when the next poll STARTS, not how long one takes — which is how a
 * tool documented as capping at 90s was observed still running past 120s.
 *
 * Returning at accept does not fix that by itself: the accept POST is one of
 * the unbounded calls. These tests pin that every entry point is bounded, and
 * that the resulting error never reads as a saved write.
 */

/** A promise that never settles — what a stalled socket looks like from here. */
function hangs<T>(): Promise<T> {
    return new Promise<T>(() => {});
}

function sessionThatHangs(): MemWalSession {
    return {
        oauthScope: "memwal:read memwal:write",
        namespace: "default",
        memwal: {
            rememberAsync: hangs,
            rememberBulkAsync: hangs,
            getRememberStatus: hangs,
            getRememberBulkStatus: hangs,
            waitForRememberJob: hangs,
            waitForRememberJobs: hangs,
        },
    } as unknown as MemWalSession;
}

async function clientFor(session: MemWalSession, t: TestContext): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(session);
    const client = new Client({ name: "remember-deadline-test", version: "1.0.0" });
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

test("the accept deadline is read from the environment and validated", () => {
    assert.equal(ACCEPT_DEADLINE_MS, 150);
});

test("withDeadline passes a value through untouched when work finishes first", async () => {
    assert.equal(await withDeadline(Promise.resolve("ok"), 1_000, "nope"), "ok");
});

test("withDeadline rejects with a named error once the deadline passes", async () => {
    await assert.rejects(
        withDeadline(hangs<never>(), 20, "relayer went quiet"),
        (err: Error) => {
            // `wrapTool` routes on the name, so it has to be distinct from a
            // job failure — this is "we do not know", not "it failed".
            assert.equal(err.name, "MemWalRelayerUnresponsive");
            assert.match(err.message, /relayer went quiet/);
            return true;
        },
    );
});

test("withDeadline does not reject once the work has already resolved", async () => {
    // A leftover timer firing after resolution would reject a promise nobody
    // is racing any more, surfacing as an unhandled rejection.
    const value = await withDeadline(Promise.resolve(1), 10, "nope");
    assert.equal(value, 1);
    await new Promise((r) => setTimeout(r, 40));
});

test("memwal_remember cannot hang forever on a stalled accept", async (t) => {
    const client = await clientFor(sessionThatHangs(), t);

    const result = await client.callTool({
        name: "memwal_remember",
        arguments: { text: "a durable fact" },
    });

    assert.equal((result as { isError?: boolean }).isError, true);
    const text = textOf(result);
    // Must not read as stored, and must say a retry is safe rather than
    // leaving the agent to guess (a blind retry would risk a second paid copy).
    assert.ok(!/^Saved to Walrus Memory/m.test(text), `read as saved: ${text}`);
    assert.match(text, /did not accept/);
    assert.match(text, /[Rr]etry/);
});

test("memwal_remember_bulk cannot hang forever on a stalled accept", async (t) => {
    const client = await clientFor(sessionThatHangs(), t);

    const result = await client.callTool({
        name: "memwal_remember_bulk",
        arguments: { facts: ["one", "two"] },
    });

    assert.equal((result as { isError?: boolean }).isError, true);
    const text = textOf(result);
    assert.match(text, /did not accept/);
    // /api/remember/bulk carries NO idempotency key — the handler mints a
    // fresh uuid per item — so the single path's "retrying is safe" line is a
    // lie here, and an expensive one: withDeadline does not cancel the request,
    // so the relayer has usually accepted by the time this fires.
    assert.match(text, /Do NOT retry blindly/);
    assert.match(text, /second time at full cost|SECOND time at full cost/i);
    assert.doesNotMatch(
        text,
        /Retrying in this session is safe/,
        "bulk must never claim idempotency it does not have",
    );
});

test("memwal_remember's accept timeout still says a retry is safe", async (t) => {
    // The single path DOES carry a content-derived idempotency key, so the
    // opposite advice is correct there — and worth pinning, because collapsing
    // both messages into one is exactly how the bulk bug happened.
    const client = await clientFor(sessionThatHangs(), t);
    const result = await client.callTool({
        name: "memwal_remember",
        arguments: { text: "a durable fact" },
    });
    assert.match(textOf(result), /Retrying in this session is safe/);
});

test("memwal_remember_status cannot hang forever on a stalled read", async (t) => {
    const client = await clientFor(sessionThatHangs(), t);

    const result = await client.callTool({
        name: "memwal_remember_status",
        arguments: { job_id: "job-1", waitMs: 0 },
    });

    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textOf(result), /did not accept/);
});

test("a stalled batch status read is bounded too", async (t) => {
    const client = await clientFor(sessionThatHangs(), t);

    const result = await client.callTool({
        name: "memwal_remember_status",
        arguments: { job_ids: ["job-1", "job-2"], waitMs: 0 },
    });

    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(textOf(result), /did not accept/);
});

/**
 * The status tool must answer before the MCP client gives up on it.
 *
 * `@modelcontextprotocol/sdk` times a request out at
 * `DEFAULT_REQUEST_TIMEOUT_MSEC` (60s) unless the caller overrides it. A tool
 * whose advertised maximum equals that deadline loses every race it enters:
 * the client reports `MCP error -32001: Request timed out` and the agent
 * cannot tell a slow write from a broken tool. Caught live against the
 * production relayer with `waitMs: 60000` on a three-job batch.
 */
test("the status wait ceiling stays under the MCP client's own deadline", async (t: TestContext) => {
    const { DEFAULT_REQUEST_TIMEOUT_MSEC } = await import(
        "@modelcontextprotocol/sdk/shared/protocol.js"
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
        oauthScope: "memwal:read memwal:write",
    } as MemWalSession);
    const client = new Client({ name: "status-deadline-test", version: "1.0.0" });
    t.after(async () => {
        await client.close();
        await server.close();
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const status = tools.find((tool) => tool.name === "memwal_remember_status");
    assert.ok(status, "memwal_remember_status is registered");

    const max = (
        status.inputSchema as { properties?: { waitMs?: { maximum?: number } } }
    ).properties?.waitMs?.maximum;
    assert.equal(typeof max, "number", "waitMs advertises a maximum");
    assert.ok(
        max < DEFAULT_REQUEST_TIMEOUT_MSEC,
        `waitMs max ${max}ms must stay under the client deadline ${DEFAULT_REQUEST_TIMEOUT_MSEC}ms`,
    );
    // Headroom for the round trip, not just a strict inequality.
    assert.ok(
        DEFAULT_REQUEST_TIMEOUT_MSEC - max >= 10_000,
        `only ${DEFAULT_REQUEST_TIMEOUT_MSEC - max}ms of headroom before the client gives up`,
    );
});
