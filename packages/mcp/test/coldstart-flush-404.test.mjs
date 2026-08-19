/**
 * Regression test for GH #415 round-2 finding N1 — a 404 during the post-connect
 * flush must NOT cause buffered requests to be delivered twice.
 *
 * Bug being guarded against: buffered tool calls live in BOTH pendingForward and
 * inFlight. If a POST during flushPendingForward returns 404, reconnect() replays
 * the ENTIRE inFlight map (all still-queued items) against the fresh session — and
 * if the flush loop then keeps draining pendingForward, those items get POSTed a
 * SECOND time (duplicate memory writes + two JSON-RPC replies for one id).
 *
 * Repro:
 *   - Client sends initialize + three tools/call BEFORE the relayer connects (all
 *     buffered). The mock delays the endpoint event so they queue up.
 *   - First SSE session: the first POST it receives returns 404 (stale-session
 *     race), forcing reconnect. The second session answers normally.
 *   - Assert: each of the three tool-call ids is answered EXACTLY once, and the
 *     relayer received each distinct fact EXACTLY once (no duplicate write).
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
const SSE_DELAY_MS = 700;

function hasBridgeAuth(req) {
    return (
        req.headers.authorization === `Bearer ${EXPECTED_BEARER}` &&
        req.headers["x-memwal-account-id"] === EXPECTED_ACCOUNT_ID
    );
}

/** Mock relayer: two SSE sessions. The FIRST POST to session-1 returns 404
 * (forcing a reconnect mid-flush); session-2 answers normally. Counts how many
 * times each distinct fact text is received, to detect duplicate delivery. */
function startFlaky404Relayer() {
    const sessions = new Map();
    let sseGetCount = 0;
    let firstPostRejected = false;
    const factDeliveries = new Map(); // fact text -> count

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, "http://127.0.0.1");
        if (req.method === "GET" && u.pathname === "/version") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ apiVersion: "1.0.0", relayerVersion: "1.0.0", minSupportedSdk: { mcp: "0.0.1" } }));
            return;
        }
        if (req.method === "GET" && u.pathname === "/api/mcp/sse") {
            if (!hasBridgeAuth(req)) { res.writeHead(401); res.end(); return; }
            sseGetCount += 1;
            const sessionId = `session-${sseGetCount}`;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
            // Delay the endpoint event on the FIRST session so the client buffers
            // initialize + all three tool calls before the stream is up.
            const delay = sseGetCount === 1 ? SSE_DELAY_MS : 0;
            const t = setTimeout(() => {
                if (res.writableEnded) return;
                res.write(`event: endpoint\ndata: /api/mcp/messages?sessionId=${sessionId}\n\n`);
                sessions.set(sessionId, { res });
                const hb = setInterval(() => { if (!res.writableEnded) res.write(":\n\n"); else clearInterval(hb); }, 200);
                hb.unref?.();
                res.on("close", () => clearInterval(hb));
            }, delay);
            t.unref?.();
            return;
        }
        if (req.method === "POST" && u.pathname === "/api/mcp/messages") {
            if (!hasBridgeAuth(req)) { res.writeHead(401); res.end(); return; }
            const sessionId = u.searchParams.get("sessionId");
            const session = sessions.get(sessionId);
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                let msg;
                try { msg = JSON.parse(body); } catch { res.writeHead(202); res.end(); return; }
                // Reject the very first tool-call POST once, to force a reconnect
                // during the flush. initialize is allowed through so the handshake
                // forward isn't what trips it.
                if (!firstPostRejected && msg.method === "tools/call") {
                    firstPostRejected = true;
                    res.writeHead(404);
                    res.end();
                    return;
                }
                if (!session) { res.writeHead(404); res.end(); return; }
                res.writeHead(202);
                res.end();
                if (msg.method === "initialize") return; // suppressed by the bridge
                if (msg.method === "tools/call" && msg.params?.name === "memwal_remember") {
                    const fact = msg.params?.arguments?.text ?? "";
                    factDeliveries.set(fact, (factDeliveries.get(fact) ?? 0) + 1);
                    session.res.write(
                        `event: message\ndata: ${JSON.stringify({
                            jsonrpc: "2.0",
                            id: msg.id,
                            result: { content: [{ type: "text", text: `SAVED:${fact}` }], isError: false },
                        })}\n\n`,
                    );
                    return;
                }
            });
            return;
        }
        res.writeHead(404); res.end();
    });
    return new Promise((res) => {
        server.listen(0, "127.0.0.1", () => {
            res({
                server,
                base: `http://127.0.0.1:${server.address().port}`,
                factDeliveries,
                getSseGetCount: () => sseGetCount,
            });
        });
    });
}

function makeCreds(relayerUrl) {
    return {
        delegatePrivateKey: EXPECTED_BEARER, delegatePublicKeyHex: "b".repeat(64),
        delegateAddress: "0x" + "1".repeat(64), walletAddress: "0x" + "2".repeat(64),
        accountId: EXPECTED_ACCOUNT_ID, packageId: "0x" + "4".repeat(64),
        relayerUrl, label: "Flush404 Test", createdAt: new Date(0).toISOString(), version: 1,
    };
}

test("a 404 during the post-connect flush does not double-deliver buffered requests", async (t) => {
    const mock = await startFlaky404Relayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-flush404-test-"));
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
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
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
            const timer = setTimeout(() => { listeners.delete(l); rej(new Error(`timeout\n${stderrBuf}\n${received.map((m) => JSON.stringify(m)).join("\n")}`)); }, ms);
            const l = (m) => { if (pred(m)) { clearTimeout(timer); listeners.delete(l); res(m); } };
            listeners.add(l);
        });
    };

    t.after(() => { child.kill("SIGKILL"); mock.server.close(); rmSync(home, { recursive: true, force: true }); });

    // Handshake + three remembers, all sent before the (delayed) connect → buffered.
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor((m) => m.id === 1 && m.result, 3_000);
    for (const [id, fact] of [[2, "fact-A"], [3, "fact-B"], [4, "fact-C"]]) {
        send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "memwal_remember", arguments: { text: fact } } });
    }

    // All three must be answered (after the 404 → reconnect → replay recovers them).
    await waitFor((m) => m.id === 2, 10_000);
    await waitFor((m) => m.id === 3, 10_000);
    await waitFor((m) => m.id === 4, 10_000);

    // Give any erroneous duplicate delivery a chance to land before asserting.
    await new Promise((r) => setTimeout(r, 500));

    // Each id answered EXACTLY once (no duplicate JSON-RPC response for an id).
    for (const id of [2, 3, 4]) {
        const replies = received.filter((m) => m.id === id && (m.result || m.error));
        assert.equal(replies.length, 1, `id=${id} must be answered exactly once, saw ${replies.length}: ${JSON.stringify(replies)}`);
    }

    // Each distinct fact delivered to the relayer EXACTLY once (no duplicate write).
    for (const fact of ["fact-A", "fact-B", "fact-C"]) {
        assert.equal(
            mock.factDeliveries.get(fact),
            1,
            `fact "${fact}" must be written exactly once, was written ${mock.factDeliveries.get(fact)} time(s)`,
        );
    }

    // Sanity: the 404 actually forced a reconnect (>=2 SSE handshakes).
    assert.ok(mock.getSseGetCount() >= 2, `expected a reconnect (>=2 SSE handshakes), saw ${mock.getSseGetCount()}`);
});

test("a request arriving DURING the flush-404 reconnect backoff is delivered exactly once (not double-posted)", async (t) => {
    // Round-4 finding C2: a tools/call that arrives while reconnect is in its
    // backoff lands in BOTH inFlight (reconnect replays it) AND pendingForward
    // (the flush would re-post it) → double delivery. This times a second
    // request into that ~500ms backoff window and asserts single delivery.
    const mock = await startFlaky404Relayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-flush404b-test-"));
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
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
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
            const timer = setTimeout(() => { listeners.delete(l); rej(new Error(`timeout\n${stderrBuf}\n${received.map((m) => JSON.stringify(m)).join("\n")}`)); }, ms);
            const l = (m) => { if (pred(m)) { clearTimeout(timer); listeners.delete(l); res(m); } };
            listeners.add(l);
        });
    };

    t.after(() => { child.kill("SIGKILL"); mock.server.close(); rmSync(home, { recursive: true, force: true }); });

    // initialize + one remember up front. The remember's flush POST 404s →
    // reconnect() enters a ~500ms backoff.
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor((m) => m.id === 1 && m.result, 5_000);
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memwal_remember", arguments: { text: "fact-A" } } });

    // Send a SECOND remember ~150ms later — inside the reconnect backoff window,
    // so it arrives while flushing===true and reconnect is sleeping.
    await new Promise((r) => setTimeout(r, 150));
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memwal_remember", arguments: { text: "fact-B" } } });

    await waitFor((m) => m.id === 2, 10_000);
    await waitFor((m) => m.id === 3, 10_000);
    await new Promise((r) => setTimeout(r, 500)); // let any duplicate land

    for (const id of [2, 3]) {
        const replies = received.filter((m) => m.id === id && (m.result || m.error));
        assert.equal(replies.length, 1, `id=${id} must be answered exactly once, saw ${replies.length}`);
    }
    for (const fact of ["fact-A", "fact-B"]) {
        assert.equal(
            mock.factDeliveries.get(fact),
            1,
            `fact "${fact}" must be written exactly once, was written ${mock.factDeliveries.get(fact)} time(s)`,
        );
    }
});

/** Like startFlaky404Relayer, but on the first tool-call POST it BOTH returns 404
 * AND closes session-1's SSE stream. Closing the stream makes the bridge's
 * serverPump see EOF and trigger its OWN reconnect('server-pump-eof'), which can
 * win the `reconnecting` flag before the flush's reconnect('post-404') — the
 * round-5 finding D1 double-post scenario. */
function startConcurrentReconnectRelayer() {
    const sessions = new Map();
    let sseGetCount = 0;
    let firstPostRejected = false;
    const factDeliveries = new Map();
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, "http://127.0.0.1");
        if (req.method === "GET" && u.pathname === "/version") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ apiVersion: "1.0.0", relayerVersion: "1.0.0", minSupportedSdk: { mcp: "0.0.1" } }));
            return;
        }
        if (req.method === "GET" && u.pathname === "/api/mcp/sse") {
            if (!hasBridgeAuth(req)) { res.writeHead(401); res.end(); return; }
            sseGetCount += 1;
            const sessionId = `session-${sseGetCount}`;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
            const delay = sseGetCount === 1 ? SSE_DELAY_MS : 0;
            const t = setTimeout(() => {
                if (res.writableEnded) return;
                res.write(`event: endpoint\ndata: /api/mcp/messages?sessionId=${sessionId}\n\n`);
                sessions.set(sessionId, { res });
                const hb = setInterval(() => { if (!res.writableEnded) res.write(":\n\n"); else clearInterval(hb); }, 200);
                hb.unref?.();
                res.on("close", () => clearInterval(hb));
            }, delay);
            t.unref?.();
            return;
        }
        if (req.method === "POST" && u.pathname === "/api/mcp/messages") {
            if (!hasBridgeAuth(req)) { res.writeHead(401); res.end(); return; }
            const sessionId = u.searchParams.get("sessionId");
            const session = sessions.get(sessionId);
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                let msg;
                try { msg = JSON.parse(body); } catch { res.writeHead(202); res.end(); return; }
                if (!firstPostRejected && msg.method === "tools/call") {
                    firstPostRejected = true;
                    // Close session-1's SSE stream so serverPump also reconnects.
                    const s1 = sessions.get(sessionId);
                    if (s1 && !s1.res.writableEnded) s1.res.end();
                    sessions.delete(sessionId);
                    res.writeHead(404); res.end();
                    return;
                }
                if (!session) { res.writeHead(404); res.end(); return; }
                res.writeHead(202); res.end();
                if (msg.method === "initialize") return;
                if (msg.method === "tools/call" && msg.params?.name === "memwal_remember") {
                    const fact = msg.params?.arguments?.text ?? "";
                    factDeliveries.set(fact, (factDeliveries.get(fact) ?? 0) + 1);
                    session.res.write(`event: message\ndata: ${JSON.stringify({
                        jsonrpc: "2.0", id: msg.id,
                        result: { content: [{ type: "text", text: `SAVED:${fact}` }], isError: false },
                    })}\n\n`);
                    return;
                }
            });
            return;
        }
        res.writeHead(404); res.end();
    });
    return new Promise((res) => {
        server.listen(0, "127.0.0.1", () => {
            res({ server, base: `http://127.0.0.1:${server.address().port}`, factDeliveries, getSseGetCount: () => sseGetCount });
        });
    });
}

test("a concurrent serverPump reconnect during the flush-404 does not double-deliver buffered requests", async (t) => {
    const mock = await startConcurrentReconnectRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-flush404c-test-"));
    const credsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify(makeCreds(mock.base)), { mode: 0o600 });

    const child = spawn(process.execPath, [BIN, "--relayer", mock.base, "--web-url", mock.base], {
        env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ["pipe", "pipe", "pipe"],
    });

    const received = [];
    const listeners = new Set();
    let buf = "";
    child.stdout.on("data", (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
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
            const timer = setTimeout(() => { listeners.delete(l); rej(new Error(`timeout\n${stderrBuf}\n${received.map((m) => JSON.stringify(m)).join("\n")}`)); }, ms);
            const l = (m) => { if (pred(m)) { clearTimeout(timer); listeners.delete(l); res(m); } };
            listeners.add(l);
        });
    };

    t.after(() => { child.kill("SIGKILL"); mock.server.close(); rmSync(home, { recursive: true, force: true }); });

    // initialize + three remembers, all buffered before the delayed connect.
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor((m) => m.id === 1 && m.result, 5_000);
    for (const [id, fact] of [[2, "fact-A"], [3, "fact-B"], [4, "fact-C"]]) {
        send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "memwal_remember", arguments: { text: fact } } });
    }

    await waitFor((m) => m.id === 2, 12_000);
    await waitFor((m) => m.id === 3, 12_000);
    await waitFor((m) => m.id === 4, 12_000);
    await new Promise((r) => setTimeout(r, 600)); // let any duplicate land

    for (const id of [2, 3, 4]) {
        const replies = received.filter((m) => m.id === id && (m.result || m.error));
        assert.equal(replies.length, 1, `id=${id} answered exactly once, saw ${replies.length}: ${JSON.stringify(replies)}`);
    }
    for (const fact of ["fact-A", "fact-B", "fact-C"]) {
        assert.equal(
            mock.factDeliveries.get(fact),
            1,
            `fact "${fact}" written exactly once, was written ${mock.factDeliveries.get(fact)} time(s)`,
        );
    }
});
