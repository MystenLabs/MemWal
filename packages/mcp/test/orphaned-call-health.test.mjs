/**
 * A sent call whose reply never arrives is answered with the relayer's health
 * (WALM-396).
 *
 * Before: "Walrus Memory did not answer this call … safe to retry", with no
 * way to tell a dead relayer from a wrong URL from one stuck call. Now the
 * bridge asks `/health` first and says which it is. The mock keeps the SSE
 * session healthy and swallows `memwal_recall`, so the per-call deadline is
 * what fires; each case decides how `/health` behaves.
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

/** `onHealth(req, res, mock)` answers `GET /health`; everything else is a
 * healthy relayer that never replies to `memwal_recall`. */
function startMockRelayer(onHealth) {
    const sessions = new Map();
    let sseGetCount = 0;
    let recallPosts = 0;
    let swallowed = null;
    const mock = {};
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
        if (req.method === "GET" && url.pathname === "/health") {
            onHealth(req, res, mock);
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/mcp/sse") {
            if (!hasBridgeAuth(req)) {
                res.writeHead(401).end();
                return;
            }
            sseGetCount += 1;
            const sessionId = `session-${sseGetCount}`;
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            res.write(`event: endpoint\ndata: /api/mcp/messages?sessionId=${sessionId}\n\n`);
            sessions.set(sessionId, { res });
            const hb = setInterval(() => {
                if (res.writableEnded) return clearInterval(hb);
                res.write(":keepalive\n\n");
            }, 200);
            hb.unref?.();
            res.on("close", () => clearInterval(hb));
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/mcp/messages") {
            if (!hasBridgeAuth(req)) {
                res.writeHead(401).end();
                return;
            }
            const session = sessions.get(url.searchParams.get("sessionId"));
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                if (!session) {
                    res.writeHead(404).end();
                    return;
                }
                res.writeHead(202).end();
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
                    recallPosts += 1;
                    swallowed = { session, id: msg.id };
                }
            });
            return;
        }
        res.writeHead(404).end();
    });
    Object.assign(mock, {
        server,
        getSseGetCount: () => sseGetCount,
        getRecallPosts: () => recallPosts,
        /** End every open SSE stream, as a relayer restart or a proxy would.
         * The bridge sees EOF and reconnects. */
        dropSse: () => {
            for (const [id, session] of sessions) {
                sessions.delete(id);
                session.res.end();
            }
        },
        releaseSwallowed: () => {
            if (!swallowed) return false;
            swallowed.session.res.write(
                `event: message\ndata: ${JSON.stringify({
                    jsonrpc: "2.0",
                    id: swallowed.id,
                    result: { content: [{ type: "text", text: "LATE_REPLY" }], isError: false },
                })}\n\n`,
            );
            return true;
        },
    });
    return new Promise((r) => {
        server.listen(0, "127.0.0.1", () => {
            mock.base = `http://127.0.0.1:${server.address().port}`;
            r(mock);
        });
    });
}

/** Spawn the bridge against `mock`, initialize it, and send one recall. */
async function recallAgainst(t, mock) {
    const home = mkdtempSync(join(tmpdir(), "memwal-orphan-health-"));
    const credsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(
        credsPath,
        JSON.stringify({
            delegatePrivateKey: EXPECTED_BEARER,
            delegatePublicKeyHex: "b".repeat(64),
            delegateAddress: "0x" + "1".repeat(64),
            walletAddress: "0x" + "2".repeat(64),
            accountId: EXPECTED_ACCOUNT_ID,
            packageId: "0x" + "4".repeat(64),
            relayerUrl: mock.base,
            label: "Orphan Health Test",
            createdAt: new Date(0).toISOString(),
            version: 1,
        }),
        { mode: 0o600 },
    );

    const child = spawn(process.execPath, [BIN, "--relayer", mock.base, "--web-url", mock.base], {
        env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            MEMWAL_MCP_SSE_IDLE_MS: "30000",
            MEMWAL_MCP_CALL_TIMEOUT_MS: "1500",
            MEMWAL_MCP_HEALTH_PROBE_MS: "2000",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => {
        child.kill("SIGKILL");
        mock.server.closeAllConnections();
        mock.server.close();
        rmSync(home, { recursive: true, force: true });
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
                rej(new Error(`timed out waiting for message\n--- stderr ---\n${stderrBuf}`));
            }, ms);
            const l = (m) => {
                if (!pred(m)) return;
                clearTimeout(timer);
                listeners.delete(l);
                res(m);
            };
            listeners.add(l);
        });
    };

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor((m) => m.id === 1 && m.result, 10_000);
    send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything" } },
    });
    const reply = await waitFor((m) => m.id === 2, 15_000);
    return { reply, received, stderr: () => stderrBuf };
}

const textOf = (reply) => reply.result?.content?.[0]?.text ?? "";

test("a lost recall reply on a healthy relayer says the relayer is up and a retry is safe", async (t) => {
    const mock = await startMockRelayer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "9.9.9" }));
    });
    const { reply, stderr } = await recallAgainst(t, mock);
    const text = textOf(reply);
    assert.equal(reply.result?.isError, true);
    assert.match(text, /did not answer this call/);
    assert.match(text, /^Relayer health: ok \(\d+ms, v9\.9\.9\)/m);
    assert.match(text, /safe to retry/i);
    assert.match(text, /^Cause: /m);
    assert.match(text, /^Next step: /m);
    // The operator's log carries the same verdict as the agent's message.
    assert.match(stderr(), /"health":"ok"/);
    assert.equal(mock.getSseGetCount(), 1, "the per-call deadline, not a reconnect, answered it");
});

test("a lost recall reply on an unhealthy relayer says so and asks to wait", async (t) => {
    const mock = await startMockRelayer((_req, res) => res.writeHead(503).end());
    const text = textOf((await recallAgainst(t, mock)).reply);
    assert.match(text, /^Relayer health: HTTP 503/m);
    assert.match(text, /wait/i);
});

test("a lost recall reply with the health check failing says the relayer is unreachable", async (t) => {
    const mock = await startMockRelayer((req) => req.socket.destroy());
    const text = textOf((await recallAgainst(t, mock)).reply);
    assert.match(text, /^Relayer health: unreachable/m);
    assert.match(text, /down or not reachable/);
});

test("a reply that lands while the health check runs is delivered, and nothing else", async (t) => {
    // The deadline fired, the probe is in flight, and then the real answer
    // arrives. It must win: answering with an error as well would be a
    // second response for the same id.
    const mock = await startMockRelayer((_req, res, self) => {
        self.releaseSwallowed();
        setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ status: "ok", version: "9.9.9" }));
        }, 500);
    });
    const { reply, received } = await recallAgainst(t, mock);
    assert.equal(textOf(reply), "LATE_REPLY");
    assert.notEqual(reply.result?.isError, true);
    // Give the probe time to settle and prove it writes nothing.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(received.filter((m) => m.id === 2).length, 1);
});

test("a reconnect while the health check runs does not send the expired call again", async (t) => {
    // The deadline fired, the probe is in flight, and then the stream dies.
    // The reconnect replays what is still in flight — but not this call: the
    // sweeper is already answering it as failed, and a second POST would run
    // it twice, which for a write with no idempotency key stores it twice.
    const mock = await startMockRelayer((_req, res, self) => {
        self.dropSse();
        setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ status: "ok", version: "9.9.9" }));
        }, 1200);
    });
    const { reply, received } = await recallAgainst(t, mock);
    assert.equal(reply.result?.isError, true);
    assert.match(textOf(reply), /did not answer this call/);
    assert.ok(mock.getSseGetCount() >= 2, "the stream really was reopened");
    assert.equal(mock.getRecallPosts(), 1, "the expired call was not posted a second time");
    assert.equal(received.filter((m) => m.id === 2).length, 1);
});
