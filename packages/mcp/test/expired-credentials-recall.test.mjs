/**
 * WALM-602 / GH #365 — an expired session must be distinguishable from an
 * empty namespace.
 *
 * The original report was "recall silently returns empty instead of an auth
 * error". The server half of that closed in 0.0.11 (`45b0ad87` made the MCP
 * proxy require a registered delegate, so an unregistered key no longer opens
 * a session that then honestly reports zero rows). What remains is the client
 * half: a relayer that rejects the credentials 401s the SSE handshake, and the
 * bridge's background connect treats that like any other connect failure —
 * exponential-backoff retry — so the queued tool call waits out the orphan
 * sweeper instead of being told the credentials were rejected.
 *
 * These tests pin the distinction the ticket asks for, and the way back out of
 * it:
 *   - rejected credentials       -> an auth error naming the way back in
 *   - valid creds, no hits       -> an ordinary empty result, NOT an error
 *   - still rejected             -> refused again, fast, with the bridge alive
 *   - `memwal_login` afterwards  -> service restored, promptly
 *   - revoked mid-session        -> the in-flight call answered, not orphaned
 *   - transient 401 mid-session  -> recovers with no client intervention
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
const BEARER = "a".repeat(64);
const ACCOUNT = "0x" + "3".repeat(64);

/** Bound the whole exchange. Long enough for a couple of reconnect backoffs,
 * short enough that a hang fails the test instead of stalling the suite. */
const CALL_TIMEOUT_MS = 4000;

function serveVersion(res) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
        JSON.stringify({
            apiVersion: "1.0.0",
            relayerVersion: "1.0.0",
            minSupportedSdk: { mcp: "0.0.1" },
        }),
    );
}

/**
 * Relayer that rejects the delegate key on the SSE handshake — what the proxy
 * now does for a revoked or never-registered delegate.
 */
function startRejectingRelayer() {
    let sseAttempts = 0;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/version") {
            serveVersion(res);
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/mcp/sse") {
            sseAttempts += 1;
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "delegate key is not registered" }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise((ready) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            ready({
                server,
                base: `http://127.0.0.1:${port}`,
                sseAttempts: () => sseAttempts,
            });
        });
    });
}

/**
 * Healthy relayer whose namespace simply holds nothing — the contrast case.
 * Mirrors the sidecar's own wording for a genuinely empty namespace.
 */
function startEmptyNamespaceRelayer() {
    let sseRes = null;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/version") {
            serveVersion(res);
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/mcp/sse") {
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            res.write("event: endpoint\ndata: /api/mcp/messages?sessionId=test\n\n");
            sseRes = res;
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/mcp/messages") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                res.writeHead(202);
                res.end();
                let msg;
                try {
                    msg = JSON.parse(body);
                } catch {
                    return;
                }
                if (msg.method === "tools/call") {
                    sseRes?.write(
                        `event: message\ndata: ${JSON.stringify({
                            jsonrpc: "2.0",
                            id: msg.id,
                            result: {
                                content: [{ type: "text", text: "No matching memories found." }],
                                isError: false,
                            },
                        })}\n\n`,
                    );
                }
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise((ready) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            ready({ server, base: `http://127.0.0.1:${port}` });
        });
    });
}

/** Spawn the bridge against `base` with credentials on disk, wired for stdio. */
function startBridge(base) {
    const home = mkdtempSync(join(tmpdir(), "memwal-test-"));
    mkdirSync(join(home, ".memwal"));
    writeFileSync(
        join(home, ".memwal", "credentials.json"),
        JSON.stringify({
            delegatePrivateKey: BEARER,
            delegatePublicKeyHex: "b".repeat(64),
            delegateAddress: "0x" + "1".repeat(64),
            walletAddress: "0x" + "2".repeat(64),
            accountId: ACCOUNT,
            packageId: "0x" + "4".repeat(64),
            relayerUrl: base,
            label: "test",
            createdAt: new Date(0).toISOString(),
            version: 1,
        }),
    );

    const child = spawn(process.execPath, [BIN, "--relayer", base, "--web-url", base], {
        env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            MEMWAL_MCP_CALL_TIMEOUT_MS: String(CALL_TIMEOUT_MS),
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

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    const waitFor = (pred, ms) => {
        const hit = received.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
            const timer = setTimeout(() => {
                listeners.delete(l);
                rej(new Error("timed out waiting for message"));
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

    return {
        send,
        waitFor,
        cleanup: () => {
            child.kill("SIGKILL");
            rmSync(home, { recursive: true, force: true });
        },
    };
}

function textOf(msg) {
    const content = msg?.result?.content;
    if (!Array.isArray(content)) return "";
    return content.map((c) => c?.text ?? "").join("\n");
}

test("recall on rejected credentials reports an auth error, not empty results", async (t) => {
    const { server, base } = await startRejectingRelayer();
    const bridge = startBridge(base);
    t.after(() => {
        bridge.cleanup();
        server.close();
    });

    bridge.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
        },
    });
    await bridge.waitFor((m) => m.id === 1 && m.result, 15000);

    bridge.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything", limit: 5 } },
    });

    // Generous relative to CALL_TIMEOUT_MS so a slow machine doesn't flake, but
    // far below the 240s production default: the point is that the answer comes
    // from the 401, not from waiting out the orphan sweeper.
    const reply = await bridge.waitFor((m) => m.id === 2 && (m.result || m.error), 20000);
    const text = `${textOf(reply)} ${reply?.error?.message ?? ""}`.toLowerCase();

    assert.ok(
        reply.error || reply.result?.isError,
        `recall against rejected credentials must be an error, got: ${JSON.stringify(reply)}`,
    );
    assert.ok(
        !text.includes("no matching memories"),
        "rejected credentials must not read as an empty namespace",
    );
    assert.ok(
        /401|credential|unauthorized|signed out|memwal_login/.test(text),
        `error must name the auth failure and the way back in, got: ${text}`,
    );
});

test("recall on an empty namespace reports empty results, not an auth error", async (t) => {
    const { server, base } = await startEmptyNamespaceRelayer();
    const bridge = startBridge(base);
    t.after(() => {
        bridge.cleanup();
        server.close();
    });

    bridge.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
        },
    });
    await bridge.waitFor((m) => m.id === 1 && m.result, 15000);

    bridge.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything", limit: 5 } },
    });

    const reply = await bridge.waitFor((m) => m.id === 2 && (m.result || m.error), 20000);
    const text = textOf(reply);

    assert.equal(reply.error, undefined, `empty namespace must not error: ${JSON.stringify(reply)}`);
    assert.notEqual(reply.result?.isError, true, "empty namespace must not be an error result");
    assert.match(text, /no matching memories/i);
    assert.ok(
        !/401|unauthorized|signed out/i.test(text),
        `empty namespace must not read as an auth failure, got: ${text}`,
    );
});

/**
 * Relayer that 401s one specific delegate key and accepts every other one —
 * what a revoked key looks like once `memwal_login` has registered a fresh one.
 * Sessions that DO open answer `tools/call` with an ordinary empty result, so
 * "recovered" is distinguishable from "still refusing".
 *
 * `holdRejections` parks each 401 until `releaseRejections()`, so a test can
 * queue requests before the bridge learns the key is rejected.
 */
function startRevokedKeyRelayer(revokedBearer, { holdRejections = false } = {}) {
    let sseRes = null;
    let rejections = 0;
    let accepted = 0;
    let held = [];
    const reject = (res) => {
        rejections += 1;
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "delegate key is not registered" }));
    };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/version") {
            serveVersion(res);
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/mcp/sse") {
            const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
            if (bearer === revokedBearer) {
                if (holdRejections) held.push(res);
                else reject(res);
                return;
            }
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            accepted += 1;
            res.write("event: endpoint\ndata: /api/mcp/messages?sessionId=recovered\n\n");
            const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 250);
            heartbeat.unref?.();
            res.on("close", () => clearInterval(heartbeat));
            sseRes = res;
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/mcp/messages") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                res.writeHead(202);
                res.end();
                let msg;
                try {
                    msg = JSON.parse(body);
                } catch {
                    return;
                }
                if (msg.id == null) return;
                sseRes?.write(
                    `event: message\ndata: ${JSON.stringify({
                        jsonrpc: "2.0",
                        id: msg.id,
                        result:
                            msg.method === "tools/call"
                                ? {
                                      content: [
                                          { type: "text", text: "No matching memories found." },
                                      ],
                                      isError: false,
                                  }
                                : {},
                    })}\n\n`,
                );
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise((ready) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            ready({
                server,
                base: `http://127.0.0.1:${port}`,
                rejections: () => rejections,
                accepted: () => accepted,
                releaseRejections: () => {
                    holdRejections = false;
                    for (const res of held.splice(0)) reject(res);
                },
            });
        });
    });
}

/** Drive the browser half of `memwal_login` against the bridge's own localhost
 * listener — same handshake the dashboard performs (preflight, then callback).
 * Mirrors `live-login-credentials.test.mjs`. */
async function completeLogin(connectUrl, accountId) {
    const url = new URL(connectUrl);
    const callbackBase = `http://127.0.0.1:${url.searchParams.get("port")}`;
    const headers = { origin: url.origin, "content-type": "application/json" };
    const body = {
        state: url.searchParams.get("connectState"),
        publicKey: url.searchParams.get("publicKey"),
        relayer: url.searchParams.get("relayer"),
    };

    const preflight = await fetch(`${callbackBase}/preflight`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
    assert.equal(preflight.status, 200);

    const callback = await fetch(`${callbackBase}/callback`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            state: body.state,
            accountId,
            walletAddress: "0x" + "2".repeat(64),
            packageId: "0x" + "4".repeat(64),
        }),
    });
    assert.equal(callback.status, 200);
}

/** Poll until `predicate` holds. Same shape as `live-login-credentials`. */
async function waitUntil(predicate, timeoutMs = 10_000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
        await new Promise((r) => setTimeout(r, 25));
    }
}

test("a rejected key keeps failing fast, and memwal_login restores service", async (t) => {
    const relayer = await startRevokedKeyRelayer(BEARER);
    const { server, base } = relayer;
    const bridge = startBridge(base);
    t.after(() => {
        bridge.cleanup();
        server.close();
    });

    bridge.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
        },
    });
    await bridge.waitFor((m) => m.id === 1 && m.result, 15000);

    const recall = (id) => {
        bridge.send({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "memwal_recall", arguments: { query: "anything", limit: 5 } },
        });
        return bridge.waitFor((m) => m.id === id && (m.result || m.error), 20000);
    };

    const first = await recall(2);
    assert.ok(first.result?.isError || first.error, "first recall must be an auth error");

    // The bridge must still be reading stdin after the 401 answered the first
    // call. A second recall is refused ON ARRIVAL, so it comes back well inside
    // CALL_TIMEOUT_MS — anything near that deadline means it parked instead.
    const startedAt = Date.now();
    const second = await recall(3);
    const elapsed = Date.now() - startedAt;
    assert.ok(
        second.result?.isError || second.error,
        `second recall must also be an auth error, got: ${JSON.stringify(second)}`,
    );
    assert.ok(
        elapsed < CALL_TIMEOUT_MS / 2,
        `second recall must fail fast, took ${elapsed}ms (deadline ${CALL_TIMEOUT_MS}ms)`,
    );

    // Let the background connect back off a few times before signing in — a
    // real user takes seconds to click the link. By the 4th rejection the loop
    // is asleep for ~4s, which is long enough that "the pump woke because the
    // login published a session" and "the pump woke because the backoff
    // happened to expire" are no longer the same measurement.
    await waitUntil(() => relayer.rejections() >= 4, 15_000);

    // `memwal_login` is answered locally, so it must still work while the saved
    // key is being refused — it is the only way back in.
    bridge.send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memwal_login", arguments: {} },
    });
    const loginReply = await bridge.waitFor((m) => m.id === 4 && m.result, 20000);
    const connectUrl = /\*\*URL:\*\* (\S+)/.exec(textOf(loginReply))?.[1];
    assert.ok(connectUrl, `memwal_login must return the browser URL, got: ${textOf(loginReply)}`);
    await completeLogin(connectUrl, ACCOUNT);
    // The login's own reconnect owns the new handshake; wait for the relayer to
    // accept it before asking for the recall, so the assertion below is about
    // the flag being cleared and not about who won a race.
    await waitUntil(() => relayer.accepted() > 0);

    // The new key is accepted, so the bridge must resume normal buffering: an
    // ordinary empty result, not the credentials-rejected refusal. It must also
    // land promptly: the login's own reconnect has to release the server pump,
    // because nothing else is draining this stream until the background
    // connect's backoff — up to 15s in production — next expires.
    const recoveredAt = Date.now();
    const recovered = await recall(5);
    const recoveredIn = Date.now() - recoveredAt;
    assert.equal(
        recovered.error,
        undefined,
        `recall after re-login must not error: ${JSON.stringify(recovered)}`,
    );
    assert.notEqual(
        recovered.result?.isError,
        true,
        `recall after re-login must not be refused: ${JSON.stringify(recovered)}`,
    );
    assert.match(textOf(recovered), /no matching memories/i);
    assert.ok(
        recoveredIn < 1500,
        `recall after re-login must not wait for the connect backoff, took ${recoveredIn}ms`,
    );
    // The saved key really was refused throughout, rather than the relayer
    // having quietly accepted it at some point.
    assert.ok(relayer.rejections() > 0, "the revoked key must have been 401'd");
});

test("an initialize queued before the 401 does not swallow a reused id after memwal_login", async (t) => {
    const relayer = await startRevokedKeyRelayer(BEARER, { holdRejections: true });
    const { server, base } = relayer;
    const bridge = startBridge(base);
    t.after(() => {
        bridge.cleanup();
        server.close();
    });

    // The bridge answers initialize locally and arms a suppression for the
    // upstream reply it expects once the initialize is forwarded. With the 401
    // held, both requests are still queued when the key is rejected, so neither
    // is ever forwarded and no upstream reply comes to consume that arm.
    bridge.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
        },
    });
    await bridge.waitFor((m) => m.id === 1 && m.result, 15000);
    bridge.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything", limit: 5 } },
    });
    relayer.releaseRejections();
    const refused = await bridge.waitFor((m) => m.id === 2 && (m.result || m.error), 20000);
    assert.ok(refused.result?.isError || refused.error, "queued recall must be an auth error");

    bridge.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memwal_login", arguments: {} },
    });
    const loginReply = await bridge.waitFor((m) => m.id === 3 && m.result, 20000);
    const connectUrl = /\*\*URL:\*\* (\S+)/.exec(textOf(loginReply))?.[1];
    assert.ok(connectUrl, `memwal_login must return the browser URL, got: ${textOf(loginReply)}`);
    await completeLogin(connectUrl, ACCOUNT);
    await waitUntil(() => relayer.accepted() > 0);

    // JSON-RPC lets a client reuse an id once its request is answered. A
    // leftover arm drops this genuine reply and untracks the id, so not even
    // the orphan sweeper answers it: the call hangs.
    bridge.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything", limit: 5 } },
    });
    const reply = await bridge.waitFor(
        (m) => m.id === 1 && Array.isArray(m.result?.content),
        20000,
    );
    assert.notEqual(
        reply.result.isError,
        true,
        `reused id must get the relayer's reply, got: ${JSON.stringify(reply)}`,
    );
    assert.match(textOf(reply), /no matching memories/i);
});

/**
 * Relayer whose key is revoked WHILE a session is live: the open stream is cut
 * and every later handshake 401s. `restore()` puts it back, standing in for a
 * WAF or rate-limit 401 that clears on its own.
 */
function startMidSessionRevokeRelayer() {
    let sseRes = null;
    let rejecting = false;
    let parkCalls = false;
    let accepted = 0;
    let rejections = 0;
    let calls = 0;

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/version") {
            serveVersion(res);
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/mcp/sse") {
            if (rejecting) {
                rejections += 1;
                res.writeHead(401, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "delegate key was revoked" }));
                return;
            }
            accepted += 1;
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            res.write(`event: endpoint\ndata: /api/mcp/messages?sessionId=s${accepted}\n\n`);
            const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 250);
            heartbeat.unref?.();
            res.on("close", () => clearInterval(heartbeat));
            sseRes = res;
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/mcp/messages") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                res.writeHead(202);
                res.end();
                let msg;
                try {
                    msg = JSON.parse(body);
                } catch {
                    return;
                }
                if (msg.id == null) return;
                if (msg.method === "tools/call") {
                    calls += 1;
                    // Park it: the point of the revocation case is a call that
                    // is already in flight when the key stops being accepted.
                    if (parkCalls) return;
                }
                sseRes?.write(
                    `event: message\ndata: ${JSON.stringify({
                        jsonrpc: "2.0",
                        id: msg.id,
                        result:
                            msg.method === "tools/call"
                                ? {
                                      content: [
                                          { type: "text", text: "No matching memories found." },
                                      ],
                                      isError: false,
                                  }
                                : {},
                    })}\n\n`,
                );
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });

    return new Promise((ready) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            ready({
                server,
                base: `http://127.0.0.1:${port}`,
                accepted: () => accepted,
                rejections: () => rejections,
                calls: () => calls,
                park: () => {
                    parkCalls = true;
                },
                revoke: () => {
                    rejecting = true;
                    parkCalls = false;
                    sseRes?.destroy();
                    sseRes = null;
                },
                restore: () => {
                    rejecting = false;
                },
            });
        });
    });
}

test("a key revoked mid-session answers the in-flight call instead of orphaning it", async (t) => {
    const relayer = await startMidSessionRevokeRelayer();
    const bridge = startBridge(relayer.base);
    t.after(() => {
        bridge.cleanup();
        relayer.server.close();
    });

    bridge.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
        },
    });
    await bridge.waitFor((m) => m.id === 1 && m.result, 15000);
    await waitUntil(() => relayer.accepted() > 0);

    // In flight against a live session, with no reply coming.
    relayer.park();
    bridge.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything", limit: 5 } },
    });
    await waitUntil(() => relayer.calls() > 0);

    // The key is revoked underneath it: the stream is cut and the reconnect
    // that follows is 401'd.
    const revokedAt = Date.now();
    relayer.revoke();

    const reply = await bridge.waitFor((m) => m.id === 2 && (m.result || m.error), 20000);
    const elapsed = Date.now() - revokedAt;
    const text = `${textOf(reply)} ${reply?.error?.message ?? ""}`.toLowerCase();

    assert.ok(reply.error || reply.result?.isError, "the in-flight call must be answered as error");
    assert.match(
        text,
        /401|credential|unauthorized|memwal_login/,
        `the in-flight call must name the rejection, got: ${text}`,
    );
    assert.ok(
        !text.includes("please retry"),
        `"please retry" is the orphan sweeper's advice and cannot work here, got: ${text}`,
    );
    assert.ok(
        elapsed < CALL_TIMEOUT_MS,
        `must beat the orphan sweeper's ${CALL_TIMEOUT_MS}ms deadline, took ${elapsed}ms`,
    );
});

test("a transient mid-session 401 recovers on its own, without memwal_login", async (t) => {
    const relayer = await startMidSessionRevokeRelayer();
    const bridge = startBridge(relayer.base);
    t.after(() => {
        bridge.cleanup();
        relayer.server.close();
    });

    bridge.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
        },
    });
    await bridge.waitFor((m) => m.id === 1 && m.result, 15000);
    await waitUntil(() => relayer.accepted() > 0);

    // A WAF or rate-limit blip: 401 for a while, then fine again. Nothing here
    // calls `memwal_login` — the saved key was always good.
    relayer.revoke();
    await waitUntil(() => relayer.rejections() >= 2, 15_000);
    relayer.restore();

    // The server pump keeps driving `reconnect()` on the dead stream, so the
    // bridge must find its own way back without the client intervening.
    await waitUntil(() => relayer.accepted() >= 2, 20_000);

    bridge.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything", limit: 5 } },
    });
    const reply = await bridge.waitFor((m) => m.id === 3 && (m.result || m.error), 20000);
    assert.equal(reply.error, undefined, `recovered recall must not error: ${JSON.stringify(reply)}`);
    assert.notEqual(
        reply.result?.isError,
        true,
        `recovered recall must not still be refused: ${JSON.stringify(reply)}`,
    );
    assert.match(textOf(reply), /no matching memories/i);
});
