/**
 * Regression test for GH #415 round-3 finding T2 — suppression of the upstream
 * `initialize` reply must be EXACTLY ONE reply, not a permanent id filter.
 *
 * Bug being guarded against: the bridge answers `initialize` locally and forwards
 * it upstream, suppressing the upstream reply. An earlier fix kept the initialize
 * id in a suppress set for the whole session AND dropped ANY error on that id — so
 * a client that (out of spec, but defensively supported) reuses the initialize id
 * for a later real request had that request's reply (result OR error) silently
 * swallowed, hanging the call. The fix makes suppression a one-shot count.
 *
 * This test reuses id=1 for a real tools/call after initialize and asserts the
 * real reply comes through — for both a success and an error response.
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

/** Mock relayer that answers immediately. It replies to initialize with an
 * upstream initialize result (to be suppressed), a memwal_recall call with a
 * success, and a memwal_restore call with a JSON-RPC error. */
function startRelayer() {
    const sessions = new Map();
    let sseGetCount = 0;
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
            res.write(`event: endpoint\ndata: /api/mcp/messages?sessionId=${sessionId}\n\n`);
            sessions.set(sessionId, { res });
            const hb = setInterval(() => { if (!res.writableEnded) res.write(":\n\n"); else clearInterval(hb); }, 200);
            hb.unref?.();
            res.on("close", () => clearInterval(hb));
            return;
        }
        if (req.method === "POST" && u.pathname === "/api/mcp/messages") {
            if (!hasBridgeAuth(req)) { res.writeHead(401); res.end(); return; }
            const session = sessions.get(u.searchParams.get("sessionId"));
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                let msg;
                try { msg = JSON.parse(body); } catch { res.writeHead(202); res.end(); return; }
                if (!session) { res.writeHead(404); res.end(); return; }
                res.writeHead(202); res.end();
                const name = msg.params?.name;
                if (msg.method === "initialize") {
                    // Upstream initialize reply — must be suppressed by the bridge.
                    session.res.write(`event: message\ndata: ${JSON.stringify({
                        jsonrpc: "2.0", id: msg.id,
                        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "memwal-upstream", version: "9.9.9" } },
                    })}\n\n`);
                    return;
                }
                if (msg.method === "tools/call" && name === "memwal_recall") {
                    session.res.write(`event: message\ndata: ${JSON.stringify({
                        jsonrpc: "2.0", id: msg.id,
                        result: { content: [{ type: "text", text: "REUSED_ID_RESULT" }], isError: false },
                    })}\n\n`);
                    return;
                }
                if (msg.method === "tools/call" && name === "memwal_restore") {
                    // A genuine JSON-RPC ERROR on a (reused) id — must reach the client.
                    session.res.write(`event: message\ndata: ${JSON.stringify({
                        jsonrpc: "2.0", id: msg.id,
                        error: { code: -32000, message: "REUSED_ID_ERROR" },
                    })}\n\n`);
                    return;
                }
            });
            return;
        }
        res.writeHead(404); res.end();
    });
    return new Promise((res) => {
        server.listen(0, "127.0.0.1", () => res({ server, base: `http://127.0.0.1:${server.address().port}` }));
    });
}

function makeCreds(relayerUrl) {
    return {
        delegatePrivateKey: EXPECTED_BEARER, delegatePublicKeyHex: "b".repeat(64),
        delegateAddress: "0x" + "1".repeat(64), walletAddress: "0x" + "2".repeat(64),
        accountId: EXPECTED_ACCOUNT_ID, packageId: "0x" + "4".repeat(64),
        relayerUrl, label: "IdReuse Test", createdAt: new Date(0).toISOString(), version: 1,
    };
}

test("reusing the initialize id for a real request still gets that request's reply (result and error)", async (t) => {
    const mock = await startRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-idreuse-test-"));
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

    // initialize (id=1) → local reply; upstream reply suppressed (one-shot).
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await waitFor((m) => m.id === 1 && m.result, 5_000);
    assert.equal(init.result.serverInfo.name, "memwal"); // local, not "memwal-upstream"

    // Let the connect settle so the request goes to the live session.
    await new Promise((r) => setTimeout(r, 500));

    // REUSE id=1 for a real tools/call with a SUCCESS reply — must come through.
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memwal_recall", arguments: { query: "x" } } });
    const okReply = await waitFor((m) => m.id === 1 && m.result && JSON.stringify(m.result).includes("REUSED_ID_RESULT"), 8_000);
    assert.ok(okReply, "reused-id success reply was suppressed (should pass through)");

    // REUSE id=1 again for a request whose upstream reply is an ERROR — must come through.
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memwal_restore", arguments: { namespace: "n" } } });
    const errReply = await waitFor((m) => m.id === 1 && m.error && m.error.message === "REUSED_ID_ERROR", 8_000);
    assert.ok(errReply, "reused-id error reply was suppressed (should pass through)");
});
