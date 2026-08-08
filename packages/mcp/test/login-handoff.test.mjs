/**
 * Integration test for auth-required → bridge hot-handoff (no second restart).
 *
 * Scenario (mirrors the "double reboot" bug):
 *   1. Spawn memwal-mcp with an EMPTY ~/.memwal (HOME pointed at a temp dir) so
 *      it boots in auth-required mode.
 *   2. `initialize` is answered locally; `memwal_recall` returns the
 *      not-signed-in instruction.
 *   3. Write a valid credentials.json mid-process (what `memwal_login`'s
 *      browser callback does).
 *   4. Call `memwal_recall` again — WITHOUT restarting the process — and assert
 *      it is served for real (forwarded to the relayer, real result back).
 *
 * A tiny mock relayer stands in for relayer.memory.walrus.xyz: it answers the
 * `/version` compatibility probe and speaks the SSE transport the bridge needs.
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

/** Minimal relayer: /version probe + SSE transport that echoes a recall reply. */
function startMockRelayer() {
    let sseRes = null;
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
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            // Tell the bridge where to POST outbound messages.
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
                if (msg.method === "tools/call" && msg.params?.name === "memwal_recall") {
                    const reply = {
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: {
                            content: [{ type: "text", text: "RECALL_OK: montreal trip" }],
                            isError: false,
                        },
                    };
                    sseRes?.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
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
            res({ server, base: `http://127.0.0.1:${port}` });
        });
    });
}

function makeCreds(relayerUrl) {
    return {
        delegatePrivateKey: "a".repeat(64),
        delegatePublicKeyHex: "b".repeat(64),
        delegateAddress: "0x" + "1".repeat(64),
        walletAddress: "0x" + "2".repeat(64),
        accountId: "0x" + "3".repeat(64),
        packageId: "0x" + "4".repeat(64),
        relayerUrl,
        label: "Integration Test",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

test("auth-required mode picks up credentials mid-session without a restart", async (t) => {
    const { server, base } = await startMockRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-test-"));
    const credsPath = join(home, ".memwal", "credentials.json");

    const child = spawn(process.execPath, [BIN, "--relayer", base, "--web-url", base], {
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

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    const waitFor = (pred, ms = 15000) => {
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

    t.after(() => {
        child.kill("SIGKILL");
        server.close();
        rmSync(home, { recursive: true, force: true });
    });

    // 1. initialize — answered locally by the auth-required server.
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await waitFor((m) => m.id === 1 && m.result);
    assert.equal(init.result.serverInfo.name, "memwal");

    // 2. recall before login → not-signed-in instruction.
    send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "montreal" } },
    });
    const before = await waitFor((m) => m.id === 2);
    assert.equal(before.result.isError, true, "should be an error before login");
    assert.match(
        JSON.stringify(before.result),
        /isn't signed in|not signed in/i,
        "should nudge the user to log in",
    );

    // 3. Login completes: write credentials into the same process's HOME.
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify(makeCreds(base)), { mode: 0o600 });

    // 4. recall again, same process, no restart → served for real via the relayer.
    send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "montreal" } },
    });
    const after = await waitFor((m) => m.id === 3);
    assert.notEqual(after.result.isError, true, "recall should succeed after login");
    assert.match(
        JSON.stringify(after.result),
        /RECALL_OK/,
        "recall result should come from the relayer, not the login stub",
    );
});
