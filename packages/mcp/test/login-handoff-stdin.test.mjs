/**
 * After an in-session `memwal_login`, the bridge must keep serving stdin.
 *
 * The auth-required stub hands off by detaching its own listeners and calling
 * `process.stdin.pause()`. An explicitly paused stream does NOT resume just
 * because a new `data` listener is attached, so the bridge's reader has to ask
 * for it. Without that, the ONLY request served after signing in was the one
 * replayed from `pendingLines` — every later call was read by nobody and hung
 * until the client timed it out.
 *
 * That is WALM-394's "the next call timed out": the sign-in genuinely worked,
 * and the connection was deaf from the second call onward.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../dist/bin/memwal-mcp.js");

/**
 * Version probe + SSE + a relayer that actually ANSWERS forwarded calls.
 *
 * The failure-path fixtures never need a reply (nothing gets that far), but
 * the banner rides on a real `tools/call` result, so this one has to complete
 * the round-trip: read the POSTed request, push a matching JSON-RPC result
 * back down the SSE stream.
 */
function startAnsweringRelayer() {
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
            let body = "";
            req.on("data", (d) => {
                body += d;
            });
            req.on("end", () => {
                res.writeHead(202);
                res.end();

                let msg;
                try {
                    msg = JSON.parse(body);
                } catch {
                    return;
                }
                if (msg.id === undefined || msg.id === null) return;

                // Distinguishable payload so the assertion proves the banner
                // was prefixed onto a REAL upstream result, not substituted
                // for one.
                const result =
                    msg.method === "initialize"
                        ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mock", version: "1.0.0" } }
                        : { content: [{ type: "text", text: "UPSTREAM_RECALL_RESULT" }], isError: false };

                sseRes?.write(
                    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`,
                );
            });
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
                const seen = received
                    .map((m) => (m.id !== undefined ? `id=${m.id}` : m.method))
                    .join(", ");
                rej(new Error(`timed out waiting for message; received: [${seen}]`));
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

/**
 * Drive the browser half of the sign-in: the same preflight-then-callback
 * handshake a real wallet approval performs (pinned by login-preflight), so
 * no browser or on-chain transaction is involved.
 */
async function completeSignIn(loginText, webUrl) {
    const match = loginText.match(/http:\/\/127\.0\.0\.1:\d+\/connect\/mcp\?\S+/);
    assert.ok(match, `login result should carry a connect URL, got: ${loginText.slice(0, 300)}`);
    const connectUrl = new URL(match[0].replace(/[)`\s]+$/, ""));

    const port = connectUrl.searchParams.get("port");
    const publicKey = connectUrl.searchParams.get("publicKey");
    const state = connectUrl.searchParams.get("connectState");
    assert.match(port ?? "", /^\d+$/);

    const post = (path, body) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: webUrl },
            body: JSON.stringify(body),
        });

    const preflight = await post("/preflight", { state, publicKey, relayer: webUrl });
    assert.equal(preflight.status, 200, "preflight should be accepted");

    const callback = await post("/callback", {
        state,
        accountId: `0x${"1".repeat(64)}`,
        walletAddress: `0x${"2".repeat(64)}`,
        packageId: `0x${"3".repeat(64)}`,
        label: "Test MCP",
    });
    assert.equal(callback.status, 200, "callback should be accepted");
}

function spawnSignedOut(base, credsDir) {
    return spawn(process.execPath, [BIN, "--relayer", base, "--web-url", base], {
        env: {
            ...process.env,
            // MEMWAL_CREDS_DIR rather than HOME alone: os.homedir() ignores
            // HOME on Windows, which once let this suite overwrite a real
            // credentials.json (see CHANGELOG #705).
            MEMWAL_CREDS_DIR: credsDir,
            HOME: credsDir,
            USERPROFILE: credsDir,
            MEMWAL_MCP_LOGIN_TIMEOUT_MS: "15000",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
}

test("the bridge keeps reading stdin after an in-session sign-in", async (t) => {
    const { server, base, closeSse } = await startAnsweringRelayer();
    const credsDir = mkdtempSync(join(tmpdir(), "memwal-handoff-stdin-"));
    const child = spawnSignedOut(base, credsDir);
    const { send, waitFor } = attachStdio(child);

    t.after(() => {
        child.kill("SIGKILL");
        closeSse();
        server.close();
        rmSync(credsDir, { recursive: true, force: true });
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await waitFor((m) => m.id === 1 && m.result);

    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memwal_login" } });
    const login = await waitFor((m) => m.id === 2 && m.result);
    await completeSignIn(login.result.content[0].text, base);

    // Served from `pendingLines` — this one worked even with stdin paused.
    send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "replayed" } },
    });
    await waitFor((m) => m.id === 3 && m.result);

    // Read from the live stream. This is the one that used to hang forever.
    send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memwal_recall", arguments: { query: "live" } },
    });
    const live = await waitFor((m) => m.id === 4 && m.result);
    assert.match(live.result.content[0].text, /UPSTREAM_RECALL_RESULT/);
});
