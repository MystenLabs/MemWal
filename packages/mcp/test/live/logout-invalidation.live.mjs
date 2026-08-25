/**
 * LIVE end-to-end check for `memwal_logout` session invalidation (GH #616).
 *
 * Opt-in, never run by `npm test`: the filename ends in `.live.mjs` so the
 * `test/**\/*.test.mjs` glob skips it, and it exits early unless
 * `MEMWAL_LIVE_HOME` points at a directory holding valid credentials.
 *
 * Why this exists alongside the hermetic suite: those tests assert against a
 * hand-rolled mock relayer, so they prove the bridge's *intent* but not that the
 * real handshake matches the mock, nor that `sse.abort()` actually drops the
 * real connection. This script closes both gaps by talking to a real relayer and
 * watching the process's own sockets.
 *
 * Usage:
 *   MEMWAL_LIVE_HOME=/path/to/sandbox-home \
 *   MEMWAL_LIVE_RELAYER=https://relayer.dev.memwal.ai \
 *     node test/live/logout-invalidation.live.mjs
 *
 * The sandbox HOME must contain `.memwal/credentials.json`. It is COPIED to a
 * throwaway directory first — logout deletes the credentials file, and this
 * script must not consume the ones you minted.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../../dist/bin/memwal-mcp.js");

const SOURCE_HOME = process.env.MEMWAL_LIVE_HOME;
const RELAYER = process.env.MEMWAL_LIVE_RELAYER;
if (!SOURCE_HOME || !RELAYER) {
    console.log("SKIP: set MEMWAL_LIVE_HOME and MEMWAL_LIVE_RELAYER to run the live check.");
    process.exit(0);
}

const sourceCreds = join(SOURCE_HOME, ".memwal", "credentials.json");
assert.ok(existsSync(sourceCreds), `no credentials at ${sourceCreds}`);

// Work on a copy: logout deletes this file.
const home = mkdtempSync(join(tmpdir(), "memwal-live-logout-"));
const credsPath = join(home, ".memwal", "credentials.json");
mkdirSync(dirname(credsPath), { recursive: true });
copyFileSync(sourceCreds, credsPath);
const creds = JSON.parse(readFileSync(credsPath, "utf8"));

console.log(`relayer:  ${RELAYER}`);
console.log(`account:  ${creds.accountId}`);
console.log(`delegate: ${creds.delegateAddress}`);
console.log(`sandbox:  ${home}\n`);

const child = spawn(process.execPath, [BIN, "--relayer", RELAYER, "--web-url", RELAYER], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "pipe", "pipe"],
});

const received = [];
const listeners = new Set();
let buf = "";
child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            continue;
        }
        received.push(msg);
        for (const l of [...listeners]) l(msg);
    }
});
let stderrBuf = "";
child.stderr.on("data", (d) => (stderrBuf += d.toString()));

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const waitFor = (pred, ms = 30000) => {
    const hit = received.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
        const timer = setTimeout(() => {
            listeners.delete(l);
            rej(new Error(`timed out\n--- stderr ---\n${stderrBuf}`));
        }, ms);
        const l = (m) => {
            if (pred(m)) {
                clearTimeout(timer);
                listeners.delete(l);
                res(m);
            }
        };
        listeners.add(l);
    });
};

/** Count this process's ESTABLISHED TLS sockets. The bridge only talks to the
 * relayer, so this is a direct read on whether the SSE connection is really
 * gone — the assertion the mock suite cannot make. */
function establishedTlsSockets() {
    try {
        // `-a` is load-bearing: lsof ORs its selection options by default, so
        // without it this reports every established socket on the machine
        // instead of just this child's.
        const out = execFileSync(
            "lsof",
            ["-nP", "-a", "-p", String(child.pid), "-iTCP", "-sTCP:ESTABLISHED"],
            { encoding: "utf8" },
        );
        return out.split("\n").filter((l) => l.includes(":443")).length;
    } catch {
        return 0; // lsof exits non-zero when there are no matching sockets
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, fn) {
    try {
        fn();
        console.log(`  PASS  ${label}`);
    } catch (err) {
        failures += 1;
        console.log(`  FAIL  ${label}\n        ${err.message}`);
    }
}

try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    const init = await waitFor((m) => m.id === 1 && m.result);
    check("initialize handshake", () =>
        assert.equal(init.result.serverInfo.name, "memwal"),
    );

    // Real upstream tool list — proves we are speaking the actual protocol and
    // not just the mock's approximation of it.
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await sleep(4000);
    send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const tools = await waitFor((m) => m.id === 3 && m.result?.tools);
    const names = tools.result.tools.map((t) => t.name);
    check(`upstream tools/list carries real memory tools (${names.length} tools)`, () =>
        assert.ok(names.includes("memwal_recall"), `got: ${names.join(", ")}`),
    );

    send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "walrus memory", limit: 1 } },
    });
    const before = await waitFor((m) => m.id === 4);
    check("baseline recall reaches the live relayer", () =>
        assert.notEqual(before.result?.isError, true, JSON.stringify(before.result)),
    );

    const socketsBefore = establishedTlsSockets();
    check("an SSE connection to the relayer is open before logout", () =>
        assert.ok(socketsBefore >= 1, `saw ${socketsBefore} established TLS sockets`),
    );

    send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "memwal_logout", arguments: {} } });
    const logout = await waitFor((m) => m.id === 5);
    check("logout succeeds", () => assert.notEqual(logout.result?.isError, true));
    check("credentials file removed", () => assert.equal(existsSync(credsPath), false));

    await sleep(2000);
    const socketsAfter = establishedTlsSockets();
    // NOT asserting zero sockets. The relayer negotiates HTTP/2, so every
    // request multiplexes over one pooled TCP connection: `sse.abort()` sends
    // RST_STREAM, which ends the SSE stream while undici keeps the socket for
    // reuse. A zero-socket assertion would fail here no matter how correct the
    // teardown is. What must hold is that the bridge tore the session down and
    // opened nothing new.
    check("bridge reports the session torn down", () =>
        assert.match(stderrBuf, /bridge\.session_invalidated/),
    );
    check(`no new connection opened by logout (${socketsBefore} -> ${socketsAfter})`, () =>
        assert.ok(socketsAfter <= socketsBefore, `grew from ${socketsBefore} to ${socketsAfter}`),
    );

    send({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "walrus memory", limit: 1 } },
    });
    const after = await waitFor((m) => m.id === 6);
    check("post-logout recall is refused", () =>
        assert.equal(after.result?.isError, true, JSON.stringify(after.result)),
    );
    check("refusal is the signed-out message, not a relayer error", () =>
        assert.match(JSON.stringify(after.result), /Signed out of Walrus Memory/),
    );

    await sleep(2000);
    check("the refused call opens no new connection to the relayer", () =>
        assert.ok(
            establishedTlsSockets() <= socketsBefore,
            `grew from ${socketsBefore} to ${establishedTlsSockets()}`,
        ),
    );
    // The strongest available client-side proof that nothing was sent: a real
    // recall returns relayer content, and this one did not.
    check("no relayer response leaked into the refused call", () =>
        assert.doesNotMatch(JSON.stringify(after.result), /memor(y|ies) found|RECALL/i),
    );
} finally {
    child.kill("SIGKILL");
}

console.log(failures === 0 ? "\nLIVE CHECK PASSED" : `\nLIVE CHECK FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
