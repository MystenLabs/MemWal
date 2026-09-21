/**
 * Regression test for GH #928 — a `tools/call` for a tool the connected relayer
 * does not serve must be refused locally and immediately.
 *
 * What happened live: the bridge ships on npm and updates itself, a relayer
 * ships per environment and does not, so 0.0.14-dev.0 talked to prod and
 * staging still on 0.0.13. Its cold-start list advertised
 * `memwal_remember_status`, and the pending-write wording told the agent to go
 * call it. Neither relayer registers that tool, so the call was forwarded into
 * a session that would never answer it and sat in `inFlight` until the orphan
 * sweeper's deadline: one run spent 90.67s before erroring.
 *
 * The relayer's own `tools/list` is the authority on what it serves. Once the
 * bridge has seen it, a call for anything outside that set (plus the two tools
 * the bridge serves itself) is answered here — a stale tool list is not a
 * transport fault, and the agent can only act on it if it is told now.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { unknownToolText } from "../dist/bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../dist/bin/memwal-mcp.js");
const EXPECTED_BEARER = "a".repeat(64);
const EXPECTED_ACCOUNT_ID = "0x" + "3".repeat(64);

/** What a 0.0.13 relayer registers: no `memwal_remember_status`. */
const OLD_RELAYER_TOOLS = [
    "memwal_remember",
    "memwal_remember_bulk",
    "memwal_recall",
    "memwal_analyze",
    "memwal_restore",
    "memwal_health",
];

/** The tool the newer bridge knows about and this relayer has never heard of. */
const MISSING_TOOL = "memwal_remember_status";

test("the refusal tells the agent what exists and that nothing ran", () => {
    const text = unknownToolText(MISSING_TOOL, [...OLD_RELAYER_TOOLS, "memwal_login"].sort());

    // Which tool was refused, or the agent cannot tell which of several calls
    // this answers.
    assert.match(text, new RegExp(MISSING_TOOL));
    // What to do instead: the list it holds is stale, and here is the real one.
    assert.match(text, /tools\/list/);
    for (const name of OLD_RELAYER_TOOLS) assert.match(text, new RegExp(name));
    // A write tool that errors is ambiguous about whether the write happened.
    // Say it plainly: an agent that guesses here tells the user a fact is
    // saved when it never left the process.
    assert.match(text, /nothing was saved/i);
});

function hasBridgeAuth(req) {
    return (
        req.headers.authorization === `Bearer ${EXPECTED_BEARER}` &&
        req.headers["x-memwal-account-id"] === EXPECTED_ACCOUNT_ID
    );
}

/** Relayer on the OLD tool set. It answers what it knows and stays silent on
 * anything else — which is what a call for an unregistered tool looks like from
 * the bridge's side, and what made the old behaviour a 90s wait. */
function startOldRelayer() {
    const sessions = new Map();
    const callsSeen = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/version") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    apiVersion: "1.0.0",
                    relayerVersion: "0.0.13",
                    minSupportedSdk: { mcp: "0.0.1" },
                }),
            );
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/mcp/sse") {
            if (!hasBridgeAuth(req)) {
                res.writeHead(401);
                res.end();
                return;
            }
            const sessionId = `session-${sessions.size + 1}`;
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            res.write(`event: endpoint\ndata: /api/mcp/messages?sessionId=${sessionId}\n\n`);
            sessions.set(sessionId, { res });
            const hb = setInterval(() => {
                if (res.writableEnded) {
                    clearInterval(hb);
                    return;
                }
                res.write(":\n\n");
            }, 200);
            hb.unref?.();
            res.on("close", () => clearInterval(hb));
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/mcp/messages") {
            if (!hasBridgeAuth(req)) {
                res.writeHead(401);
                res.end();
                return;
            }
            const session = sessions.get(url.searchParams.get("sessionId"));
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                if (!session) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                res.writeHead(202);
                res.end();
                let msg;
                try {
                    msg = JSON.parse(body);
                } catch {
                    return;
                }
                const reply = (result) =>
                    session.res.write(
                        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`,
                    );
                if (msg.method === "initialize") {
                    reply({
                        protocolVersion: "2024-11-05",
                        capabilities: { tools: { listChanged: true } },
                        serverInfo: { name: "memwal-upstream", version: "0.0.13" },
                    });
                    return;
                }
                if (msg.method === "tools/list") {
                    reply({
                        tools: OLD_RELAYER_TOOLS.map((name) => ({
                            name,
                            description: `upstream ${name}`,
                            inputSchema: { type: "object" },
                        })),
                    });
                    return;
                }
                if (msg.method === "tools/call") {
                    callsSeen.push(msg.params?.name);
                    if (msg.params?.name === "memwal_health") {
                        reply({
                            content: [{ type: "text", text: "status=ok version=0.0.13" }],
                            isError: false,
                        });
                    }
                    // Anything else: silence, exactly as an unregistered tool
                    // would behave if the call ever got this far.
                    return;
                }
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise((res) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            res({ server, base: `http://127.0.0.1:${port}`, callsSeen });
        });
    });
}

function makeCreds(relayerUrl) {
    return {
        delegatePrivateKey: EXPECTED_BEARER,
        delegatePublicKeyHex: "b".repeat(64),
        delegateAddress: "0x" + "1".repeat(64),
        walletAddress: "0x" + "2".repeat(64),
        accountId: EXPECTED_ACCOUNT_ID,
        packageId: "0x" + "4".repeat(64),
        relayerUrl,
        label: "Tool-not-served Test",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

test("a tool the relayer does not serve is refused locally, not waited out", async (t) => {
    const mock = await startOldRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-toolskew-test-"));
    const credsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    const child = spawn(process.execPath, [BIN, "--relayer", mock.base, "--web-url", mock.base], {
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
            received.push({ msg, at: Date.now() });
            for (const l of [...listeners]) l(msg);
        }
    });
    let stderrBuf = "";
    child.stderr.on("data", (d) => (stderrBuf += d.toString()));

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    const waitFor = (pred, ms = 15000) => {
        const hit = received.find((r) => pred(r.msg));
        if (hit) return Promise.resolve(hit.msg);
        return new Promise((res, rej) => {
            const timer = setTimeout(() => {
                listeners.delete(l);
                rej(
                    new Error(
                        `timed out waiting for message\n--- stderr ---\n${stderrBuf}\n--- received ---\n${received.map((r) => JSON.stringify(r.msg)).join("\n")}`,
                    ),
                );
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

    t.after(() => {
        child.kill("SIGKILL");
        mock.server.close();
        rmSync(home, { recursive: true, force: true });
    });

    send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "toolskew-test", version: "1.0.0" },
        },
    });
    await waitFor((m) => m.id === 1 && m.result, 10_000);

    // The cold-start list is a floor, so it must not name the tool this relayer
    // lacks even before anything upstream is known.
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const cold = await waitFor((m) => m.id === 2 && m.result, 10_000);
    assert.ok(
        !cold.result.tools.some((tool) => tool.name === MISSING_TOOL),
        `cold-start tools/list advertises ${MISSING_TOOL}, which no released relayer serves`,
    );

    // Cold-start window: initialize instructions used to name this tool, and
    // the gate used to fail open while `upstreamToolNames` was empty (it is
    // only filled from a forwarded `tools/list`; the cold-start list is
    // answered locally). Call it here, before any forwarded list.
    const coldCallStarted = Date.now();
    send({
        jsonrpc: "2.0",
        id: "cold-missing",
        method: "tools/call",
        params: { name: MISSING_TOOL, arguments: { job_id: "job-1" } },
    });
    const coldRefusal = await waitFor((m) => m.id === "cold-missing", 10_000);
    const coldElapsed = Date.now() - coldCallStarted;
    assert.equal(
        coldRefusal.result?.isError,
        true,
        `expected a local error during cold start, got ${JSON.stringify(coldRefusal)}`,
    );
    assert.match(coldRefusal.result.content[0].text, new RegExp(MISSING_TOOL));
    assert.match(coldRefusal.result.content[0].text, /tools\/list/);
    assert.match(coldRefusal.result.content[0].text, /nothing was saved/i);
    assert.ok(
        coldElapsed < 5_000,
        `cold-start refusal took ${coldElapsed}ms — expected it answered locally, not at the orphan deadline`,
    );
    assert.ok(
        !mock.callsSeen.includes(MISSING_TOOL),
        `bridge forwarded ${MISSING_TOOL} during cold start: ${mock.callsSeen}`,
    );

    // Re-list once connected so the bridge learns what this relayer actually
    // registers. That reply is the authority the refusal below is based on.
    await waitFor((m) => m.method === "notifications/tools/list_changed", 10_000);
    send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const upstream = await waitFor((m) => m.id === 3 && m.result, 10_000);
    const upstreamNames = upstream.result.tools.map((tool) => tool.name);
    assert.ok(
        upstreamNames.includes("memwal_recall"),
        `expected the relayer's own tool list, got ${upstreamNames}`,
    );
    assert.ok(!upstreamNames.includes(MISSING_TOOL));

    // The call the live run made. Before the fix it was forwarded and left to
    // the orphan sweeper: 60s tool ceiling + 30s headroom.
    const startedAt = Date.now();
    send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: MISSING_TOOL, arguments: { job_id: "job-1" } },
    });
    const refusal = await waitFor((m) => m.id === 4, 10_000);
    const elapsed = Date.now() - startedAt;

    assert.equal(refusal.result?.isError, true, `expected an error result, got ${JSON.stringify(refusal)}`);
    const text = refusal.result.content[0].text;
    assert.match(text, new RegExp(MISSING_TOOL));
    // The agent's way out has to be in the message: which tools exist, and that
    // its own list is what is wrong.
    assert.match(text, /tools\/list/);
    assert.match(text, /memwal_recall/);
    // And it must be unambiguous that the write did not happen, or the agent
    // reports a fact as saved on the strength of an error.
    assert.match(text, /nothing was saved/i);
    assert.ok(
        elapsed < 5_000,
        `refusal took ${elapsed}ms — expected it answered locally, not at the orphan deadline`,
    );

    // Proof it never left the process: the relayer saw the health call we made
    // nothing of, and never the missing tool.
    assert.ok(
        !mock.callsSeen.includes(MISSING_TOOL),
        `bridge forwarded ${MISSING_TOOL} upstream: ${mock.callsSeen}`,
    );

    // A tool the relayer DOES serve still goes through, so the gate is a filter
    // and not a wall.
    send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "memwal_health", arguments: {} },
    });
    const health = await waitFor((m) => m.id === 5 && m.result, 10_000);
    assert.notEqual(health.result?.isError, true);
    assert.match(JSON.stringify(health.result), /status=ok/);
});

/** First session advertises the newer tool; later sessions look like 0.0.13.
 * Reproducing a login / SSE reconnect that swaps the relayer under the bridge. */
const NEW_RELAYER_TOOLS = [...OLD_RELAYER_TOOLS, MISSING_TOOL];

function startSkewRelayer() {
    const sessions = [];
    const callsSeen = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/version") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    apiVersion: "1.0.0",
                    relayerVersion: "0.0.14",
                    minSupportedSdk: { mcp: "0.0.1" },
                }),
            );
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/mcp/sse") {
            if (!hasBridgeAuth(req)) {
                res.writeHead(401);
                res.end();
                return;
            }
            const first = sessions.length === 0;
            const sessionId = `session-${sessions.length + 1}`;
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            res.write(`event: endpoint\ndata: /api/mcp/messages?sessionId=${sessionId}\n\n`);
            sessions.push({ id: sessionId, res, first });
            const hb = setInterval(() => {
                if (res.writableEnded) {
                    clearInterval(hb);
                    return;
                }
                res.write(":\n\n");
            }, 200);
            hb.unref?.();
            res.on("close", () => clearInterval(hb));
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/mcp/messages") {
            if (!hasBridgeAuth(req)) {
                res.writeHead(401);
                res.end();
                return;
            }
            const session = sessions.find((s) => s.id === url.searchParams.get("sessionId"));
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                if (!session) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                res.writeHead(202);
                res.end();
                let msg;
                try {
                    msg = JSON.parse(body);
                } catch {
                    return;
                }
                const tools = session.first ? NEW_RELAYER_TOOLS : OLD_RELAYER_TOOLS;
                const reply = (result) => {
                    if (session.res.writableEnded) return;
                    session.res.write(
                        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`,
                    );
                };
                if (msg.method === "initialize") {
                    reply({
                        protocolVersion: "2024-11-05",
                        capabilities: { tools: { listChanged: true } },
                        serverInfo: { name: "memwal-upstream", version: session.first ? "0.0.14" : "0.0.13" },
                    });
                    return;
                }
                if (msg.method === "tools/list") {
                    reply({
                        tools: tools.map((name) => ({
                            name,
                            description: `upstream ${name}`,
                            inputSchema: { type: "object" },
                        })),
                    });
                    return;
                }
                if (msg.method === "tools/call") {
                    callsSeen.push({ session: session.id, name: msg.params?.name });
                    if (msg.params?.name === "memwal_health") {
                        reply({
                            content: [{ type: "text", text: "status=ok version=skew" }],
                            isError: false,
                        });
                        return;
                    }
                    if (msg.params?.name === MISSING_TOOL && session.first) {
                        reply({
                            content: [{ type: "text", text: "status=done blob_id=from-first-session" }],
                            isError: false,
                        });
                    }
                    // Later sessions: silence on the missing tool, same as 0.0.13.
                }
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise((res) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            res({
                server,
                base: `http://127.0.0.1:${port}`,
                callsSeen,
                sessions,
                closeFirst() {
                    const first = sessions[0];
                    if (first && !first.res.writableEnded) first.res.end();
                },
            });
        });
    });
}

test("reconnect forgets the previous relayer's tool set instead of stale-allowing", async (t) => {
    const mock = await startSkewRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-toolskew-reconnect-"));
    const credsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    const child = spawn(process.execPath, [BIN, "--relayer", mock.base, "--web-url", mock.base], {
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
            received.push({ msg, at: Date.now() });
            for (const l of [...listeners]) l(msg);
        }
    });
    let stderrBuf = "";
    child.stderr.on("data", (d) => (stderrBuf += d.toString()));

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    const waitFor = (pred, ms = 15000) => {
        const hit = received.find((r) => pred(r.msg));
        if (hit) return Promise.resolve(hit.msg);
        return new Promise((res, rej) => {
            const timer = setTimeout(() => {
                listeners.delete(l);
                rej(
                    new Error(
                        `timed out waiting for message\n--- stderr ---\n${stderrBuf}\n--- received ---\n${received.map((r) => JSON.stringify(r.msg)).join("\n")}`,
                    ),
                );
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

    t.after(() => {
        child.kill("SIGKILL");
        mock.server.close();
        rmSync(home, { recursive: true, force: true });
    });

    send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "toolskew-reconnect", version: "1.0.0" },
        },
    });
    await waitFor((m) => m.id === 1 && m.result, 10_000);

    await waitFor((m) => m.method === "notifications/tools/list_changed", 10_000);
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const firstList = await waitFor((m) => m.id === 2 && m.result, 10_000);
    assert.ok(
        firstList.result.tools.some((tool) => tool.name === MISSING_TOOL),
        "first session must advertise the newer tool so the stale-allow path is live",
    );

    send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: MISSING_TOOL, arguments: { job_id: "job-1" } },
    });
    const firstCall = await waitFor((m) => m.id === 3 && m.result, 10_000);
    assert.notEqual(firstCall.result?.isError, true);
    assert.match(JSON.stringify(firstCall.result), /from-first-session/);

    const changedBefore = received.filter(
        (r) => r.msg.method === "notifications/tools/list_changed",
    ).length;
    mock.closeFirst();
    await waitFor(
        () =>
            mock.sessions.length >= 2 &&
            received.filter((r) => r.msg.method === "notifications/tools/list_changed").length >
                changedBefore,
        10_000,
    );

    // Do NOT re-list. The previous allow-set still named the tool; forwarding
    // it into session-2 (0.0.13, silent on this name) is the #928 hang.
    const startedAt = Date.now();
    send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: MISSING_TOOL, arguments: { job_id: "job-2" } },
    });
    const refusal = await waitFor((m) => m.id === 4, 10_000);
    const elapsed = Date.now() - startedAt;
    assert.equal(
        refusal.result?.isError,
        true,
        `expected a local refusal after reconnect, got ${JSON.stringify(refusal)}`,
    );
    assert.match(refusal.result.content[0].text, new RegExp(MISSING_TOOL));
    assert.match(refusal.result.content[0].text, /nothing was saved/i);
    assert.ok(
        elapsed < 5_000,
        `post-reconnect refusal took ${elapsed}ms — expected it answered locally`,
    );
    assert.ok(
        !mock.callsSeen.some((c) => c.session !== "session-1" && c.name === MISSING_TOOL),
        `bridge forwarded ${MISSING_TOOL} to the new session: ${JSON.stringify(mock.callsSeen)}`,
    );
});
