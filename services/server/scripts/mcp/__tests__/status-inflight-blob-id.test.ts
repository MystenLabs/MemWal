import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MemWalSession } from "../auth.js";

const { createMcpServer } = await import("../server.js");

/**
 * An unfinished write must not be reported with a blob_id.
 *
 * `persist_uploaded_state` (services/server/src/jobs.rs) writes `blob_id` and
 * sets status `uploaded` as soon as the blob is on Walrus — but the job is not
 * done: SetMetadataAndTransfer has not handed the blob object to the user and
 * insert_vector has not indexed it, so the fact is not recallable and a later
 * failure can still lose it. `uploaded` is therefore counted as in flight.
 *
 * The render did not follow: it printed the blob_id of any row that had one,
 * so a real reply on dev 2026-09-21 read
 *
 *     0/6 saved, 6 still uploading.
 *     1. [still uploading] job_id=77e30990-… blob_id=M4jEdPGmnmGTPQMQ…
 *
 * which contradicts this server's own instruction that "only a blob_id in the
 * tool reply means the fact is already stored". An agent that believes the
 * blob_id tells the user a fact is saved while it is still in flight.
 */

function sessionWith(opts: {
    /** What the SDK's internal poll loop reports when its budget expires. */
    waitStates?: Array<"done" | "failed" | "timeout">;
    /** What a direct batch read reports. */
    probeRows: Array<{ status: string; blob_id?: string }>;
}): MemWalSession {
    const { waitStates, probeRows } = opts;
    const idFor = (i: number) => `job-${i + 1}`;
    return {
        oauthScope: "memwal:read memwal:write",
        namespace: "default",
        memwal: {
            async waitForRememberJobs(ids: string[]) {
                const states = waitStates ?? ids.map(() => "timeout" as const);
                return {
                    results: states.map((status, i) => ({
                        id: idFor(i),
                        blob_id: status === "done" ? `blob-${i + 1}` : "",
                        status,
                        namespace: "default",
                        error:
                            status === "timeout"
                                ? "polling timed out after 10000ms"
                                : undefined,
                    })),
                    total: states.length,
                    succeeded: states.filter((s) => s === "done").length,
                    failed: states.filter((s) => s !== "done").length,
                };
            },
            async getRememberBulkStatus(ids: string[]) {
                return {
                    results: ids.map((id, i) => ({
                        job_id: id,
                        status: probeRows[i]?.status ?? "running",
                        blob_id: probeRows[i]?.blob_id,
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
    const client = new Client({ name: "status-inflight-blob-id-test", version: "1.0.0" });
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

test("a waited batch whose probe finds `uploaded` shows no blob_id", async (t) => {
    // Nothing moved inside the budget, so settleBatch confirms with one direct
    // read — which is where an `uploaded` row (real blob_id, unfinished job)
    // enters the report.
    const client = await clientFor(
        sessionWith({
            probeRows: [
                { status: "uploaded", blob_id: "blob-uploaded-1" },
                { status: "running" },
            ],
        }),
        t,
    );

    const text = textOf(
        await client.callTool({
            name: "memwal_remember_status",
            arguments: { job_ids: ["job-1", "job-2"] },
        }),
    );

    assert.match(text, /0\/2 saved, 2 still uploading/);
    assert.ok(
        !text.includes("blob-uploaded-1"),
        `an in-flight row must not carry a blob_id:\n${text}`,
    );
});

test("a zero-budget read of an `uploaded` job shows no blob_id", async (t) => {
    // The other path into the same render: waitMs=0 reads the relayer directly,
    // so `uploaded` arrives with its blob_id and no probe is involved.
    const client = await clientFor(
        sessionWith({ probeRows: [{ status: "uploaded", blob_id: "blob-uploaded-1" }] }),
        t,
    );

    const text = textOf(
        await client.callTool({
            name: "memwal_remember_status",
            arguments: { job_ids: ["job-1"], waitMs: 0 },
        }),
    );

    assert.match(text, /0\/1 saved, 1 still uploading/);
    assert.ok(
        !text.includes("blob-uploaded-1"),
        `an in-flight row must not carry a blob_id:\n${text}`,
    );
});

test("a settled batch still shows every blob_id", async (t) => {
    // The guard must not cost a caller the blob_ids it is entitled to: `done`
    // is exactly the state the instruction text points at.
    const client = await clientFor(
        sessionWith({
            waitStates: ["done", "done"],
            probeRows: [{ status: "done" }, { status: "done" }],
        }),
        t,
    );

    const text = textOf(
        await client.callTool({
            name: "memwal_remember_status",
            arguments: { job_ids: ["job-1", "job-2"] },
        }),
    );

    assert.match(text, /2\/2 saved/);
    assert.ok(text.includes("blob-1"), text);
    assert.ok(text.includes("blob-2"), text);
});
