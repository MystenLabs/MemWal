/**
 * Regression test for WALM-618 — a tool call that expires while still buffered
 * must be explained as what it is: a call that never left this process.
 *
 * Repro (the shape Dio hit: 15 session opens, 6 calls that ever reached the
 * relayer, minutes of silence in between):
 *   - Mock relayer answers GET /version, then 503s every SSE handshake, the
 *     way the real relayer does when the on-chain delegate verify cannot
 *     reach a throttled fullnode.
 *   - A `tools/call` arrives before any session exists, so it lands in
 *     `pendingForward` and waits there while the bridge retries.
 *
 * The orphan sweeper did already bound this wait. What it got wrong was the
 * answer: every expiry was reported as "the connection to the relayer dropped
 * before the result came back", which points the user at the relayer — or at a
 * possibly half-written memory — when in fact nothing was ever sent and the
 * handshake was the thing failing.
 *
 * Asserts:
 *   - `initialize` is still answered locally, exactly once.
 *   - the buffered call is NOT eager-failed between retries (the property
 *     `coldstart-timeout.test.mjs` locks down — this stays a deadline, not a
 *     per-attempt failure).
 *   - once the deadline passes it is answered as a tool error naming the
 *     failing connection, saying nothing was stored, and carrying the last
 *     handshake error.
 *   - the process stays alive throughout.
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

/** The deadline under test: the short one that applies only to a call which
 * never left the bridge while no connection has existed. Short enough to run,
 * long enough that several connect-retry cycles fit inside it — otherwise
 * "not eager-failed between retries" would pass for the wrong reason. */
const STALLED_HANDSHAKE_MS = 3_000;

/** Deliberately far larger, so an answer arriving near STALLED_HANDSHAKE_MS
 * proves the stalled-handshake deadline fired and not the ordinary call
 * timeout, which is what used to leave the user waiting ~4 minutes. */
const CALL_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 400;

function hasBridgeAuth(req) {
    return (
        req.headers.authorization === `Bearer ${EXPECTED_BEARER}` &&
        req.headers["x-memwal-account-id"] === EXPECTED_ACCOUNT_ID
    );
}

/** Mock relayer that 503s every SSE handshake until `heal()` is called — an
 * infrastructure failure, not an auth rejection, which is exactly what a
 * throttled fullnode produces via the relayer's `upstream_unavailable()`.
 * Once healed it behaves like a normal session, and records every JSON-RPC
 * envelope it is posted so a test can prove what did (and did not) reach it. */
function startUnavailableRelayer() {
    let sseGetCount = 0;
    let healthy = false;
    const sessions = new Map();
    const posted = [];
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
            if (!healthy) {
                res.writeHead(503, { "content-type": "text/plain" });
                res.end("Account resolution unavailable: on-chain re-verify unavailable");
                return;
            }
            const sessionId = `session-${sseGetCount}`;
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
            const session = sessions.get(url.searchParams.get("sessionId"));
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                if (!session) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                try {
                    posted.push(JSON.parse(body));
                } catch {
                    /* not JSON — not something this test asserts on */
                }
                res.writeHead(202);
                res.end();
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
                getPosted: () => posted,
                heal: () => {
                    healthy = true;
                },
                closeStreams: () =>
                    sessions.forEach((s) => {
                        if (!s.res.writableEnded) s.res.end();
                    }),
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
        label: "Pending Forward Stalled Test",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

test("a call buffered behind a failing handshake is answered, and says why", async (t) => {
    const mock = await startUnavailableRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-pending-stalled-test-"));
    const credsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    const child = spawn(process.execPath, [BIN, "--relayer", mock.base, "--web-url", mock.base], {
        env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            MEMWAL_MCP_CONNECT_TIMEOUT_MS: String(CONNECT_TIMEOUT_MS),
            MEMWAL_MCP_CALL_TIMEOUT_MS: String(CALL_TIMEOUT_MS),
            MEMWAL_MCP_STALLED_HANDSHAKE_MS: String(STALLED_HANDSHAKE_MS),
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
    const waitFor = (pred, ms = 15_000) => {
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
        mock.closeStreams();
        mock.server.close();
        rmSync(home, { recursive: true, force: true });
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await waitFor((m) => m.id === 1 && m.result, 5_000);
    assert.equal(init.result.serverInfo.name, "memwal");

    const sentAt = Date.now();
    send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_remember", arguments: { text: "anything" } },
    });

    // Half the deadline in, several connect attempts have already failed and
    // the call must still be waiting — the fix adds a deadline, it does not
    // eager-fail a call the next attempt might serve.
    await new Promise((r) => setTimeout(r, STALLED_HANDSHAKE_MS / 2));
    assert.ok(
        mock.getSseGetCount() >= 2,
        `expected the handshake to have been retried by now, saw ${mock.getSseGetCount()} attempts`,
    );
    assert.ok(
        !received.some((m) => m.id === 2),
        `id=2 must still be buffered mid-deadline, got: ${JSON.stringify(received.find((m) => m.id === 2))}`,
    );

    // Past the deadline it is answered rather than left hanging forever.
    const reply = await waitFor((m) => m.id === 2, 15_000);
    const waitedMs = Date.now() - sentAt;
    assert.ok(
        waitedMs >= STALLED_HANDSHAKE_MS,
        `must not be answered before its deadline; waited only ${waitedMs}ms`,
    );
    assert.ok(
        waitedMs < CALL_TIMEOUT_MS,
        `must be answered on the stalled-handshake deadline, not the ordinary ${CALL_TIMEOUT_MS}ms ` +
            `call timeout — that long wait with no feedback is the reported bug; waited ${waitedMs}ms`,
    );

    assert.equal(
        reply.result?.isError,
        true,
        `expected a tool-error envelope, got ${JSON.stringify(reply)}`,
    );
    const text = JSON.stringify(reply.result);
    assert.match(
        text,
        /could not reach the relayer/i,
        `the answer must name the failing connection, got ${text}`,
    );
    assert.match(
        text,
        /nothing was\\?\s*stored/i,
        `the answer must say the call never ran, got ${text}`,
    );
    assert.match(
        text,
        /503/,
        `the answer must carry the handshake error the call was stuck behind, got ${text}`,
    );

    assert.equal(child.exitCode, null, "bridge should still be running, not exited");

    // initialize answered exactly once — the sweep must never write a second
    // envelope for an id that was answered locally.
    const initReplies = received.filter((m) => m.id === 1 && (m.result || m.error));
    assert.equal(
        initReplies.length,
        1,
        `initialize (id=1) must be answered exactly once; saw ${initReplies.length}`,
    );

    // The hazard the expiry has to close: the answered call is still a plain
    // object sitting in `pendingForward`, and the flush that follows the next
    // successful connect forwards whatever it finds there. Left in, a
    // `remember` we just reported as never having run would run for real —
    // after the agent was told nothing was stored, so it may well have retried
    // by then. Let the relayer recover and prove the call is gone.
    mock.heal();
    const connectedAt = Date.now();
    while (!stderrBuf.includes("Connected. Bridging") && Date.now() - connectedAt < 15_000) {
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(
        stderrBuf.includes("Connected. Bridging"),
        `the relayer must recover for this assertion to mean anything; stderr:\n${stderrBuf}`,
    );

    // A fresh call proves the session really is carrying traffic, so "id=2
    // never posted" below is evidence rather than an artefact of a dead link.
    send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memwal_remember", arguments: { text: "after recovery" } },
    });
    const postedAt = Date.now();
    while (
        !mock.getPosted().some((m) => m.id === 3) &&
        Date.now() - postedAt < 10_000
    ) {
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(
        mock.getPosted().some((m) => m.id === 3),
        `a call sent after recovery must reach the relayer; posted: ${JSON.stringify(mock.getPosted())}`,
    );

    assert.ok(
        !mock.getPosted().some((m) => m.id === 2),
        `the expired call must never reach the relayer after being answered, but saw: ${JSON.stringify(
            mock.getPosted().filter((m) => m.id === 2),
        )}`,
    );
    const callReplies = received.filter((m) => m.id === 2);
    assert.equal(
        callReplies.length,
        1,
        `id=2 must be answered exactly once; saw ${callReplies.length}: ${JSON.stringify(callReplies)}`,
    );

    // `initialize` is buffered, not answered upstream — the expiry must leave
    // it in place so the recovered session still negotiates capabilities.
    assert.ok(
        mock.getPosted().some((m) => m.method === "initialize"),
        `initialize must still be forwarded once the session comes up; posted: ${JSON.stringify(
            mock.getPosted().map((m) => m.method ?? m.id),
        )}`,
    );
});
