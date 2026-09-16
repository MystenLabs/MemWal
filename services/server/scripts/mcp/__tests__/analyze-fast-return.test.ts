/**
 * `memwal_analyze` returns once the facts are extracted and queued.
 *
 * It was the last tool still blocking to terminal after the two remember tools
 * moved to a bounded wait, which left it the slowest in the set by a wide
 * margin — 37.0s measured against dev in the same session where
 * `memwal_remember` came back in 0.2s. The wait has the same shape as bulk's
 * (N Walrus writes, one upload per wallet), so there was no reason for the
 * answer to be shaped differently.
 *
 * What must stay true, and is what these tests pin: extraction is still waited
 * for, because the facts are the part an agent can act on; the reply never
 * reads as saved when the writes are still in flight; and every job_id comes
 * back paired with the fact it carries, so a later partial failure is
 * actionable.
 */
// A small non-zero wait so the bounded-wait branch is reachable quickly. The
// shipped default is the full 90s ceiling (D1 kept the block-to-terminal
// contract), so leaving it unset would make every assertion below about a
// partly landed batch wait out that ceiling instead of returning.
// Set before the dynamic import, because the budget is read once at load.
process.env.MEMWAL_MCP_REMEMBER_WAIT_MS = "500";

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MemWalSession } from "../auth.js";

// Dynamic, not static: ESM hoists static imports above the assignment above,
// so the module would read the real default before the line that changes it.
const { createMcpServer } = await import("../server.js");

const FACTS = ["User drinks oat milk", "User lives in Ho Chi Minh City"];

function sessionWith(
    opts: { states?: Array<"done" | "failed" | "timeout">; facts?: string[] } = {},
    calls: string[] = [],
): MemWalSession {
    const facts = opts.facts ?? FACTS;
    const jobIds = facts.map((_, i) => `analyze-job-${i + 1}`);
    return {
        oauthScope: "memwal:read memwal:write",
        namespace: "default",
        memwal: {
            async analyze(text: string) {
                calls.push(`analyze:${text.slice(0, 20)}`);
                return {
                    job_ids: jobIds,
                    facts: facts.map((t) => ({ text: t })),
                    fact_count: facts.length,
                    status: "accepted",
                    owner: "0xowner",
                };
            },
            async analyzeAndWait() {
                calls.push("analyzeAndWait");
                throw new Error("analyze must not block to terminal any more");
            },
            async waitForRememberJobs(ids: string[]) {
                calls.push(`waitJobs:${ids.join(",")}`);
                const states = opts.states ?? facts.map(() => "done" as const);
                return {
                    results: states.map((status, i) => ({
                        id: jobIds[i],
                        blob_id: status === "done" ? `blob-${i + 1}` : "",
                        status,
                        namespace: "default",
                    })),
                    total: states.length,
                    succeeded: states.filter((s) => s === "done").length,
                    // Deliberately total-minus-succeeded, because that is what
                    // the real `waitForRememberJobs` returns — a `timeout`
                    // counts here. A stub that filtered on "failed" instead
                    // would model a value the SDK never produces, and the
                    // still-uploading-counted-as-failed case below could not
                    // fail no matter what the tool printed.
                    failed: states.length - states.filter((s) => s === "done").length,
                };
            },
        },
    } as unknown as MemWalSession;
}

async function callAnalyze(
    session: MemWalSession,
    t: TestContext,
    text = "a long note about the user",
): Promise<string> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(session);
    const client = new Client({ name: "analyze-test", version: "1.0.0" });
    t.after(async () => {
        await client.close();
        await server.close();
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
        name: "memwal_analyze",
        arguments: { text },
    });
    return (result as { content: Array<{ text: string }> }).content
        .map((c) => c.text)
        .join("\n");
}

test("analyze never blocks to terminal", async (t) => {
    const calls: string[] = [];
    await callAnalyze(sessionWith({}, calls), t);
    assert.ok(
        !calls.includes("analyzeAndWait"),
        `took the blocking path: ${calls.join(", ")}`,
    );
    assert.ok(calls.some((c) => c.startsWith("analyze:")), calls.join(", "));
});

test("the extracted facts come back even though the writes have not landed", async (t) => {
    // Extraction is the half an agent can use straight away. Handing back only
    // job_ids would make the tool useless until a second call.
    const text = await callAnalyze(sessionWith(), t);
    for (const fact of FACTS) assert.match(text, new RegExp(fact));
});

test("an in-flight analyze does not read as saved", async (t) => {
    const text = await callAnalyze(sessionWith({ states: ["timeout", "timeout"] }), t);
    assert.match(text, /NOT SAVED YET|ACCEPTED, NOT YET SAVED/);
    assert.match(text, /memwal_remember_status/);
    assert.doesNotMatch(text, /^Saved to Walrus Memory/m);
});

test("every job_id is paired with the fact it carries", async (t) => {
    // "one of these failed" is only actionable if the agent can tell which.
    const text = await callAnalyze(sessionWith({ states: ["timeout", "timeout"] }), t);
    assert.match(text, /analyze-job-1/);
    assert.match(text, /analyze-job-2/);
    assert.match(text, /analyze-job-1 — User drinks oat milk/);
});

test("a partly landed batch reports both halves", async (t) => {
    const text = await callAnalyze(sessionWith({ states: ["done", "timeout"] }), t);
    assert.match(text, /blob-1/, "the landed write shows its blob_id");
    assert.match(text, /analyze-job-2/, "the straggler shows its job_id");
    assert.match(text, /memwal_remember_status/, "and how to settle it");
});

test("a still-uploading write is not counted or labelled as failed", async (t) => {
    // The straggler block already tells the agent this job is on its way and
    // must not be re-sent. Printing `failed=1` next to it contradicts that,
    // and an agent that believes the count re-sends — a duplicate paid Walrus
    // write queued behind the original.
    const text = await callAnalyze(sessionWith({ states: ["done", "timeout"] }), t);
    assert.doesNotMatch(text, /failed=/, "a timeout is in flight, not failed");
    assert.match(text, /1 still uploading/, "it is counted as in flight instead");
    assert.doesNotMatch(text, /\[timeout\]/, "and not labelled with the raw status");
    assert.match(text, /still uploading, job_id=analyze-job-2/);
});

test("a genuinely failed write is still counted as failed", async (t) => {
    const text = await callAnalyze(sessionWith({ states: ["done", "failed"] }), t);
    assert.match(text, /failed=1/, "a terminal failure must still be reported");
    assert.doesNotMatch(text, /still uploading/);
});

test("text with nothing worth saving says so instead of handing back an empty batch", async (t) => {
    const text = await callAnalyze(sessionWith({ facts: [] }), t);
    assert.match(text, /Extracted 0 facts/);
    assert.match(text, /nothing was saved/);
    assert.doesNotMatch(text, /memwal_remember_status/);
});
