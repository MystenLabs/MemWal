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
import { mkdtempSync, rmSync } from "node:fs";
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
