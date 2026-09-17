import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MemWalSession } from "../auth.js";

const { createMcpServer } = await import("../server.js");

/**
 * A rate-limited poll must not read as "still uploading".
 *
 * `waitForRememberJobs` runs its own poll loop and swallows each poll's error,
 * stamping every row `timeout` when the budget runs out. So a batch whose
 * polls were all REFUSED with 429 came back looking exactly like a batch that
 * was genuinely still uploading — and the agent, told it was progressing,
 * polled again on a budget it had already spent.
 *
 * Observed on dev 2026-09-17: ~10 minutes of "0/N saved, N still uploading"
 * while every `/api/remember/bulk/status` was being denied.
 */

interface Behaviour {
    /** What the SDK's internal poll loop reports when its budget expires. */
    waitStates: Array<"done" | "failed" | "timeout">;
    /** How the confirming direct read behaves. */
    probe: "rate-limited" | "still-running" | "done" | "throws";
}

function rateLimit429(): Error {
    const e = new Error(
        'Walrus Memory server error (429): {"error":"Rate limit exceeded",' +
            '"layer":"account_sustained","limit":"1000 weighted-requests/hour",' +
            '"retry_after_seconds":300}',
    );
    (e as Error & { status?: number; retryAfterSeconds?: number }).status = 429;
    (e as Error & { retryAfterSeconds?: number }).retryAfterSeconds = 300;
    return e;
}

function sessionWith(b: Behaviour, calls: string[] = []): MemWalSession {
    const jobIds = b.waitStates.map((_, i) => `job-${i + 1}`);
    return {
        oauthScope: "memwal:read memwal:write",
        namespace: "default",
        memwal: {
            async waitForRememberJobs(ids: string[]) {
                calls.push(`waitJobs:${ids.join(",")}`);
                return {
                    results: b.waitStates.map((status, i) => ({
                        id: jobIds[i],
                        blob_id: status === "done" ? `blob-${i + 1}` : "",
                        status,
                        namespace: "default",
                        error:
                            status === "timeout"
                                ? "polling timed out after 30000ms"
                                : status === "failed"
                                  ? "walrus upload rejected"
                                  : undefined,
                    })),
                    total: b.waitStates.length,
                    succeeded: b.waitStates.filter((s) => s === "done").length,
                    failed: b.waitStates.filter((s) => s !== "done").length,
                };
            },
            async getRememberBulkStatus(ids: string[]) {
                calls.push(`bulkStatus:${ids.join(",")}`);
                if (b.probe === "rate-limited") throw rateLimit429();
                if (b.probe === "throws") throw new Error("relayer unreachable");
                return {
                    results: ids.map((id, i) => ({
                        job_id: id,
                        status: b.probe === "done" ? "done" : "running",
                        blob_id: b.probe === "done" ? `blob-${i + 1}` : undefined,
                        error: undefined,
                    })),
                };
            },
        },
    } as unknown as MemWalSession;
}

async function clientFor(session: MemWalSession, t: TestContext): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(session);
    const client = new Client({ name: "status-rate-limit-test", version: "1.0.0" });
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

test("a batch whose polls were all rate-limited reports the limit, not progress", async (t) => {
    const calls: string[] = [];
    const client = await clientFor(
        sessionWith({ waitStates: ["timeout", "timeout"], probe: "rate-limited" }, calls),
        t,
    );

    const result = await client.callTool({
        name: "memwal_remember_status",
        arguments: { job_ids: ["job-1", "job-2"], waitMs: 30000 },
    });
    const text = textOf(result);

    // The whole point: the words that sent the agent back to poll must be gone.
    assert.ok(
        !/still uploading/i.test(text),
        `a refused poll still read as progress: ${text}`,
    );
    assert.match(text, /rate limit/i);
    // And it must name the layer it actually hit — the hourly one is not the
    // per-minute one, and waiting out the wrong window converges on nothing.
    assert.match(text, /account_sustained/);
    assert.ok(
        calls.some((c) => c.startsWith("bulkStatus:")),
        "nothing moving must be confirmed with one direct read",
    );
});

test("a batch that is genuinely still uploading is left alone", async (t) => {
    const calls: string[] = [];
    const client = await clientFor(
        sessionWith({ waitStates: ["timeout", "timeout"], probe: "still-running" }, calls),
        t,
    );

    const text = textOf(
        await client.callTool({
            name: "memwal_remember_status",
            arguments: { job_ids: ["job-1", "job-2"], waitMs: 30000 },
        }),
    );

    assert.match(text, /still uploading/i);
    assert.ok(!/rate limit/i.test(text), `invented a rate limit: ${text}`);
});

test("the probe is skipped when any row already settled", async (t) => {
    const calls: string[] = [];
    const client = await clientFor(
        sessionWith({ waitStates: ["done", "timeout"], probe: "rate-limited" }, calls),
        t,
    );

    const text = textOf(
        await client.callTool({
            name: "memwal_remember_status",
            arguments: { job_ids: ["job-1", "job-2"], waitMs: 30000 },
        }),
    );

    // A settled row proves the polls were getting through, so spending another
    // request to confirm would be the opposite of the point.
    assert.ok(
        !calls.some((c) => c.startsWith("bulkStatus:")),
        "probed despite evidence the polls were working",
    );
    assert.match(text, /1\/2 saved/);
});

test("a probe that fails for any other reason does not invent an outcome", async (t) => {
    const client = await clientFor(
        sessionWith({ waitStates: ["timeout", "timeout"], probe: "throws" }),
        t,
    );

    const text = textOf(
        await client.callTool({
            name: "memwal_remember_status",
            arguments: { job_ids: ["job-1", "job-2"], waitMs: 30000 },
        }),
    );

    // Falls back to what the wait reported rather than reading a failed probe
    // as a failed write.
    assert.match(text, /still uploading/i);
    assert.ok(!/NOT stored/.test(text), `a failed probe was read as a failed write: ${text}`);
});
