/**
 * Regression test for `memwal_logout` session invalidation (bridge.ts).
 *
 * Bug being guarded against (GH #616): `memwal_logout` only deleted the local
 * credentials *file*. The running bridge kept the in-memory `creds` object and
 * the open SSE session, so every later `memwal_recall` / `memwal_remember` was
 * still forwarded to the relayer and executed with the user's delegate key.
 * `memwal_logout` is the only revocation path in bridge mode, so a user (or a
 * prompt-injected agent) calling it believed access was cut off while writes
 * kept landing under the real key.
 *
 * Repro:
 *   - Mock relayer is healthy throughout and counts how many memory-tool calls
 *     actually reach it.
 *   - Bridge does `memwal_recall` (reaches the relayer), then `memwal_logout`,
 *     then `memwal_recall` again.
 *   - Before the fix the second recall was served normally and the relayer's
 *     counter reached 2. After the fix it is rejected locally and the counter
 *     stays at 1.
 *
 * The relayer-side counter is the assertion that matters: an `isError` reply
 * alone would not prove the request never ran under the delegate key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../dist/bin/memwal-mcp.js");
const EXPECTED_BEARER = "a".repeat(64);
const EXPECTED_ACCOUNT_ID = "0x" + "5".repeat(64);

const WALLET = "0x" + "7".repeat(64);
const PACKAGE = "0x" + "8".repeat(64);
const ACCOUNT_B = "0x" + "9".repeat(64);

/** Accept any well-formed delegate bearer rather than pinning one: signing back
 * in mints a fresh key, and these tests assert on whether requests arrive at
 * all, not which key signed them. Handshakes are recorded so a test that does
 * care can check. */
function hasBridgeAuth(req) {
    return (
        /^Bearer [0-9a-f]{64}$/.test(req.headers.authorization ?? "") &&
        typeof req.headers["x-memwal-account-id"] === "string"
    );
}

/** Drive `memwal_login`'s browser callback to completion, exactly as the real
 * web flow does. Mirrors the helper in live-login-credentials.test.mjs. */
async function completeLogin(connectUrl, accountId) {
    const url = new URL(connectUrl);
    const callbackBase = `http://127.0.0.1:${url.searchParams.get("port")}`;
    const state = url.searchParams.get("connectState");
    const publicKey = url.searchParams.get("publicKey");
    const relayer = url.searchParams.get("relayer");
    const headers = { origin: url.origin, "content-type": "application/json" };

    const preflight = await fetch(`${callbackBase}/preflight`, {
        method: "POST",
        headers,
        body: JSON.stringify({ state, publicKey, relayer }),
    });
    assert.equal(preflight.status, 200);

    const callback = await fetch(`${callbackBase}/callback`, {
        method: "POST",
        headers,
        body: JSON.stringify({ state, accountId, walletAddress: WALLET, packageId: PACKAGE }),
    });
    assert.equal(callback.status, 200);
}

async function waitUntil(predicate, timeoutMs = 10_000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** Healthy mock relayer. Unlike the watchdog test's mock, every session here
 * behaves normally — the only thing under test is whether the bridge stops
 * talking to it after logout. Counts memory-tool calls that reach the relayer
 * and tracks SSE stream closes so the test can prove the session was torn
 * down rather than merely ignored. */
function startMockRelayer({ delayFirstHandshakeMs = 0 } = {}) {
    const sessions = new Map(); // sessionId -> res
    const handshakes = [];
    let sseGetCount = 0;
    let closedSessions = 0;
    let recallCount = 0;
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
            handshakes.push({
                bearer: req.headers.authorization,
                accountId: req.headers["x-memwal-account-id"],
            });
            const sessionId = `session-${sseGetCount}`;
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            // Optionally stall the endpoint event on the FIRST handshake only,
            // so a test can act while the bridge's initial connect is still in
            // flight (openSseStream resolves on this event).
            const openDelay = sseGetCount === 1 ? delayFirstHandshakeMs : 0;
            const emitEndpoint = () => {
                if (res.writableEnded) return;
                res.write(`event: endpoint\ndata: /api/mcp/messages?sessionId=${sessionId}\n\n`);
                sessions.set(sessionId, res);
            };
            if (openDelay > 0) {
                setTimeout(emitEndpoint, openDelay).unref?.();
            } else {
                emitEndpoint();
            }
            const hb = setInterval(() => {
                if (res.writableEnded) {
                    clearInterval(hb);
                    return;
                }
                res.write(":\n\n");
            }, 200);
            hb.unref?.();
            res.on("close", () => {
                clearInterval(hb);
                closedSessions += 1;
                sessions.delete(sessionId);
            });
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
                const reply = (result) =>
                    session.write(
                        `event: message\ndata: ${JSON.stringify({
                            jsonrpc: "2.0",
                            id: msg.id,
                            result,
                        })}\n\n`,
                    );
                if (msg.method === "initialize") {
                    reply({
                        protocolVersion: "2024-11-05",
                        capabilities: { tools: { listChanged: true } },
                        serverInfo: { name: "memwal", version: "0.0.1" },
                    });
                    return;
                }
                if (msg.method === "tools/list") {
                    reply({
                        tools: [
                            {
                                name: "memwal_recall",
                                description: "Recall memories.",
                                inputSchema: { type: "object", properties: {} },
                            },
                        ],
                    });
                    return;
                }
                if (msg.method === "tools/call" && msg.params?.name === "memwal_recall") {
                    recallCount += 1;
                    reply({
                        content: [{ type: "text", text: `RECALL_OK: served ${recallCount}` }],
                        isError: false,
                    });
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
                getRecallCount: () => recallCount,
                getSseGetCount: () => sseGetCount,
                getClosedSessions: () => closedSessions,
                getHandshakes: () => handshakes,
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
        label: "Logout Test",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

/** Spawn the bridge against `mock` with a sandboxed HOME and return a small
 * stdio driver. Mirrors the harness in sse-idle-watchdog.test.mjs. */
function startBridge(t, mock, home) {
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

    t.after(() => child.kill("SIGKILL"));
    return { send, waitFor };
}

test("memwal_logout stops the live bridge from serving memory tools with the deleted delegate key", async (t) => {
    const mock = await startMockRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-logout-test-"));
    const credsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    t.after(() => {
        mock.server.close();
        rmSync(home, { recursive: true, force: true });
    });

    const { send, waitFor } = startBridge(t, mock, home);

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await waitFor((m) => m.id === 1 && m.result, 10_000);
    assert.equal(init.result.serverInfo.name, "memwal");

    // Baseline: while logged in, a recall reaches the relayer and succeeds.
    send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "before logout" } },
    });
    const before = await waitFor((m) => m.id === 2, 10_000);
    assert.notEqual(before.result?.isError, true);
    assert.match(JSON.stringify(before.result), /RECALL_OK/);
    assert.equal(mock.getRecallCount(), 1, "baseline recall should reach the relayer");

    send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memwal_logout", arguments: {} },
    });
    const logout = await waitFor((m) => m.id === 3, 10_000);
    assert.notEqual(logout.result?.isError, true, "logout itself should succeed");
    assert.equal(existsSync(credsPath), false, "logout should remove the credentials file");

    // The bug: this second recall was still forwarded and served with the
    // delegate key the user just deleted.
    send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "after logout" } },
    });
    const after = await waitFor((m) => m.id === 4, 10_000);

    assert.equal(
        after.result?.isError,
        true,
        "a memory tool call after logout must be rejected, not served",
    );
    assert.equal(
        mock.getRecallCount(),
        1,
        "a memory tool call after logout must never reach the relayer",
    );
});

test("memwal_logout tears down the open SSE session instead of leaving it connected", async (t) => {
    const mock = await startMockRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-logout-sse-test-"));
    const credsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    t.after(() => {
        mock.server.close();
        rmSync(home, { recursive: true, force: true });
    });

    const { send, waitFor } = startBridge(t, mock, home);

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor((m) => m.id === 1 && m.result, 10_000);

    // Force the SSE stream open — initialize alone may be answered locally.
    send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "open the stream" } },
    });
    await waitFor((m) => m.id === 2, 10_000);
    assert.ok(mock.getSseGetCount() >= 1, "expected an SSE session to be open before logout");

    send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memwal_logout", arguments: {} },
    });
    await waitFor((m) => m.id === 3, 10_000);

    // Poll briefly: the abort propagates to the server as a stream close.
    const deadline = Date.now() + 5000;
    while (mock.getClosedSessions() < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(
        mock.getClosedSessions() >= 1,
        `expected the SSE session to be closed on logout, saw ${mock.getClosedSessions()} closes`,
    );
});

/**
 * Tearing the session down must not be a one-way door. `memwal_logout` stops
 * the server pump's stream; if the pump exits outright, a later `memwal_login`
 * reconnects a session with nothing draining it and the client hangs forever
 * on its next tool call — a worse failure than the bug being fixed. The pump
 * has to park and resume instead.
 */
test("signing back in after logout restores memory tools without a client restart", async (t) => {
    const mock = await startMockRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-logout-relogin-test-"));
    const credsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    t.after(() => {
        mock.server.close();
        rmSync(home, { recursive: true, force: true });
    });

    const { send, waitFor } = startBridge(t, mock, home);

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor((m) => m.id === 1 && m.result, 10_000);

    send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "before logout" } },
    });
    await waitFor((m) => m.id === 2, 10_000);
    assert.equal(mock.getRecallCount(), 1);

    send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memwal_logout", arguments: {} },
    });
    await waitFor((m) => m.id === 3, 10_000);

    send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "while signed out" } },
    });
    const refused = await waitFor((m) => m.id === 4, 10_000);
    assert.equal(refused.result?.isError, true, "still signed out at this point");

    send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "memwal_login", arguments: {} },
    });
    const login = await waitFor((m) => m.id === 5, 10_000);
    const connectUrl = login.result?.content?.[0]?.text?.match(/\*\*URL:\*\* (http[^\n]+)/)?.[1];
    assert.ok(connectUrl, "memwal_login should return the browser URL");

    await completeLogin(connectUrl, ACCOUNT_B);
    await waitUntil(() => mock.getHandshakes().some((h) => h.accountId === ACCOUNT_B));

    // The real assertion: a memory tool works again, end to end, on the new
    // session. Without a resumable pump this reply never reaches stdout and the
    // wait below times out.
    send({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "after signing back in" } },
    });
    const after = await waitFor((m) => m.id === 6, 10_000);
    assert.notEqual(after.result?.isError, true, "memory tools should work again after re-login");
    assert.match(JSON.stringify(after.result), /RECALL_OK/);
    assert.equal(mock.getRecallCount(), 2, "the post-login recall should reach the relayer");
});

/**
 * Logging out while the very first handshake is still in flight must not leave
 * an authenticated stream open. The connect loop only re-checks its guards at
 * the top of each iteration, so a session whose endpoint event lands *after*
 * logout would otherwise be published — an open, authorized SSE stream holding
 * the delegate key the user just deleted.
 */
test("logging out mid-handshake does not publish the in-flight session", async (t) => {
    const mock = await startMockRelayer({ delayFirstHandshakeMs: 1500 });
    const home = mkdtempSync(join(tmpdir(), "memwal-logout-midhandshake-test-"));
    const credsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    t.after(() => {
        mock.server.close();
        rmSync(home, { recursive: true, force: true });
    });

    const { send, waitFor } = startBridge(t, mock, home);

    // initialize is answered locally, so this returns while the relayer
    // handshake is still stalled on its endpoint event.
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor((m) => m.id === 1 && m.result, 10_000);
    await waitUntil(() => mock.getSseGetCount() >= 1, 5_000);
    assert.equal(mock.getClosedSessions(), 0, "handshake should still be in flight");

    send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_logout", arguments: {} },
    });
    await waitFor((m) => m.id === 2, 10_000);

    // Let the stalled endpoint event fire and the bridge react to it.
    await new Promise((r) => setTimeout(r, 2500));

    assert.equal(
        mock.getClosedSessions(),
        1,
        "the session that completed after logout must be aborted, not published",
    );
});
