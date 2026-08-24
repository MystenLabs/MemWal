/**
 * Concurrent tools/call must not overlap POSTs on the SSE session.
 * Overlapping POSTs drop the session; afterwards even health hung until restart.
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

function startMockRelayer() {
    let sseRes = null;
    let inFlightPosts = 0;
    let overlap = 0;
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
            res.write("event: endpoint\ndata: /api/mcp/messages?sessionId=test\n\n");
            sseRes = res;
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/mcp/messages") {
            inFlightPosts += 1;
            if (inFlightPosts > 1) overlap += 1;
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                setTimeout(() => {
                    inFlightPosts -= 1;
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
                                    content: [{ type: "text", text: `OK:${msg.params?.name}` }],
                                    isError: false,
                                },
                            })}\n\n`,
                        );
                    }
                }, 40);
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise((resolveListen) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            resolveListen({
                server,
                base: `http://127.0.0.1:${port}`,
                overlap: () => overlap,
            });
        });
    });
}

test("concurrent tool calls do not overlap POSTs on the SSE session", async (t) => {
    const { server, base, overlap } = await startMockRelayer();
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

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    await waitFor((m) => m.id === 1 && m.result);

    send({ jsonrpc: "2.0", id: 2, method: "notifications/initialized" });
    await waitFor((m) => m.method === "notifications/tools/list_changed");

    for (const id of [10, 11, 12, 13]) {
        send({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "memwal_recall", arguments: { query: `q${id}` } },
        });
    }

    const replies = [];
    for (const id of [10, 11, 12, 13]) {
        replies.push(await waitFor((m) => m.id === id && (m.result || m.error)));
    }
    assert.equal(overlap(), 0);
    for (const reply of replies) {
        assert.equal(reply.error, undefined);
        const text = reply.result?.content?.[0]?.text ?? "";
        assert.match(text, /^OK:/);
        assert.doesNotMatch(text, /did not answer this call/);
    }
});
