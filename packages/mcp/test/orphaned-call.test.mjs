/**
 * Regression test for the per-call deadline (bridge.ts).
 *
 * Bug being guarded against (WALM-328): the idle watchdog only notices a silent
 * SSE *stream*. The relayer sends a keepalive every 3s, so a stream whose
 * heartbeats keep flowing looks perfectly healthy even when one response frame
 * has gone missing. That request then sits in `inFlight` forever — no watchdog,
 * therefore no reconnect, therefore no replay — and the caller can only report a
 * bare "timeout" with nothing to act on.
 *
 * Repro:
 *   - Mock relayer keeps the SSE session alive and heartbeating throughout.
 *   - It answers `initialize` normally, so the bridge is fully connected.
 *   - It accepts the `memwal_remember` POST with 202 and then never emits the
 *     matching response frame.
 *   - With MEMWAL_MCP_CALL_TIMEOUT_MS=2000 the sweeper closes the call out with
 *     an explicit, retryable error instead of leaving it hanging.
 *
 * The "only one SSE handshake" assertion is what proves this is the new code
 * path: if the watchdog had fired we would see a reconnect, and the test would
 * be passing for the wrong reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../dist/bin/memwal-mcp.js");
const EXPECTED_BEARER = "a".repeat(64);
const EXPECTED_ACCOUNT_ID = "0x" + "3".repeat(64);

function hasBridgeAuth(req) {
    return (
        req.headers.authorization === `Bearer ${EXPECTED_BEARER}` &&
        req.headers["x-memwal-account-id"] === EXPECTED_ACCOUNT_ID
    );
}

/** Mock relayer whose SSE session stays healthy for the whole test. It answers
 * `initialize`, but swallows `memwal_remember` — the POST is accepted and no
 * response frame is ever written. `releaseSwallowed()` lets the test emit that
 * withheld reply afterwards, to prove a late arrival is not written a second
 * time for an id already closed out. */
function startMockRelayer() {
    const sessions = new Map();
    let sseGetCount = 0;
    let swallowed = null;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/version") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    apiVersion: "1.0.0",
                    relayerVersion: "1.0.0",
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
            sseGetCount += 1;
            const sessionId = `session-${sseGetCount}`;
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            res.write(
                `event: endpoint\ndata: /api/mcp/messages?sessionId=${sessionId}\n\n`,
            );
            sessions.set(sessionId, { res });
            // Heartbeat far faster than the idle timeout so the stream is never
            // idle. This is the condition the watchdog cannot help with.
            const hb = setInterval(() => {
                if (res.writableEnded) {
                    clearInterval(hb);
                    return;
                }
                res.write(":keepalive\n\n");
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
            const sessionId = url.searchParams.get("sessionId");
            const session = sessions.get(sessionId);
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
                if (msg.method === "initialize") {
                    session.res.write(
                        `event: message\ndata: ${JSON.stringify({
                            jsonrpc: "2.0",
                            id: msg.id,
                            result: {
                                protocolVersion: "2024-11-05",
                                capabilities: { tools: { listChanged: true } },
                                serverInfo: { name: "memwal", version: "0.0.1" },
                            },
                        })}\n\n`,
                    );
                    return;
                }
                if (msg.method === "tools/call" && msg.params?.name === "memwal_remember") {
                    // Accepted, executed server-side as far as the client knows,
                    // and the reply never comes back.
                    swallowed = { session, id: msg.id };
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
            res({
                server,
                base: `http://127.0.0.1:${port}`,
                getSseGetCount: () => sseGetCount,
                releaseSwallowed: () => {
                    if (!swallowed) return false;
                    swallowed.session.res.write(
                        `event: message\ndata: ${JSON.stringify({
                            jsonrpc: "2.0",
                            id: swallowed.id,
                            result: {
                                content: [{ type: "text", text: "LATE_REPLY" }],
                                isError: false,
                            },
                        })}\n\n`,
                    );
                    return true;
                },
            });
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
        label: "Orphan Test",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

test("a call whose reply never arrives is closed out with a retryable error", async (t) => {
    const mock = await startMockRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-orphan-test-"));
    const credsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    const child = spawn(process.execPath, [BIN, "--relayer", mock.base, "--web-url", mock.base], {
        env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            // Well above the call deadline: the stream must never be judged idle,
            // so the watchdog cannot be what rescues this call.
            MEMWAL_MCP_SSE_IDLE_MS: "30000",
            MEMWAL_MCP_CALL_TIMEOUT_MS: "2000",
        },
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
    const waitFor = (pred, ms = 15000) => {
        const hit = received.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
            const timer = setTimeout(() => {
                listeners.delete(l);
                rej(
                    new Error(
                        `timed out waiting for message\n--- stderr ---\n${stderrBuf}\n--- received ---\n${received.map((m) => JSON.stringify(m)).join("\n")}`,
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

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await waitFor((m) => m.id === 1 && m.result, 10_000);
    assert.equal(init.result.serverInfo.name, "memwal");

    // The relayer accepts this and never answers it.
    send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_remember", arguments: { text: "orphan me" } },
    });

    // Before the fix this never resolved.
    const orphaned = await waitFor((m) => m.id === 2, 10_000);
    assert.equal(orphaned.result?.isError, true, "expected a tool-result error envelope");
    assert.match(
        JSON.stringify(orphaned.result),
        /retry/i,
        "the message should tell the caller it is safe to retry",
    );
    assert.doesNotMatch(
        JSON.stringify(orphaned.result),
        /relayer unavailable/i,
        "the relayer was healthy — saying otherwise sends debugging the wrong way",
    );

    // The stream stayed healthy throughout, so no reconnect should have happened.
    // If this fails, the watchdog rescued the call and the deadline was never
    // exercised.
    assert.equal(
        mock.getSseGetCount(),
        1,
        `expected exactly 1 SSE handshake, saw ${mock.getSseGetCount()}`,
    );

    // A late genuine reply for an id already closed out must be dropped, or the
    // client would see two responses for the same id.
    assert.ok(mock.releaseSwallowed(), "mock should have had a withheld reply");
    await new Promise((r) => setTimeout(r, 1000));
    const repliesForId2 = received.filter((m) => m.id === 2);
    assert.equal(
        repliesForId2.length,
        1,
        `expected exactly one reply for id 2, got ${repliesForId2.length}`,
    );
    assert.doesNotMatch(JSON.stringify(repliesForId2), /LATE_REPLY/);
});
