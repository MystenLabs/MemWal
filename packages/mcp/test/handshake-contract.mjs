#!/usr/bin/env node
/**
 * Live handshake-contract probe for the WALM-368 dogfood protocol.
 *
 * NOT a `*.test.mjs` file on purpose: it needs a real relayer and real
 * credentials, so `npm test`'s `test/**\/*.test.mjs` glob must not pick it up
 * and break CI. Run it by hand before and after a relayer deploy.
 *
 *   node test/handshake-contract.mjs --dev
 *   node test/handshake-contract.mjs --staging
 *   node test/handshake-contract.mjs --local
 *
 * WHY THIS EXISTS
 *
 * On WALM-368 two dogfood passes recorded proactive save/recall as failing
 * while a third recorded it passing, and the runs could not be compared:
 * nobody captured what the client was actually handed. Three separate traps
 * produced that ambiguity, and this probe closes all three.
 *
 *   1. A relayer that had not redeployed yet. The tool metadata that matters
 *      lives in services/server/scripts, so a published npm package alone
 *      changes nothing for a signed-in user. Testing before the deploy lands
 *      measures the old server and looks like the fix failed.
 *   2. Cold start vs post-connect drift. The bridge answers the first
 *      `tools/list` locally from TOOL_DEFINITIONS, then emits
 *      `notifications/tools/list_changed` and the client re-lists against the
 *      relayer. The two lists disagreed in exactly the fields under test, so
 *      the answer depended on when you looked.
 *   3. Reading the chat UI instead of the wire. A tool card cannot tell
 *      "never called" from "called and failed".
 *
 * WHAT THIS DOES NOT DO
 *
 * T1/T2/T3 are model-behaviour tests and cannot be automated from here: they
 * need a real client, a restart, and a human. This probe verifies the
 * PRECONDITIONS those tests depend on. If it fails, a T1-T3 run is not worth
 * doing yet, because a failure would be unattributable. If it passes, a T1-T3
 * failure is a genuine behavioural result rather than a delivery problem.
 * See the runbook printed at the end.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "../dist/bin/memwal-mcp.js");

const ENV_FLAG = process.argv.find((a) => /^--(dev|staging|prod|local)$/.test(a)) || "--dev";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 30_000);

/** Guidance that inverts the proactive contract. Must appear nowhere. */
const ANTI_PROACTIVE = /Call ONLY when the user explicitly asks/i;

function connect() {
    return new Promise((done) => {
        const child = spawn("node", [SERVER, ENV_FLAG], {
            env: { ...process.env, MEMWAL_LOG_LEVEL: "error" },
            stdio: ["pipe", "pipe", "pipe"],
        });
        const out = { init: null, cold: null, upstream: null, changed: false, stderr: "" };
        let buf = "";
        const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
        const finish = () => { child.kill("SIGKILL"); done(out); };
        const timer = setTimeout(finish, TIMEOUT_MS);

        child.stderr.on("data", (d) => { out.stderr += d.toString(); });
        child.stdout.on("data", (d) => {
            buf += d.toString();
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (!line) continue;
                let m; try { m = JSON.parse(line); } catch { continue; }
                if (m.id === 1 && m.result) {
                    out.init = m.result;
                    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
                } else if (m.id === 2 && m.result) {
                    out.cold = m.result.tools;
                } else if (m.method === "notifications/tools/list_changed") {
                    out.changed = true;
                    send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
                } else if (m.id === 3 && m.result) {
                    out.upstream = m.result.tools;
                    clearTimeout(timer);
                    finish();
                }
            }
        });

        send({
            jsonrpc: "2.0", id: 1, method: "initialize",
            params: {
                protocolVersion: "2025-06-18", capabilities: {},
                clientInfo: { name: "handshake-contract-probe", version: "1" },
            },
        });
    });
}

const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok, detail });

const r = await connect();
const byName = (list) => Object.fromEntries((list || []).map((t) => [t.name, t]));
const cold = byName(r.cold);
const up = byName(r.upstream);
// Distinguish the two ways `upstream` can be missing. Conflating them sends a
// tester to re-login when the real problem is a relayer that is down or
// redeploying — which is exactly what a mid-deploy 502 looks like here.
const hasCredentials = (r.init?.instructions || "").length > 500;
const signedIn = Boolean(r.upstream);

// --- 1. initialize carries instructions -------------------------------------
const instructions = r.init?.instructions || "";
check("initialize carries instructions", instructions.length > 0, `${instructions.length} chars`);
if (signedIn) {
    // Assert both halves carry a TURN ANCHOR, not just the words "proactive".
    // The RECALL line always had one ("before answering..."); REMEMBER did not,
    // and on WALM-368 that was the half the model ignored while obeying the
    // other. Anchoring is the property under test, so test for it directly.
    check(
        "RECALL is anchored to a turn event",
        /RECALL: before answering/i.test(instructions.replace(/\s+/g, " ")),
        "before answering..."
    );
    // The payload is newline-wrapped for readability, so every phrase match
    // must tolerate a line break mid-sentence. Matching literal spaces here
    // silently fails on correct output.
    const flat = instructions.replace(/\s+/g, " ");
    check(
        "REMEMBER is anchored to a turn event",
        /REMEMBER:/.test(flat) &&
            /in that same turn, before you finish replying/i.test(flat) &&
            /Do not ask whether to save it/i.test(flat),
        "in that same turn, before you finish replying"
    );
}

// --- 2. the client reached the relayer --------------------------------------
check(
    "relayer connected and client re-listed",
    signedIn,
    signedIn
        ? "tools/list_changed received"
        : hasCredentials
          ? "credentials FOUND but relayer never connected — relayer down or redeploying?"
          : "no credentials — sign in, then re-run"
);

// --- 3. no list tells the model to wait to be asked --------------------------
// Only meaningful for a signed-in client. #706 made the signed-out stub
// deliberately conservative ("call ONLY when the user explicitly asks"),
// which is correct there: without credentials every memory tool fails, so
// proactive wording would only manufacture errors.
if (signedIn) {
    for (const [label, list] of [["cold-start", r.cold], ["upstream", r.upstream]]) {
        if (!list) continue;
        const bad = list.filter((t) => ANTI_PROACTIVE.test(t.description || ""));
        check(`${label} list has no anti-proactive wording`, bad.length === 0, bad.map((t) => t.name).join(", "));
    }
}

// --- 4. the two calls that must fire unprompted are advertised as proactive --
if (signedIn) {
    for (const [label, list] of [["cold-start", cold], ["upstream", up]]) {
        if (!Object.keys(list).length) continue;
        for (const n of ["memwal_remember", "memwal_recall"]) {
            check(`${label} ${n} is proactive`, /PROACTIVELY/.test(list[n]?.description || ""), n);
        }
    }
}

// --- 5. recall is the read path; it must not be advertised destructive ------
// A client weighs annotations when deciding to act on its own initiative. On
// WALM-368 the desktop client called another connector's readOnly tool in the
// same turn it declined to try memwal_recall, which was flagged destructive.
for (const [label, list] of [["cold-start", cold], ["upstream", up]]) {
    if (!Object.keys(list).length) continue;
    const a = list.memwal_recall?.annotations;
    check(
        `${label} memwal_recall is advertised read-only`,
        a?.readOnlyHint === true && a?.destructiveHint === false,
        `readOnlyHint=${a?.readOnlyHint} destructiveHint=${a?.destructiveHint}`
    );
}

// --- 6. cold start and upstream agree ---------------------------------------
// The drift that made earlier runs unattributable: which answer you got
// depended on whether you looked before or after the re-list.
if (signedIn) {
    const shared = Object.keys(cold).filter((n) => n in up);
    const drift = shared.filter(
        (n) =>
            cold[n].description !== up[n].description ||
            JSON.stringify(cold[n].annotations ?? null) !== JSON.stringify(up[n].annotations ?? null) ||
            (cold[n].title ?? null) !== (up[n].title ?? null)
    );
    check("cold-start and upstream lists agree", drift.length === 0, drift.length ? `drift: ${drift.join(", ")}` : `${shared.length} tools compared`);
}

// --- report -----------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log(`\nHandshake contract — ${ENV_FLAG} — ${signedIn ? "signed in" : hasCredentials ? "credentials present, RELAYER UNREACHABLE" : "SIGNED OUT"}\n`);
for (const c of checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
}
console.log(`\n  ${checks.length - failed.length}/${checks.length} passed\n`);

if (failed.length) {
    console.log("Preconditions are not met. A T1-T3 run now would be unattributable.");
    if (!signedIn && !hasCredentials) {
        console.log(`Sign in first:  node dist/bin/memwal-mcp.js login ${ENV_FLAG}`);
    } else if (!signedIn) {
        console.log("Credentials are present, so this is not a sign-in problem.");
        console.log("The relayer did not answer in time. Check it is up and fully deployed:");
        console.log("  curl -s -o /dev/null -w '%{http_code}\\n' <relayer>/health   # expect 200, not 502");
        console.log("  curl -s <relayer>/version | jq .build.commit");
    } else {
        console.log("If upstream checks fail, the relayer has not redeployed. Confirm with:");
        console.log("  curl -s <relayer>/version | jq .build.commit");
    }
    process.exit(1);
}

console.log(`Preconditions met. The client is handed the proactive contract on ${ENV_FLAG}.

Now run the WALM-368 behaviour cases by hand. Fully quit the client first
(Cmd+Q; closing the window is not enough) so it picks up this build.

  T1  save, unprompted     type:  My laptop is an M3 Max with 64GB of RAM.
                           pass:  memwal_remember fires with no "remember this"
  T2  recall, unprompted   type (NEW chat):  What are the specs of my laptop?
                           pass:  memwal_recall fires and the answer cites it
  T3  negative control     type:  Run the tests for me.
                           pass:  nothing is saved

Score from the MCP log, not the chat UI — a tool card cannot tell "never
called" from "called and failed":

  tail -f ~/Library/Logs/Claude/mcp-server-memwal.log | grep tools/call

T3 only carries information if T1 and T2 fired. With zero calls overall it
passes for the wrong reason and must not be recorded as a pass.
`);
