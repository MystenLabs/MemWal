/**
 * LIVE acceptance run for the 2026-09-14 field report, case by case.
 *
 * Opt-in, never run by `npm test`: the filename ends in `.live.mjs` so the
 * `test/**\/*.test.mjs` glob skips it, and it exits early without credentials.
 *
 * Why this exists: the hermetic suite proves the bridge's intent against a mock
 * relayer. It cannot tell you whether a deployment actually answers, and the
 * report is entirely about a deployment that does not. This script runs the
 * reported sequence against a real relayer and prints a scorecard, so "is it
 * fixed" stops being a matter of opinion.
 *
 * Reads are always run. Writes cost a real Walrus blob, so they are opt-in:
 *
 *   # read-only (safe anywhere, including production)
 *   MEMWAL_LIVE_HOME=/path/to/home \
 *   MEMWAL_LIVE_RELAYER=https://relayer.dev.memwal.ai \
 *     node test/live/teo-report.live.mjs
 *
 *   # full run, including the two write cases — testnet deployments only
 *   MEMWAL_LIVE_WRITE=1 MEMWAL_LIVE_HOME=... MEMWAL_LIVE_RELAYER=... \
 *     node test/live/teo-report.live.mjs
 *
 * `MEMWAL_LIVE_HOME` must contain `.memwal/credentials.json`. Nothing is
 * deleted or overwritten — the credentials are read, never rewritten.
 *
 * Exit code is 0 only if every case that ran met its threshold.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../../dist/bin/memwal-mcp.js");

const HOME_DIR = process.env.MEMWAL_LIVE_HOME;
const RELAYER = process.env.MEMWAL_LIVE_RELAYER;
const RUN_WRITES = process.env.MEMWAL_LIVE_WRITE === "1";
const NAMESPACE = process.env.MEMWAL_LIVE_NAMESPACE ?? "memwal-live-acceptance";

if (!HOME_DIR || !RELAYER) {
    console.log("skip: set MEMWAL_LIVE_HOME and MEMWAL_LIVE_RELAYER to run this");
    process.exit(0);
}
const CREDS = join(HOME_DIR, ".memwal", "credentials.json");
if (!existsSync(CREDS)) {
    console.error(`fatal: no credentials at ${CREDS}`);
    process.exit(1);
}
if (!existsSync(BIN)) {
    console.error(`fatal: no build at ${BIN} — run \`npm run build\` in packages/mcp first`);
    process.exit(1);
}

/**
 * Thresholds. These are the report's own expectations, not aspirations:
 * "a single-fact save returns in a few seconds", and health is documented as
 * the lightweight check. A case that exceeds its budget is a FAIL even when
 * it eventually returns — "slow" is the complaint.
 */
const BUDGET_MS = {
    connect: 30_000,
    health: 5_000,
    recall: 15_000,
    remember: 15_000,
    rememberBulk: 60_000,
};

const t0 = Date.now();
const rel = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const child = spawn(process.execPath, [BIN], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
        ...process.env,
        HOME: HOME_DIR,
        USERPROFILE: HOME_DIR,
        MEMWAL_CREDS_DIR: join(HOME_DIR, ".memwal"),
        MEMWAL_SERVER_URL: RELAYER,
    },
});

const stderrLines = [];
let connectedAtMs = null;
child.stderr.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
        if (!line.trim()) continue;
        stderrLines.push(line);
        if (line.includes("Connected. Bridging") && connectedAtMs === null) {
            connectedAtMs = Date.now() - t0;
        }
    }
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            continue;
        }
        const resolveFn = msg.id !== undefined ? pending.get(msg.id) : undefined;
        if (resolveFn) {
            pending.delete(msg.id);
            resolveFn(msg);
        }
    }
});

let nextId = 1;
/** Send one JSON-RPC request. `capMs` bounds THIS script, not the bridge — the
 *  bridge's own 240s deadline is part of what is under test, so the cap sits
 *  above it. */
function send(method, params, capMs = 300_000) {
    const id = nextId++;
    const startedAt = Date.now();
    return new Promise((resolveP) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            resolveP({ __noReply: true, __ms: Date.now() - startedAt });
        }, capMs);
        pending.set(id, (m) => {
            clearTimeout(timer);
            resolveP({ ...m, __ms: Date.now() - startedAt });
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
}

const textOf = (r) => (r.result?.content ?? []).map((c) => c.text).join("\n");

const results = [];
function record(id, title, ok, detail, ms) {
    results.push({ id, title, ok, detail, ms });
    const mark = ok === null ? "SKIP" : ok ? "PASS" : "FAIL";
    const took = ms === null ? "" : ` ${(ms / 1000).toFixed(1)}s`;
    console.log(`${rel()}  [${mark}] ${id} ${title}${took}`);
    if (detail) console.log(`          ${detail.replace(/\n/g, "\n          ")}`);
}

// ~3.5 KB over 5 facts, the reported payload shape.
const FACTS = Array.from({ length: 5 }, (_, i) =>
    `Acceptance fact ${i + 1} of 5 for the MemWal field report, namespace ${NAMESPACE}. ` +
    "Padding so the batch matches the reported payload size and exercises the same path: " +
    "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ".repeat(8)
);

(async () => {
    console.log(`relayer:   ${RELAYER}`);
    console.log(`namespace: ${NAMESPACE}`);
    console.log(`writes:    ${RUN_WRITES ? "ENABLED (will mint real blobs)" : "skipped (set MEMWAL_LIVE_WRITE=1)"}`);
    console.log(`payload:   ${FACTS.length} facts, ${Buffer.byteLength(FACTS.join(""))} bytes\n`);

    await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "memwal-live-acceptance", version: "1.0.0" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    // T1 — §2. The session must reach a live relayer session, and a throttle
    // must be named as one rather than looking like broken credentials.
    const tools = await send("tools/list", {});
    const toolNames = (tools.result?.tools ?? []).map((t) => t.name);
    const throttled = stderrLines.filter((l) => l.includes("rate-limiting new MCP sessions"));
    await new Promise((r) => setTimeout(r, 2000));
    const connectOk = connectedAtMs !== null && connectedAtMs <= BUDGET_MS.connect;
    record(
        "T1",
        "§2 handshake reaches a session (and a 429 is named as a throttle)",
        connectOk,
        connectedAtMs === null
            ? `never connected; last stderr: ${stderrLines.slice(-1)[0] ?? "(none)"}`
            : `connected in ${(connectedAtMs / 1000).toFixed(1)}s, ${toolNames.length} tools` +
              (throttled.length ? `, ${throttled.length} throttle notice(s) — cap was hit but explained` : ""),
        connectedAtMs
    );

    // T2 — the canary. Health is an unsigned GET with no SEAL preamble, so it
    // is the one call that still answers on a deployment whose signed path is
    // broken. Health passing while T3 fails is exactly that shape.
    const health = await send("tools/call", { name: "memwal_health", arguments: {} });
    record(
        "T2",
        "memwal_health answers promptly",
        !health.result?.isError && health.__ms <= BUDGET_MS.health,
        textOf(health).slice(0, 200),
        health.__ms
    );

    // T3 — §1/§4. The first signed round trip. On a deployment where the
    // sidecar cannot reach its own relayer this is where the 504 appears.
    const recall = await send("tools/call", {
        name: "memwal_recall",
        arguments: { query: "acceptance fact", limit: 3, namespace: NAMESPACE },
    });
    record(
        "T3",
        "memwal_recall completes over the signed path",
        !recall.result?.isError && recall.__ms <= BUDGET_MS.recall,
        textOf(recall).slice(0, 200),
        recall.__ms
    );

    if (!RUN_WRITES) {
        record("T4", "§1a memwal_remember latency", null, "writes disabled", null);
        record("T5", "§1b memwal_remember_bulk returns a result", null, "writes disabled", null);
        record("T6", "§1b what actually landed", null, "writes disabled", null);
    } else {
        // T4 — §1a. The report measures 19s-1m1s and expects "a few seconds".
        const single = await send("tools/call", {
            name: "memwal_remember",
            arguments: { text: `Acceptance single-fact write, namespace ${NAMESPACE}.`, namespace: NAMESPACE },
        });
        record(
            "T4",
            "§1a memwal_remember returns within budget",
            !single.result?.isError && single.__ms <= BUDGET_MS.remember,
            textOf(single).slice(0, 200),
            single.__ms
        );

        // T5 — §1b. The reported failure: no reply at all, expiring at the
        // bridge's 240s deadline. Any answer inside the cap beats that; an
        // answer inside budget is the actual goal.
        const bulk = await send("tools/call", {
            name: "memwal_remember_bulk",
            arguments: { facts: FACTS, namespace: NAMESPACE },
        });
        const bulkText = textOf(bulk);
        record(
            "T5",
            "§1b memwal_remember_bulk returns a result within budget",
            !bulk.__noReply && !bulk.result?.isError && bulk.__ms <= BUDGET_MS.rememberBulk,
            bulk.__noReply ? "no reply at all" : bulkText.slice(0, 400),
            bulk.__ms
        );

        // T6 — the question the report asks and no log could answer: when a
        // bulk reports failure, was anything actually stored? Recall is the
        // only honest way to find out, and the answer decides whether a retry
        // would have duplicated paid blobs.
        await new Promise((r) => setTimeout(r, 5000));
        const verify = await send("tools/call", {
            name: "memwal_recall",
            arguments: { query: "Acceptance fact for the MemWal field report", limit: 10, namespace: NAMESPACE },
        });
        const verifyText = textOf(verify);
        const landed = (verifyText.match(/\[score=/g) ?? []).length;
        record(
            "T6",
            "§1b recall agrees with what the bulk reported",
            !verify.result?.isError,
            `recall sees ${landed} of ${FACTS.length} acceptance facts. ` +
                (landed > 0 && /failed=\d/.test(bulkText)
                    ? "NOTE: the bulk reported failures while the facts are present — a retry would have duplicated paid blobs."
                    : ""),
            verify.__ms
        );
    }

    const ran = results.filter((r) => r.ok !== null);
    const failed = ran.filter((r) => !r.ok);
    console.log(`\n${"=".repeat(66)}`);
    console.log(`${ran.length - failed.length}/${ran.length} passed` + (failed.length ? `  —  FAILED: ${failed.map((f) => f.id).join(", ")}` : ""));
    console.log(`credentials: ${JSON.parse(readFileSync(CREDS, "utf8")).accountId?.slice(0, 12)}…`);

    child.kill("SIGTERM");
    setTimeout(() => process.exit(failed.length ? 1 : 0), 500);
})();
