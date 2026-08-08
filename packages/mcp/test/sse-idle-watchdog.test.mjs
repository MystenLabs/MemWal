/**
 * Regression test for the SSE heartbeat watchdog (bridge.ts).
 *
 * Bug being guarded against: when the relayer-side session silently goes dead
 * (TCP socket alive, but no events ever arrive on the SSE stream), the bridge
 * waits forever for a response that will never come. Reported as: `memwal_recall`
 * hangs indefinitely after a long-running Claude Code session, with the MCP
 * wrapper still reporting "Connected".
 *
 * Repro:
 *   - Mock relayer accepts the first GET /api/mcp/sse, sends the endpoint
 *     event, then GOES SILENT — no heartbeats, no responses to POSTs.
 *   - Bridge sends `memwal_recall`. Without the watchdog it would block forever.
 *   - With the watchdog: after MEMWAL_MCP_SSE_IDLE_MS, the bridge aborts the
 *     dead session, opens a fresh one (the mock answers normally on the second
 *     GET /api/mcp/sse), and replays the in-flight recall. The client sees a
 *     real response.
 *
 * We use MEMWAL_MCP_SSE_IDLE_MS=2000 to keep the test fast.
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

/** Mock relayer. The first SSE session is born dead — it emits the endpoint
 * event so the bridge thinks it's up, then never sends another byte. The
 * second SSE session behaves normally. POSTs land in /api/mcp/messages and
 * are routed to whichever session their sessionId points at. */
function startMockRelayer() {
    const sessions = new Map(); // sessionId -> { res, alive }
    let sseGetCount = 0;
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
            const alive = sseGetCount !== 1; // first session is born dead
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            res.write(
                `event: endpoint\ndata: /api/mcp/messages?sessionId=${sessionId}\n\n`,
            );
            sessions.set(sessionId, { res, alive });
            if (alive) {
                // Send a heartbeat every 200ms while the session is open so a
                // healthy session never trips the watchdog. The dead session
                // stays silent on purpose — that's the whole point of the test.
                const hb = setInterval(() => {
                    if (res.writableEnded) {
                        clearInterval(hb);
                        return;
                    }
                    res.write(":\n\n");
                }, 200);
                hb.unref?.();
                res.on("close", () => clearInterval(hb));
            }
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
                if (!session.alive) return; // dead session drops POSTs silently
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
                if (msg.method === "tools/call" && msg.params?.name === "memwal_recall") {
                    session.res.write(
                        `event: message\ndata: ${JSON.stringify({
                            jsonrpc: "2.0",
                            id: msg.id,
                            result: {
                                content: [{ type: "text", text: "RECALL_OK: recovered after reconnect" }],
                                isError: false,
                            },
                        })}\n\n`,
                    );
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
        label: "Watchdog Test",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

test("SSE idle watchdog reconnects after a dead session and replays in-flight requests", async (t) => {
    const mock = await startMockRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-watchdog-test-"));
    const credsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    const child = spawn(process.execPath, [BIN, "--relayer", mock.base, "--web-url", mock.base], {
        env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            MEMWAL_MCP_SSE_IDLE_MS: "1500",
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
    // Drain stderr so the child never blocks on a full pipe; surface it on test
    // failure for easier debugging.
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

    // Send initialize while the first (dead) session is the only one open.
    // Without the watchdog this hangs forever. With it: ~1.5s of silence
    // triggers a reconnect; the second session answers initialize properly.
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await waitFor((m) => m.id === 1 && m.result, 10_000);
    assert.equal(init.result.serverInfo.name, "memwal");

    // recall (forwarded straight to the relayer on the recovered session) —
    // confirms POSTs route to the new session correctly.
    send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything" } },
    });
    const recall = await waitFor((m) => m.id === 2, 5_000);
    assert.notEqual(recall.result?.isError, true);
    assert.match(JSON.stringify(recall.result), /RECALL_OK/);

    // Verify the bridge actually reconnected (i.e. we observed 2 GET /sse
    // calls, not 1). If this assertion fails the test "passed" for the wrong
    // reason — e.g. some other code path served the response.
    assert.ok(
        mock.getSseGetCount() >= 2,
        `expected at least 2 SSE handshakes, saw ${mock.getSseGetCount()}`,
    );
});
