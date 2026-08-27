/**
 * A background `memwal_login` that never completes must not stay silent.
 *
 * The tool call returns the sign-in URL immediately, so by the time the flow
 * fails there is no pending response left to turn into an error. The next
 * memory tool call is the first chance to say so, and this asserts it takes it.
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

/** Answers the /version probe only — the sign-in is meant to time out. */
function startMockRelayer() {
    const server = http.createServer((req, res) => {
        if (new URL(req.url, "http://127.0.0.1").pathname === "/version") {
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
        res.writeHead(404);
        res.end();
    });
    return new Promise((res) => {
        server.listen(0, "127.0.0.1", () => {
            res({ server, base: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

/** Version probe plus SSE so a signed-in process can boot the bridge. */
function startBridgeRelayer() {
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
            res.write("event: endpoint\ndata: /api/mcp/messages?sessionId=test\n\n");
            sseRes = res;
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/mcp/messages") {
            res.writeHead(202);
            res.end();
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise((res) => {
        server.listen(0, "127.0.0.1", () => {
            res({
                server,
                base: `http://127.0.0.1:${server.address().port}`,
                closeSse: () => sseRes?.end(),
            });
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
        label: "timeout-test",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

function attachStdio(child) {
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
    return { send, waitFor };
}

test("a sign-in that never completes is reported on the next tool call", async (t) => {
    const { server, base } = await startMockRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-test-"));

    const child = spawn(process.execPath, [BIN, "--relayer", base, "--web-url", base], {
        env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            // Nobody opens the URL, so the listener closes almost at once.
            MEMWAL_MCP_LOGIN_TIMEOUT_MS: "600",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const { send, waitFor } = attachStdio(child);

    t.after(() => {
        child.kill("SIGKILL");
        server.close();
        rmSync(home, { recursive: true, force: true });
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await waitFor((m) => m.id === 1 && m.result);

    // Baseline: before any sign-in attempt the error carries no failure notice.
    send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything" } },
    });
    const before = await waitFor((m) => m.id === 2 && m.result);
    assert.equal(before.result.isError, true);
    assert.ok(
        !before.result.content[0].text.includes("never completed"),
        "a fresh server should not claim a sign-in failed",
    );

    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memwal_login" } });
    await waitFor((m) => m.id === 3 && m.result);

    // The flow now times out in the background with nobody listening for it.
    const warned = await waitFor(
        (m) =>
            m.method === "notifications/message" &&
            m.params?.level === "warning" &&
            String(m.params?.data).includes("did not complete"),
    );
    assert.match(String(warned.params.data), /Walrus Memory sign-in did not complete/);

    send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "anything" } },
    });
    const after = await waitFor((m) => m.id === 4 && m.result);
    const text = after.result.content[0].text;

    assert.equal(after.result.isError, true);
    assert.match(text, /never completed/);
    assert.match(text, /second attempt usually works/);
    // The wasted on-chain key is the part users cannot discover on their own.
    assert.match(text, /already be registered on your account/);
    // Still tells them how to sign in, rather than replacing the instruction.
    assert.match(text, /memwal_login/);
});

test("a signed-in memwal_login timeout warns through the bridge", async (t) => {
    const { server, base, closeSse } = await startBridgeRelayer();
    const home = mkdtempSync(join(tmpdir(), "memwal-test-"));
    const credsPath = join(home, ".memwal", "credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, JSON.stringify(makeCreds(base)), { mode: 0o600 });

    const child = spawn(process.execPath, [BIN, "--relayer", base, "--web-url", base], {
        env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            MEMWAL_MCP_LOGIN_TIMEOUT_MS: "600",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const { send, waitFor } = attachStdio(child);

    t.after(() => {
        child.kill("SIGKILL");
        closeSse();
        server.close();
        rmSync(home, { recursive: true, force: true });
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await waitFor((m) => m.id === 1 && m.result);

    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memwal_login" } });
    const login = await waitFor((m) => m.id === 2 && m.result);
    assert.equal(login.result.isError, false);

    const warned = await waitFor(
        (m) =>
            m.method === "notifications/message" &&
            m.params?.level === "warning" &&
            String(m.params?.data).includes("Existing credentials are unchanged"),
    );
    assert.match(String(warned.params.data), /Walrus Memory sign-in did not complete/);
});

test("loginFlow honors MEMWAL_MCP_LOGIN_TIMEOUT_MS when timeoutMs is omitted", async (t) => {
    const home = mkdtempSync(join(tmpdir(), "memwal-test-"));
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const prevTimeout = process.env.MEMWAL_MCP_LOGIN_TIMEOUT_MS;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MEMWAL_MCP_LOGIN_TIMEOUT_MS = "400";

    t.after(() => {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevProfile;
        if (prevTimeout === undefined) delete process.env.MEMWAL_MCP_LOGIN_TIMEOUT_MS;
        else process.env.MEMWAL_MCP_LOGIN_TIMEOUT_MS = prevTimeout;
        rmSync(home, { recursive: true, force: true });
    });

    const { loginFlow } = await import("../dist/login.js");
    await assert.rejects(
        loginFlow({
            openBrowser: false,
            webUrl: "http://127.0.0.1:9",
            relayerUrl: "http://127.0.0.1:9",
            label: "timeout-test",
        }),
        /timed out after 400ms/,
    );
});
