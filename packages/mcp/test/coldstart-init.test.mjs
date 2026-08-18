/**
 * Regression test for GH #415 — the bridge must NOT block the MCP `initialize`
 * handshake on the relayer connect during a slow cold start.
 *
 * Bug being guarded against: on a credentialed cold start, `runBridge` awaited a
 * full relayer round-trip (TLS + GET /version + SSE handshake + endpoint event)
 * BEFORE it read stdin or answered `initialize`. `initialize` was forwarded to
 * the relayer, not answered locally, so a slow relayer tripped the MCP client's
 * ~30s connection timeout → the client SIGTERM'd the process → no tools loaded.
 *
 * Repro here:
 *   - Mock relayer answers GET /version immediately but DELAYS the SSE endpoint
 *     event by SSE_DELAY_MS, simulating a slow/cold relayer.
 *   - The bridge must answer `initialize` and a cold-start `tools/list` LOCALLY
 *     and near-instantly — well before the SSE stream is up.
 *   - A `tools/call` sent before the stream is up must be BUFFERED and served
 *     once the relayer connect completes (not dropped, not hung).
 *   - Once connected, the bridge emits notifications/tools/list_changed so the
 *     client re-lists and gets the real upstream tool set.
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

/** How long the mock relayer withholds the SSE endpoint event. Large enough
 * that a bridge which (wrongly) waited on the relayer before answering
 * `initialize` would blow the assertion deadlines below. */
const SSE_DELAY_MS = 3_000;

/** The tools the real relayer sidecar registers
 * (services/server/scripts/mcp/tools/index.ts). The cold-start static list must
 * cover exactly these (plus the locally-served login/logout), so the
 * static→refreshed transition doesn't change the tool set under the client. */
const UPSTREAM_TOOL_NAMES = [
    "memwal_remember",
    "memwal_remember_bulk",
    "memwal_recall",
    "memwal_analyze",
    "memwal_restore",
    "memwal_health",
];

function hasBridgeAuth(req) {
    return (
        req.headers.authorization === `Bearer ${EXPECTED_BEARER}` &&
        req.headers["x-memwal-account-id"] === EXPECTED_ACCOUNT_ID
    );
}

/** Mock relayer that cold-starts slowly: /version is instant, but the SSE
 * endpoint event is delayed by SSE_DELAY_MS. After that, the session behaves
 * normally (answers initialize + tools/call over the stream). */
function startSlowRelayer() {
    const sessions = new Map();
    let sseGetCount = 0;
    let versionHits = 0;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/version") {
            versionHits += 1;
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
            // The slow part: withhold the endpoint event. A correct bridge has
            // already answered initialize locally by now.
            const t = setTimeout(() => {
                if (res.writableEnded) return;
                res.write(
                    `event: endpoint\ndata: /api/mcp/messages?sessionId=${sessionId}\n\n`,
                );
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
            }, SSE_DELAY_MS);
            t.unref?.();
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
                    // The upstream initialize reply — the bridge must SUPPRESS
                    // this (client already got the local one). If it leaked, the
                    // client would see two responses for the same id.
                    session.res.write(
                        `event: message\ndata: ${JSON.stringify({
                            jsonrpc: "2.0",
                            id: msg.id,
                            result: {
                                protocolVersion: "2024-11-05",
                                capabilities: { tools: { listChanged: true } },
                                serverInfo: { name: "memwal-upstream", version: "9.9.9" },
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
                                content: [{ type: "text", text: "RECALL_OK: served after background connect" }],
                                isError: false,
                            },
                        })}\n\n`,
                    );
                    return;
                }
                if (msg.method === "tools/list") {
                    // The real upstream tool set (the 6 tools the sidecar
                    // registers). The bridge splices login/logout onto this.
                    session.res.write(
                        `event: message\ndata: ${JSON.stringify({
                            jsonrpc: "2.0",
                            id: msg.id,
                            result: {
                                tools: UPSTREAM_TOOL_NAMES.map((name) => ({
                                    name,
                                    description: `upstream ${name}`,
                                    inputSchema: { type: "object" },
                                })),
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
                getVersionHits: () => versionHits,
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
        label: "Coldstart Test",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

test("initialize is answered locally during a slow relayer cold start; tools/call is buffered then served", async (t) => {
    const mock = await startSlowRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-coldstart-test-"));
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

    const startedAt = Date.now();

    // 1) initialize must come back near-instantly — well before the relayer's
    //    SSE endpoint event (SSE_DELAY_MS). This is the core fix. We request a
    //    specific protocolVersion to confirm the local responder ECHOES it
    //    (rather than hard-coding one and ignoring the client's request).
    send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    const init = await waitFor((m) => m.id === 1 && m.result, SSE_DELAY_MS);
    const initElapsed = Date.now() - startedAt;
    assert.equal(init.result.serverInfo.name, "memwal");
    assert.equal(init.result.capabilities.tools.listChanged, true);
    assert.equal(
        init.result.protocolVersion,
        "2025-06-18",
        `expected the local initialize to echo the requested protocolVersion, got ${init.result.protocolVersion}`,
    );
    assert.ok(
        initElapsed < SSE_DELAY_MS - 500,
        `initialize took ${initElapsed}ms — expected it answered locally, well before the ${SSE_DELAY_MS}ms relayer connect`,
    );

    // 2) tools/list at cold start is served locally and instantly with the
    //    static list, which must be EXACTLY the upstream tool set plus the
    //    locally-served login/logout — each name once.
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const list = await waitFor((m) => m.id === 2 && m.result, SSE_DELAY_MS);
    const coldNames = list.result.tools.map((t) => t.name);
    const expectedNames = new Set([...UPSTREAM_TOOL_NAMES, "memwal_login", "memwal_logout"]);
    // Unique names (TOOL_DEFINITIONS bundles its own memwal_login; a blind concat
    // with the local login/logout defs would list it twice).
    assert.equal(
        new Set(coldNames).size,
        coldNames.length,
        `cold tools/list has duplicate tool names: ${coldNames}`,
    );
    // Exact set match — guards against the cold list drifting from the real
    // upstream registration (e.g. missing memwal_remember_bulk / memwal_health).
    assert.deepEqual(
        new Set(coldNames),
        expectedNames,
        `cold tools/list set mismatch. got ${[...coldNames].sort()}, expected ${[...expectedNames].sort()}`,
    );

    // 3) tools/call sent BEFORE the stream is up must be buffered and served
    //    once the background connect completes (not dropped, not hung).
    send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything" } },
    });
    const recall = await waitFor((m) => m.id === 3, 15_000);
    assert.notEqual(recall.result?.isError, true);
    assert.match(JSON.stringify(recall.result), /RECALL_OK/);

    // 4) Once connected, the bridge announces the real tool set so the client
    //    re-lists (notifications/tools/list_changed).
    const changed = await waitFor((m) => m.method === "notifications/tools/list_changed", 5_000);
    assert.ok(changed);

    // 5) The upstream initialize reply (serverInfo "memwal-upstream") must have
    //    been SUPPRESSED — the client only ever saw our local reply for id 1.
    const initReplies = received.filter((r) => r.msg.id === 1 && r.msg.result);
    assert.equal(
        initReplies.length,
        1,
        `expected exactly one initialize reply, saw ${initReplies.length}: ${JSON.stringify(initReplies.map((r) => r.msg))}`,
    );
    assert.equal(initReplies[0].msg.result.serverInfo.name, "memwal");

    // 6) After connect, a re-list is forwarded upstream and spliced with
    //    login/logout. That authoritative set must EQUAL the cold static set —
    //    the static→refreshed transition must not change the tool set (each
    //    name once, no dup even if upstream ever served login).
    send({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    const relist = await waitFor((m) => m.id === 4 && m.result, 10_000);
    const splicedNames = relist.result.tools.map((t) => t.name);
    assert.equal(
        new Set(splicedNames).size,
        splicedNames.length,
        `post-connect tools/list has duplicate tool names: ${splicedNames}`,
    );
    assert.deepEqual(
        new Set(splicedNames),
        new Set(coldNames),
        `cold and post-connect tool sets differ. cold=${[...coldNames].sort()} spliced=${[...splicedNames].sort()}`,
    );

    assert.ok(mock.getSseGetCount() >= 1, "expected at least one SSE handshake");
});
