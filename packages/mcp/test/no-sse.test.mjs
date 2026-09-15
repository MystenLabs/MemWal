/**
 * The stdio process must never open /api/mcp/sse.
 *
 * memwal_health is unsigned GET /health on the SDK — a mock relayer that
 * 500s SSE and serves /health is enough to prove the path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../dist/bin/memwal-mcp.js");

function makeCreds(relayerUrl) {
    return {
        delegatePrivateKey: "a".repeat(64),
        delegatePublicKeyHex: "b".repeat(64),
        delegateAddress: "0x" + "1".repeat(64),
        walletAddress: "0x" + "2".repeat(64),
        accountId: "0x" + "3".repeat(64),
        packageId: "0x" + "4".repeat(64),
        relayerUrl,
        label: "no-sse",
        createdAt: new Date(0).toISOString(),
        version: 1,
    };
}

function startMockRelayer() {
    const hits = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        hits.push(`${req.method} ${url.pathname}`);
        if (req.method === "GET" && url.pathname === "/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ status: "ok", version: "1.2.3", write_ready: true }));
            return;
        }
        if (url.pathname.startsWith("/api/mcp")) {
            res.writeHead(410, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "sse deprecated in this test" }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            resolve({
                server,
                base: `http://127.0.0.1:${port}`,
                hits,
            });
        });
    });
}

test("memwal_health uses GET /health and never opens /api/mcp/sse", async (t) => {
    const { server, base, hits } = await startMockRelayer();
    const credsDir = mkdtempSync(join(tmpdir(), "memwal-no-sse-"));
    writeFileSync(join(credsDir, "credentials.json"), JSON.stringify(makeCreds(base)), {
        mode: 0o600,
    });

    const child = spawn(process.execPath, [BIN, "--relayer", base], {
        env: { ...process.env, MEMWAL_CREDS_DIR: credsDir, HOME: credsDir, USERPROFILE: credsDir },
        stdio: ["pipe", "pipe", "pipe"],
    });

    const received = [];
    let buf = "";
    child.stdout.on("data", (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            try {
                received.push(JSON.parse(line));
            } catch {
                /* ignore */
            }
        }
    });
    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    const waitFor = (pred, ms = 8_000) => {
        const hit = received.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
            const started = Date.now();
            const tick = () => {
                const found = received.find(pred);
                if (found) return res(found);
                if (Date.now() - started > ms) return rej(new Error(`timed out; hits=${hits.join(",")}`));
                setTimeout(tick, 20);
            };
            tick();
        });
    };

    t.after(() => {
        child.kill("SIGKILL");
        server.close();
        rmSync(credsDir, { recursive: true, force: true });
    });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await waitFor((m) => m.id === 1 && m.result);

    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memwal_health", arguments: {} } });
    const health = await waitFor((m) => m.id === 2 && m.result);
    assert.equal(health.result.isError, false);
    assert.match(health.result.content[0].text, /status=ok/);
    assert.match(health.result.content[0].text, new RegExp(`relayer=${base}`));
    assert.ok(hits.includes("GET /health"));
    assert.equal(
        hits.filter((h) => h.includes("/api/mcp")).length,
        0,
        `stdio must not touch MCP SSE/messages; hits=${hits.join(",")}`,
    );
});
