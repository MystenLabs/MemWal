/**
 * End-to-end exercise of the PR's MCP tools against a LIVE relayer.
 *
 * The unit tests drive these tools through a mocked session. That pins the
 * wording and the branching, but it cannot answer the question that actually
 * matters before merge: does `memwal_remember_bulk` hand back job_ids the
 * real `memwal_remember_status` can then resolve into real blob_ids?
 *
 * So this wires the same in-process MCP server the unit tests use to a real
 * MemWal session, and walks the flow a user's agent would walk. It is not a
 * unit test — it writes paid blobs — which is why it lives here as a script
 * rather than under `node --test`.
 *
 *   NODE_USE_ENV_PROXY=1 MEMWAL_CREDS_DIR=<dir> \
 *     node --import tsx mcp/__tests__/live-e2e.mjs
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemWal } from "@mysten-incubation/memwal";
import { createMcpServer } from "../server.js";

const credsDir = process.env.MEMWAL_CREDS_DIR;
if (!credsDir) throw new Error("set MEMWAL_CREDS_DIR");
const creds = JSON.parse(readFileSync(`${credsDir}/credentials.json`, "utf8"));
const NS = "memwal-probe";

const memwal = new MemWal({
    key: creds.delegatePrivateKey,
    accountId: creds.accountId,
    serverUrl: creds.relayerUrl,
    namespace: NS,
});

const session = {
    accountId: creds.accountId,
    delegateKeyHex: creds.delegatePrivateKey,
    delegatePubKeyHex: creds.delegatePublicKeyHex,
    namespace: NS,
    memwal,
    relayerUrl: creds.relayerUrl,
    authMethod: "delegate-key",
    oauthScope: "memwal:read memwal:write",
    agentClient: "other",
};

const server = createMcpServer(session);
const client = new Client({ name: "live-e2e", version: "1.0.0" }, { capabilities: {} });
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(clientT), server.connect(serverT)]);

const ms = () => performance.now();
const fmt = (n) => (n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`);
const textOf = (r) => r.content?.[0]?.text ?? "";

async function call(name, args) {
    const t0 = ms();
    const r = await client.callTool({ name, arguments: args });
    return { ms: ms() - t0, text: textOf(r), isError: r.isError === true };
}

function show(label, r, extra = "") {
    console.log(
        `  ${label.padEnd(30)} ${fmt(r.ms).padStart(8)}  ${r.isError ? "ERR " : "ok  "} ${extra}`,
    );
}

const stamp = new Date().toISOString();
const failures = [];
function check(name, fn) {
    try {
        fn();
        console.log(`  ✔ ${name}`);
    } catch (e) {
        failures.push(name);
        console.log(`  ✖ ${name}\n      ${e.message.split("\n")[0]}`);
    }
}

console.log(`\nlive e2e — relayer ${creds.relayerUrl}  ns=${NS}\n`);

// ── single write ────────────────────────────────────────────────
console.log("single remember → status");
const single = await call("memwal_remember", {
    text: `live-e2e single ${stamp}`,
    namespace: NS,
});
show("memwal_remember", single);
const singleJob = /job_id=([0-9a-f-]+)/.exec(single.text)?.[1];

check("remember returns fast", () => assert.ok(single.ms < 5000, `${fmt(single.ms)}`));
check("remember hands back a job_id", () => assert.ok(singleJob, single.text.slice(0, 120)));
check("remember does not claim it is saved", () =>
    assert.doesNotMatch(single.text, /Saved to Walrus Memory/));

const statusNoWait = await call("memwal_remember_status", { job_id: singleJob, waitMs: 0 });
show("status waitMs=0", statusNoWait);
check("waitMs=0 answers immediately", () =>
    assert.ok(statusNoWait.ms < 3000, `${fmt(statusNoWait.ms)}`));

// ── bulk write → job_ids → batch status ─────────────────────────
console.log("\nbulk remember → status with job_ids");
const bulk = await call("memwal_remember_bulk", {
    namespace: NS,
    facts: [1, 2, 3].map((i) => `live-e2e bulk ${stamp} item ${i}`),
});
show("memwal_remember_bulk", bulk);
const bulkJobs = [...bulk.text.matchAll(/job_id=([0-9a-f-]+)/g)].map((m) => m[1]);

check("bulk returns fast", () => assert.ok(bulk.ms < 10_000, `${fmt(bulk.ms)}`));
check("bulk hands back one job_id per fact", () =>
    assert.equal(bulkJobs.length, 3, `got ${bulkJobs.length}: ${bulk.text.slice(0, 200)}`));
check("bulk pairs each job_id with its fact", () =>
    assert.match(bulk.text, /item 1/));

// THE question: does job_ids actually resolve to data?
// 45s is the tool's ceiling — deliberately under the MCP client's own 60s
// request deadline, so the tool answers rather than the client giving up.
const batch = await call("memwal_remember_status", { job_ids: bulkJobs, waitMs: 45_000 });
show("status job_ids (45s budget)", batch);
check("job_ids returns a line per job", () => {
    // Guard the loop: with no ids collected it would pass by doing nothing,
    // which is exactly the case this check exists to catch.
    assert.ok(bulkJobs.length > 0, "no job_ids to resolve");
    for (const id of bulkJobs) assert.match(batch.text, new RegExp(id.slice(0, 8)));
});
check("job_ids accounts for every job, saved or not", () => {
    // Not "must have blob_ids": measured p50 is ~34s and p90 ~65s, so a 45s
    // budget legitimately expires with writes still in flight. What must hold
    // is that every job comes back with a definite state and the report never
    // reads as success when nothing landed.
    assert.match(batch.text, /\d+\/\d+ saved/, batch.text.slice(0, 200));
    const blobs = [...batch.text.matchAll(/blob_id=([A-Za-z0-9_-]{20,})/g)];
    const saved = Number(/(\d+)\/\d+ saved/.exec(batch.text)?.[1] ?? "0");
    assert.equal(blobs.length, saved, "a blob_id for each job reported saved, and no more");
    if (saved === 0) assert.match(batch.text, /still uploading/);
});

// ── edge cases ──────────────────────────────────────────────────
console.log("\nedge cases");
const both = await call("memwal_remember_status", { job_id: "a", job_ids: ["b"] });
show("job_id + job_ids together", both);
check("rejects both ids at once", () => assert.ok(both.isError || /not both/i.test(both.text)));

const neither = await call("memwal_remember_status", {});
show("neither id", neither);
check("rejects an empty call", () => assert.ok(neither.isError || /Pass job_id/i.test(neither.text)));

const unknown = await call("memwal_remember_status", {
    job_id: "00000000-0000-0000-0000-000000000000",
    waitMs: 0,
});
show("unknown job_id", unknown);
check("an unknown job is an error, not a silent ok", () =>
    assert.ok(unknown.isError || /not found/i.test(unknown.text)));

// ── recall, including the failed-write report ───────────────────
console.log("\nrecall");
const recall = await call("memwal_recall", { query: "live-e2e", limit: 5 });
show("memwal_recall", recall, `${recall.text.split("\n").length} lines`);
check("recall answers under the SDK's 15s abort", () =>
    assert.ok(recall.ms < 15_000, `${fmt(recall.ms)}`));
check("recall never invents a failure report", () => {
    if (/FAILED/.test(recall.text)) assert.match(recall.text, /NOT stored/);
});

console.log(`\n${failures.length === 0 ? "all checks passed" : `${failures.length} FAILED: ${failures.join(", ")}`}\n`);
process.exit(failures.length === 0 ? 0 : 1);
